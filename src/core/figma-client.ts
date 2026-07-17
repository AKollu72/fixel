// Copyright (c) 2025 Amrutha Kollu. All rights reserved.
// Licensed under the Functional Source License, Version 1.1 (FSL-1.1-MIT) — see LICENSE for details.

import * as fs   from 'node:fs';
import * as path from 'node:path';

// ─── Figma API types ──────────────────────────────────────────────────────────

export interface FigmaColor {
  r: number;   // 0–1
  g: number;
  b: number;
  a: number;
}

export interface FigmaFill {
  type:     string;           // "SOLID" | "GRADIENT_LINEAR" | …
  color?:   FigmaColor;
  opacity?: number;           // fill-level opacity (separate from node opacity)
}

export interface FigmaStroke {
  type:   string;
  color?: FigmaColor;
}

export interface FigmaEffect {
  type:     string;           // "DROP_SHADOW" | "INNER_SHADOW" | "LAYER_BLUR" | …
  visible?: boolean;
  radius?:  number;
  color?:   FigmaColor;
  offset?:  { x: number; y: number };
  spread?:  number;
}

export interface FigmaTextStyle {
  fontSize?:        number;
  fontWeight?:      number;
  lineHeightPx?:    number;
  letterSpacing?:   number;
  textAlignHorizontal?: string;
}

export interface FigmaBoundingBox {
  x:      number;
  y:      number;
  width:  number;
  height: number;
}

/**
 * A single node returned from the Figma /nodes endpoint.
 * Only the fields fixel reads are typed here; the full Figma schema has
 * many more.  Unknown fields pass through as-is when the raw document object
 * is forwarded to the AI prompt.
 */
export interface FigmaNode {
  id:       string;
  name:     string;
  type:     string;   // "COMPONENT_SET" | "COMPONENT" | "FRAME" | "TEXT" | …

  // Layout
  absoluteBoundingBox?: FigmaBoundingBox;
  size?:                { width: number; height: number };
  paddingTop?:          number;
  paddingBottom?:       number;
  paddingLeft?:         number;
  paddingRight?:        number;
  itemSpacing?:         number;
  cornerRadius?:        number;

  // Visuals
  fills?:   FigmaFill[];
  strokes?: FigmaStroke[];
  effects?: FigmaEffect[];

  // Text
  style?:   FigmaTextStyle;

  // Variants
  componentPropertyDefinitions?: Record<string, unknown>;

  // Children
  children?: FigmaNode[];
}

/** Raw shape of a single node entry in the Figma /nodes API response. */
interface FigmaNodeEntry {
  document: FigmaNode;
}

/** Raw top-level shape of the Figma /nodes API response. */
interface FigmaNodesResponse {
  nodes: Record<string, FigmaNodeEntry>;
}

// ─── Cache ────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS  = 24 * 60 * 60 * 1000;  // 24 hours
const CACHE_DIR_REL = path.join('node_modules', '.cache', 'fixel');

// ─── Retry config ─────────────────────────────────────────────────────────────

