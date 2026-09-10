// Copyright (c) 2025 Amrutha Kollu. All rights reserved.
// Licensed under the Functional Source License, Version 1.1 (FSL-1.1-MIT) — see LICENSE for details.

/**
 * Minimal Figma write client — comment posting and listing for fixel annotate.
 *
 * No caching: all operations are one-shot writes or pre-post reads.
 * Retry policy: one retry on HTTP 429. If Retry-After header is present and
 *   ≤60s: wait that long. If >60s: throw immediately with human-readable wait.
 *   If no header: wait 2 seconds (legacy default).
 *
 * Required Figma token scope: "Create, modify, and delete comments in
 * accessible files" (Comments → Write on the PAT creation screen).
 */

// ─── Sleep helper ─────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function formatWaitTime(seconds: number): string {
  if (seconds < 60)    return `${Math.round(seconds)}s`;
  if (seconds < 3600)  return `${(seconds / 60).toFixed(0)} minutes`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} hours`;
  return `${(seconds / 86400).toFixed(1)} days`;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PostCommentOptions {
  /** Figma file key — the alphanumeric ID in the file URL. */
  fileKey:     string;
  /** Text body of the comment. */
  message:     string;
  /**
   * When provided, the comment is anchored to this node in the canvas
   * via client_meta (node_id + node_offset {x:0, y:0}).
   * When absent the comment is posted at the file level.
   */
  nodeId?:     string;
  /** Figma personal access token with comments write scope. */
  accessToken: string;
}

export interface PostCommentResult {
  commentId: string;
}

/**
 * A single comment as returned by the Figma comments list endpoint.
 * Only the fields fixel reads are typed; the full schema has more.
 */
export interface FigmaComment {
  id:           string;
  message:      string;
  /**
   * UTC ISO 8601 timestamp when the comment was resolved.
   * null or absent means the comment is still open.
   * A truthy string means it has been resolved — a new annotation may be posted.
   */
  resolved_at?: string | null;
  /** Present only on node-anchored comments, null on file-level ones. */
  client_meta?: { node_id?: string; node_offset?: { x: number; y: number } } | null;
}

// ─── Error ────────────────────────────────────────────────────────────────────

export class FigmaWriteError extends Error {
  constructor(
    message:            string,
    public statusCode?: number,
  ) {
    super(message);
    this.name = 'FigmaWriteError';
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function authHeaders(accessToken: string): Record<string, string> {
  return {
    'X-Figma-Token': accessToken,
    'Content-Type':  'application/json',
  };
}

function throw403(action: string): never {
  throw new FigmaWriteError(
    `Figma returned 403 when trying to ${action}.\n` +
    `  Your personal access token needs the Comments scope (read + write).\n` +
    `  Go to figma.com → Account Settings → Personal Access Tokens,\n` +
    `  edit your token, and enable the "Comments" scope.\n` +
    `  Note: editing a PAT sometimes issues a new token value — update .env.local if so.`,
    403,
  );
}

// ─── Post comment ─────────────────────────────────────────────────────────────

/**
 * Posts a comment to a Figma file, optionally anchored to a specific node.
 *
 * When nodeId is provided the comment is pinned to the centre of that node
 * via client_meta.  This places the annotation visually on the component in
 * the Figma canvas rather than floating at file level.
 *
 * @throws {FigmaWriteError} on 403 (scope missing), other non-2xx, network error.
 */
export async function postComment(opts: PostCommentOptions): Promise<PostCommentResult> {
  const url = `https://api.figma.com/v1/files/${opts.fileKey}/comments`;

  const payload: Record<string, unknown> = { message: opts.message };
  if (opts.nodeId) {
    payload.client_meta = {
      node_id:     opts.nodeId,
      node_offset: { x: 0, y: 0 },
    };
  }

  let res!: Response;

  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      res = await fetch(url, {
        method:  'POST',
        // 'connection: close' prevents undici from pooling this socket.
        // Without it, the keep-alive handle triggers a libuv assertion on
        // Windows when process.exit() fires before the pool drains.
        headers: { ...authHeaders(opts.accessToken), connection: 'close' },
        body:    JSON.stringify(payload),
      });
    } catch (err) {
      throw new FigmaWriteError(
        `Network error posting comment to file "${opts.fileKey}": ${(err as Error).message}`,
      );
    }

    if (res.status === 429 && attempt === 0) {
      const retryAfterRaw     = res.headers.get('retry-after');
      const retryAfterSeconds = retryAfterRaw ? parseFloat(retryAfterRaw) : NaN;
      if (!isNaN(retryAfterSeconds) && retryAfterSeconds > 60) {
        throw new FigmaWriteError(
          `Figma rate limit exceeded — retry after ${formatWaitTime(retryAfterSeconds)}.\n` +
          `  Rate limits follow the file's plan tier.\n` +
          `  Details: https://developers.figma.com/docs/rest-api/rate-limits`,
          429,
        );
      }
      await sleep(!isNaN(retryAfterSeconds) ? retryAfterSeconds * 1000 : 2_000);
      continue;
    }
    break;
  }

  if (res.status === 403) throw403('post a comment');

  if (!res.ok) {
    const text = await res.text().catch(() => '(no body)');
    throw new FigmaWriteError(
      `Figma API returned ${res.status} when posting a comment.\n` +
      `  File: ${opts.fileKey}\n` +
      `  Body: ${text.slice(0, 300)}`,
      res.status,
    );
  }

  let json: { id: string };
  try {
    json = await res.json() as { id: string };
  } catch {
    throw new FigmaWriteError('Figma API returned non-JSON when posting a comment.');
  }

  return { commentId: json.id };
}