const MAX_RETRIES              = 3;
const MAX_RETRIES_WITH_HEADER  = 2;
const INITIAL_RETRY_MS         = 1_000;   // 1 second — doubles each attempt: 1s, 2s, 4s

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function formatWaitTime(seconds: number): string {
  if (seconds < 60)    return `${Math.round(seconds)}s`;
  if (seconds < 3600)  return `${(seconds / 60).toFixed(0)} minutes`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} hours`;
  return `${(seconds / 86400).toFixed(1)} days`;
}

/**
 * Builds a filesystem-safe cache key from the request parameters.
 * The key is a flat filename: no subdirectories, no special characters.
 *
 * Format: figma-{fileKey}-{sanitisedNodeId}-d{depth}.json
 *   sanitisedNodeId replaces the colon in Figma node IDs ("397:23320" → "397-23320")
 *   so the filename is valid on Windows and macOS without quoting.
 */
function cacheKey(fileKey: string, nodeId: string, depth: number): string {
  const safeNode = nodeId.replace(/:/g, '-');
  return `figma-${fileKey}-${safeNode}-d${depth}.json`;
}

/** Absolute path to the cache directory, anchored to the caller's cwd. */
function cacheDir(): string {
  return path.resolve(process.cwd(), CACHE_DIR_REL);
}

interface CacheEntry {
  fetchedAt: number;          // Date.now() at write time
  data:      FigmaNode;
}

/**
 * Returns the cached FigmaNode for this (fileKey, nodeId, depth) triple if
 * one exists on disk and is younger than CACHE_TTL_MS.  Returns null otherwise.
 */
function readCache(fileKey: string, nodeId: string, depth: number): FigmaNode | null {
  const file = path.join(cacheDir(), cacheKey(fileKey, nodeId, depth));
  if (!fs.existsSync(file)) return null;

  try {
    const entry = JSON.parse(fs.readFileSync(file, 'utf8')) as CacheEntry;
    const ageMs = Date.now() - entry.fetchedAt;
    if (ageMs > CACHE_TTL_MS) return null;   // stale
    return entry.data;
  } catch {
    // Corrupt cache file — treat as a miss and let the live fetch overwrite it.
    return null;
  }
}

/**
 * Writes a FigmaNode to the cache directory.
 * Creates the directory if it does not exist.
 * Silently swallows write errors so a read-only filesystem never breaks the CLI.
 */
function writeCache(fileKey: string, nodeId: string, depth: number, data: FigmaNode): void {
  try {
    const dir  = cacheDir();
    fs.mkdirSync(dir, { recursive: true });
    const entry: CacheEntry = { fetchedAt: Date.now(), data };
    fs.writeFileSync(
      path.join(dir, cacheKey(fileKey, nodeId, depth)),
      JSON.stringify(entry),
      'utf8',
    );
  } catch {
    // Non-fatal — cache is a performance optimisation, not a correctness requirement.
  }
}

// ─── Error ────────────────────────────────────────────────────────────────────

export class FigmaApiError extends Error {
  constructor(
    message:           string,
    public statusCode?: number,
  ) {
    super(message);
    this.name = 'FigmaApiError';
  }
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

export interface FetchNodeOptions {
  /** Figma personal access token. */
  accessToken: string;
  /** Figma file key — the alphanumeric ID in the file URL. */
  fileKey:     string;
  /** Node ID in "fileKey:nodeId" or bare "nodeId" format (e.g. "397:23320"). */
  nodeId:      string;
  /**
   * Figma API tree depth.
   * 6 captures inner containers (levels 3–5) for most components.
   * Use 8 for deeply-nested components (complex forms, data tables).
   * @default 6
   */
  depth?:      number;
  /**
   * When true, bypass the on-disk cache and always fetch from the Figma API.
   * Useful when you know the design has just changed.
   * @default false
   */
  noCache?:    boolean;
}

/**
 * Fetches a single Figma node by ID, with a 24-hour on-disk cache.
 *
 * Cache location: node_modules/.cache/fixel/
 * Cache key:      figma-{fileKey}-{nodeId}-d{depth}.json
 * Cache TTL:      24 hours (configurable via CACHE_TTL_MS above)
 *
 * The cache prevents redundant Figma API calls when `fixel verify` runs on
 * every PR across a large design system.  In CI, the cache directory is
 * typically warm from a recent `fixel generate` run on the same commit.
 *
 * The raw FigmaNode returned here is the document root for the requested node.
 * Callers (scan, generate, verify) are responsible for scoping to the
 * COMPONENT_SET / COMPONENT descendant they actually need.
 *
 * @throws {FigmaApiError}  Non-2xx HTTP response from the Figma API.
 * @throws {FigmaApiError}  Node not found in the API response.
 */
export async function fetchFigmaNode(opts: FetchNodeOptions): Promise<FigmaNode> {
  const depth = opts.depth ?? 6;

  // ── Cache read ─────────────────────────────────────────────────────────────
  if (!opts.noCache) {
    const cached = readCache(opts.fileKey, opts.nodeId, depth);
    if (cached) return cached;
  }

  // ── Live fetch (with exponential backoff retry on HTTP 429) ──────────────
  //
  // Figma rate-limits the REST API per token.  In CI, `fixel verify` may
  // run for every component in parallel; without retry the first 429 fails
  // the entire run.  Three retries with doubling delays (1s → 2s → 4s) handle
  // transient bursts without blocking the pipeline for more than ~7 seconds.
  //
  // Only 429 is retried.  All other non-2xx responses are thrown immediately:
  // a 401 means the token is wrong, a 404 means the node doesn't exist —
  // waiting and retrying won't help.
  const url = buildUrl(opts.fileKey, opts.nodeId, depth);
  let res!: Response;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      res = await fetch(url, {
        headers: { 'X-Figma-Token': opts.accessToken },
      });
    } catch (err) {
      // Network-level error (DNS failure, connection refused, etc.).
      // Not retried — these are not transient rate-limit issues.
      throw new FigmaApiError(
        `Network error fetching Figma node "${opts.nodeId}": ${(err as Error).message}`,
      );
    }

    if (res.status !== 429) break;   // success or a non-rate-limit error — exit loop

    const retryAfterRaw     = res.headers.get('retry-after');
    const retryAfterSeconds = retryAfterRaw ? parseFloat(retryAfterRaw) : NaN;

    if (!isNaN(retryAfterSeconds) && retryAfterSeconds > 60) {
      throw new FigmaApiError(
        `Figma rate limit exceeded — retry after ${formatWaitTime(retryAfterSeconds)}.\n` +
        `  Rate limits follow the file's plan tier.\n` +
        `  Details: https://developers.figma.com/docs/rest-api/rate-limits`,
        429,
      );
    }

    const maxRetries = !isNaN(retryAfterSeconds) ? MAX_RETRIES_WITH_HEADER : MAX_RETRIES;
    if (attempt >= maxRetries) break;  // exhausted retries — fall through to error throw

    const delayMs = !isNaN(retryAfterSeconds)
      ? retryAfterSeconds * 1000
      : INITIAL_RETRY_MS * Math.pow(2, attempt);  // 1s, 2s, 4s
    console.warn(
      `  figma-client: rate limited (429) — retrying in ${delayMs / 1000}s ` +
      `(attempt ${attempt + 1}/${maxRetries})…`,
    );
    await sleep(delayMs);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '(no body)');
    const hint = res.status === 429
      ? `\n  Figma API rate limit exceeded after retries. Try again in a few minutes.`
      : '';
    throw new FigmaApiError(
      `Figma API returned ${res.status} for node "${opts.nodeId}".${hint}\n` +
      `  URL: ${url}\n` +
      `  Body: ${body.slice(0, 300)}`,
      res.status,
    );
  }

  let json: FigmaNodesResponse;
  try {
    json = await res.json() as FigmaNodesResponse;
  } catch {
    throw new FigmaApiError(
      `Figma API returned non-JSON for node "${opts.nodeId}".`,
    );
  }

  // ── Node lookup ────────────────────────────────────────────────────────────
  // The Figma API response key can use either ":" or "-" as the separator in
  // the node ID depending on how the ID was encoded in the request URL.
  const entry =
    json.nodes[opts.nodeId] ??
    json.nodes[opts.nodeId.replace(':', '-')];

  if (!entry?.document) {
    const available = Object.keys(json.nodes).join(', ') || '(empty)';
    throw new FigmaApiError(
      `Node "${opts.nodeId}" not found in Figma response.\n` +
      `  Available node keys: ${available}\n` +
      `  Check that the node ID is correct and belongs to file "${opts.fileKey}".`,
    );
  }

  const node = entry.document;

  // ── Cache write ────────────────────────────────────────────────────────────
  writeCache(opts.fileKey, opts.nodeId, depth, node);

  return node;
}

// ─── Component root scoping ───────────────────────────────────────────────────

/**
 * Scopes a raw Figma document node to its COMPONENT_SET or COMPONENT
 * descendant.
 *
 * When fetching a node by ID the Figma API sometimes returns a canvas
 * wrapper or page frame whose children include the real component alongside
 * documentation-only FRAME siblings ("Usage examples", "Spec annotations").
 * Walking the full wrapper produces false-positive typography, spacing, and
 * icon-size checks in `fixel verify`.
 *
 * This function returns the first COMPONENT_SET or COMPONENT found at depth
 * ≤ 2, falling back to the original node when it is itself already a
 * component.
 */
export function findComponentRoot(node: FigmaNode): FigmaNode {
  // The node itself is the component — use it directly.
  if (node.type === 'COMPONENT_SET' || node.type === 'COMPONENT') return node;

  // One level deep: direct children of the canvas / wrapper frame.
  const direct = node.children?.find(
    (c) => c.type === 'COMPONENT_SET' || c.type === 'COMPONENT',
  );
  if (direct) return direct;

  // Two levels deep: component nested inside a wrapper frame.
  for (const child of node.children ?? []) {
    const nested = child.children?.find(
      (c) => c.type === 'COMPONENT_SET' || c.type === 'COMPONENT',
    );
    if (nested) return nested;
  }

  // Fallback: return the full node and let the caller handle it.
  return node;
}