// ─── List comments ────────────────────────────────────────────────────────────

/**
 * Fetches all comments on a Figma file.
 *
 * Used by fixel annotate before posting to detect an existing [Fixel] comment
 * on the same node — prevents duplicate annotations when annotate is run
 * multiple times without resolving the previous comment.
 *
 * @throws {FigmaWriteError} on 403 (scope missing), other non-2xx, network error.
 */
export async function listComments(fileKey: string, accessToken: string): Promise<FigmaComment[]> {
  const url = `https://api.figma.com/v1/files/${fileKey}/comments`;
  let res!: Response;

  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      res = await fetch(url, {
        // 'connection: close' — see postComment for the Windows rationale.
        headers: { 'X-Figma-Token': accessToken, connection: 'close' },
      });
    } catch (err) {
      throw new FigmaWriteError(
        `Network error fetching comments for file "${fileKey}": ${(err as Error).message}`,
      );
    }

    if (res.status === 429 && attempt === 0) {
      const retryAfterRaw     = res.headers.get('retry-after');
      const retryAfterSeconds = retryAfterRaw ? parseFloat(retryAfterRaw) : NaN;
      if (!isNaN(retryAfterSeconds) && retryAfterSeconds > 60) {
        throw new FigmaWriteError(
          `Figma rate limit exceeded — retry after ${formatWaitTime(retryAfterSeconds)}.\n` +
          `  Rate limits follow the file's plan tier.\n` +
          `  Details: https://developers.figma.com/docs/rest-api/rate-limits`,
          429,
        );
      }
      await sleep(!isNaN(retryAfterSeconds) ? retryAfterSeconds * 1000 : 2_000);
      continue;
    }
    break;
  }

  if (res.status === 403) throw403('list comments');

  if (!res.ok) {
    const text = await res.text().catch(() => '(no body)');
    throw new FigmaWriteError(
      `Figma API returned ${res.status} when listing comments.\n` +
      `  File: ${fileKey}\n` +
      `  Body: ${text.slice(0, 300)}`,
      res.status,
    );
  }

  let json: { comments: FigmaComment[] };
  try {
    json = await res.json() as { comments: FigmaComment[] };
  } catch {
    throw new FigmaWriteError('Figma API returned non-JSON when listing comments.');
  }

  return json.comments ?? [];
}