// ─── Colour utilities (shared by scan + generate) ────────────────────────────

/**
 * Converts a FigmaColor (0–1 float channels) to an uppercase hex string.
 * Appends a two-digit alpha suffix only when the colour is not fully opaque,
 * so "#FF0000" stays clean while "#FF000080" signals 50% opacity.
 *
 * The optional `fillOpacity` parameter handles Figma's two-level opacity
 * model: a fill can have its own `opacity` field separate from the RGBA
 * alpha channel on the colour itself.  The effective alpha is their product.
 */
export function figmaColorToHex(color: FigmaColor, fillOpacity = 1): string {
  const effectiveA = Math.round(color.a * fillOpacity * 255);
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  const hex = [r, g, b]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
  const alphaHex = effectiveA < 255
    ? effectiveA.toString(16).padStart(2, '0')
    : '';
  return `#${hex}${alphaHex}`.toUpperCase();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildUrl(fileKey: string, nodeId: string, depth: number): string {
  return (
    `https://api.figma.com/v1/files/${fileKey}/nodes` +
    `?ids=${encodeURIComponent(nodeId)}&depth=${depth}`
  );
}

// ─── File-level style resolution ─────────────────────────────────────────────

export interface FigmaStyleMeta {
  key:       string;   // published style key (globally unique)
  name:      string;   // human-readable name, e.g. "Brand/Primary"
  styleType: 'FILL' | 'TEXT' | 'EFFECT' | 'GRID';
}

export interface ResolvedFillStyle {
  name:      string;
  styleType: 'FILL';
  hex:       string;   // e.g. "#2563EB"
}

export interface ResolvedTextStyle {
  name:         string;
  styleType:    'TEXT';
  fontSize:     number;
  fontWeight:   number;
  lineHeightPx: number;
}

export type ResolvedStyle = ResolvedFillStyle | ResolvedTextStyle;

export interface FetchFileStylesResult {
  fileName:       string;
  stylesMeta:     Record<string, FigmaStyleMeta>;
  resolvedStyles: Record<string, ResolvedStyle>;
  /** Style IDs for which no node carrying the style value was found at the fetched depth. */
  skippedIds:     string[];
}

// ── File-styles cache ─────────────────────────────────────────────────────────

interface StylesCacheEntry {
  fetchedAt: number;
  data:      FetchFileStylesResult;
}

function stylesCacheKey(fileKey: string): string {
  return `figma-styles-${fileKey}.json`;
}

function readStylesCache(fileKey: string): FetchFileStylesResult | null {
  const file = path.join(cacheDir(), stylesCacheKey(fileKey));
  if (!fs.existsSync(file)) return null;
  try {
    const entry = JSON.parse(fs.readFileSync(file, 'utf8')) as StylesCacheEntry;
    if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) return null;
    return entry.data;
  } catch {
    return null;
  }
}

function writeStylesCache(fileKey: string, data: FetchFileStylesResult): void {
  try {
    const dir = cacheDir();
    fs.mkdirSync(dir, { recursive: true });
    const entry: StylesCacheEntry = { fetchedAt: Date.now(), data };
    fs.writeFileSync(path.join(dir, stylesCacheKey(fileKey)), JSON.stringify(entry), 'utf8');
  } catch {
    // non-fatal — cache is a performance optimisation
  }
}

// ── Tree walker ───────────────────────────────────────────────────────────────

/**
 * Recursively walks a raw Figma document tree and resolves style values.
 *
 * When a node carries a `styles` reference to a FILL or TEXT style ID in
 * `remaining`, extracts the actual fill color (for FILL) or text properties
 * (for TEXT) from that node.  Removes resolved IDs from `remaining` and stops
 * recursing once all styles are accounted for.
 */
function walkForStyleValues(
  node:       Record<string, unknown>,
  stylesMeta: Record<string, FigmaStyleMeta>,
  resolved:   Record<string, ResolvedStyle>,
  remaining:  Set<string>,
): void {
  if (remaining.size === 0) return;

  const nodeStyles = node['styles'] as Record<string, string> | undefined;
  if (nodeStyles) {
    // FILL style — Figma maps either "fill" or "fills" as the property key
    const fillId = nodeStyles['fill'] ?? nodeStyles['fills'];
    if (fillId && remaining.has(fillId) && stylesMeta[fillId]?.styleType === 'FILL') {
      const fills = node['fills'] as Array<{ type: string; color?: FigmaColor; opacity?: number }> | undefined;
      const solid = fills?.find((f) => f.type === 'SOLID' && f.color);
      if (solid?.color) {
        resolved[fillId] = {
          name:      stylesMeta[fillId].name,
          styleType: 'FILL',
          hex:       figmaColorToHex(solid.color, solid.opacity ?? 1),
        };
        remaining.delete(fillId);
      }
    }

    // TEXT style
    const textId = nodeStyles['text'];
    if (textId && remaining.has(textId) && stylesMeta[textId]?.styleType === 'TEXT') {
      const style = node['style'] as FigmaTextStyle | undefined;
      if (style?.fontSize != null && style?.fontWeight != null) {
        resolved[textId] = {
          name:         stylesMeta[textId].name,
          styleType:    'TEXT',
          fontSize:     style.fontSize,
          fontWeight:   style.fontWeight,
          lineHeightPx: style.lineHeightPx != null
            ? Math.round(style.lineHeightPx)
            : Math.round(style.fontSize * 1.2),
        };
        remaining.delete(textId);
      }
    }
  }

  const children = node['children'] as Array<Record<string, unknown>> | undefined;
  if (children) {
    for (const child of children) {
      walkForStyleValues(child, stylesMeta, resolved, remaining);
      if (remaining.size === 0) return;
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface FetchFileStylesOptions {
  accessToken: string;
  fileKey:     string;
  noCache?:    boolean;
  onProgress?: (msg: string) => void;
}

/**
 * Fetches a Figma file's published FILL and TEXT styles, resolves each
 * style's actual values by walking the document tree at depth=4, and returns
 * the results.
 *
 * Results are cached in node_modules/.cache/fixel/ with a 24-hour TTL.
 * Only the processed result (not the raw file response) is cached, so the
 * cache file stays small even for large design system files.
 *
 * @throws {FigmaApiError} on HTTP errors or network failures.
 */
export async function fetchFileStyles(
  opts: FetchFileStylesOptions,
): Promise<FetchFileStylesResult> {
  if (!opts.noCache) {
    const cached = readStylesCache(opts.fileKey);
    if (cached) {
      opts.onProgress?.('  (loaded from cache)');
      return cached;
    }
  }

  opts.onProgress?.('  Fetching design file… (this may take a moment for large files)');

  let res: Response;
  try {
    res = await fetch(
      `https://api.figma.com/v1/files/${opts.fileKey}?depth=4`,
      { headers: { 'X-Figma-Token': opts.accessToken } },
    );
  } catch (err) {
    throw new FigmaApiError(
      `Network error fetching Figma file "${opts.fileKey}": ${(err as Error).message}`,
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '(no body)');
    const hint = res.status === 403
      ? `\n  Check that FIGMA_ACCESS_TOKEN has "Read file contents" scope.`
      : '';
    throw new FigmaApiError(
      `Figma API returned ${res.status} for file "${opts.fileKey}".${hint}\n  Body: ${body.slice(0, 300)}`,
      res.status,
    );
  }

  opts.onProgress?.('  Parsing response…');

  let raw: { name: string; styles?: Record<string, FigmaStyleMeta>; document: Record<string, unknown> };
  try {
    raw = await res.json() as typeof raw;
  } catch {
    throw new FigmaApiError(`Figma API returned non-JSON for file "${opts.fileKey}".`);
  }

  const stylesMeta = raw.styles ?? {};

  const remaining = new Set(
    Object.entries(stylesMeta)
      .filter(([, m]) => m.styleType === 'FILL' || m.styleType === 'TEXT')
      .map(([id]) => id),
  );

  const fillCount = [...remaining].filter((id) => stylesMeta[id].styleType === 'FILL').length;
  const textCount = [...remaining].filter((id) => stylesMeta[id].styleType === 'TEXT').length;
  opts.onProgress?.(`  Found ${fillCount} FILL styles, ${textCount} TEXT styles — resolving values…`);

  const resolved: Record<string, ResolvedStyle> = {};
  walkForStyleValues(raw.document, stylesMeta, resolved, remaining);

  const result: FetchFileStylesResult = {
    fileName:       raw.name,
    stylesMeta,
    resolvedStyles: resolved,
    skippedIds:     [...remaining],
  };

  writeStylesCache(opts.fileKey, result);
  return result;
}
