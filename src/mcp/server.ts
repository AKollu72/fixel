#!/usr/bin/env node
// Copyright (c) 2025 Amrutha Kollu. All rights reserved.
// Licensed under the Functional Source License, Version 1.1 (FSL-1.1-MIT) — see LICENSE for details.

/**
 * fixel MCP server — exposes fixel commands as Model Context Protocol tools.
 *
 * Tools provided:
 *   fixel_scan      Audit local React files for prohibited design patterns.
 *                   No Figma call — works offline against the project's token file.
 *   fixel_verify    Drift detection: checks component source against Figma spec.
 *   fixel_annotate  Post drift findings as anchored comments on the Figma canvas.
 *
 * Transport: stdio (suitable for Claude Desktop and most MCP hosts).
 *
 * Usage (add to Claude Desktop config):
 *   {
 *     "mcpServers": {
 *       "fixel": {
 *         "command": "fixel-mcp",
 *         "env": {
 *           "FIGMA_ACCESS_TOKEN": "...",
 *           "ANTHROPIC_API_KEY":  "..."
 *         }
 *       }
 *     }
 *   }
 */

/* eslint-disable @typescript-eslint/no-require-imports */

import { spawnSync } from 'node:child_process';
import * as path    from 'node:path';

// Use require() for MCP SDK to stay compatible with our CommonJS build target.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Server } = require('@modelcontextprotocol/sdk/server/index.js') as {
  Server: new (
    info: { name: string; version: string },
    opts: { capabilities: { tools: Record<string, unknown> } },
  ) => {
    setRequestHandler: (schema: unknown, handler: (req: { params: { name?: string; arguments?: unknown } }) => Promise<unknown>) => void;
    connect: (transport: unknown) => Promise<void>;
  };
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js') as {
  StdioServerTransport: new () => unknown;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js') as {
  CallToolRequestSchema: unknown;
  ListToolsRequestSchema: unknown;
};

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'fixel_scan',
    description:
      'Audit a local directory of React components for prohibited design patterns ' +
      '(raw hex literals, raw rgba(), bare numeric border-radius in MUI sx). ' +
      'Reads token configuration from fixel.config.json in the working directory. ' +
      'No Figma API call — runs fully offline.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path to scan, relative to the project root (e.g. "./src" or "src/components").',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'fixel_verify',
    description:
      'Drift detection — reads each component\'s .fixel.json spec (written by fixel generate) ' +
      'and checks whether the current source still matches the Figma values recorded at generation time. ' +
      'Runs offline by default. Exits 1 on drift, 2 when no spec files exist.',
    inputSchema: {
      type: 'object',
      properties: {
        component: {
          type: 'string',
          description: 'Component name to check (e.g. "Badge"). Omit to check all components with spec files.',
        },
        node: {
          type: 'string',
          description: 'FILEKEY:NODEID — re-fetch live Figma data instead of using the stored spec. Requires FIGMA_ACCESS_TOKEN.',
        },
      },
    },
  },
  {
    name: 'fixel_annotate',
    description:
      'Post drift findings as a comment anchored to the component\'s Figma frame. ' +
      'Checks for an existing open [Fixel] comment before posting; skips if one exists. ' +
      'Requires FIGMA_ACCESS_TOKEN.',
    inputSchema: {
      type: 'object',
      properties: {
        component: {
          type: 'string',
          description: 'Component name (e.g. "Badge").',
        },
        node: {
          type: 'string',
          description: 'FILEKEY:NODEID of the Figma frame to annotate.',
        },
        dryRun: {
          type: 'boolean',
          description: 'Print what would be posted without actually posting. Default false.',
        },
      },
      required: ['component', 'node'],
    },
  },
];

// ─── Child-process runner ─────────────────────────────────────────────────────

/**
 * Resolves the fixel-bin.js entry point relative to this compiled file.
 * Compiled path: dist/mcp/server.js → ../../fixel-bin.js
 */
function fixelBinPath(): string {
  return path.resolve(__dirname, '..', '..', 'fixel-bin.js');
}

interface RunResult {
  output:  string;
  isError: boolean;
}

/** Default spawnSync timeout — covers slow Figma API calls on poor connections. */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Resolves the effective timeout from the FIXEL_MCP_TIMEOUT_MS env var.
 * Falls back to DEFAULT_TIMEOUT_MS when the var is absent or not a positive integer.
 */
function resolveTimeout(): number {
  const raw = process.env['FIXEL_MCP_TIMEOUT_MS'];
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

function runFixel(fixelArgs: string[]): RunResult {
  const timeoutMs = resolveTimeout();

  const result = spawnSync(process.execPath, [fixelBinPath(), ...fixelArgs], {
    encoding:  'utf8',
    env:       { ...process.env },
    cwd:       process.cwd(),
    maxBuffer: 10 * 1024 * 1024, // 10 MB
    timeout:   timeoutMs,
  });

  // spawnSync sets result.error when the child could not be started or timed out.
  // ETIMEDOUT is the code for a timeout; other errors indicate a launch failure.
  if (result.error) {
    const code      = (result.error as NodeJS.ErrnoException).code;
    const isTimeout = code === 'ETIMEDOUT';
    const msg = isTimeout
      ? `[fixel-mcp] Command timed out after ${timeoutMs}ms.\n` +
        `  Set FIXEL_MCP_TIMEOUT_MS env var to increase the limit.\n` +
        `  Args: fixel ${fixelArgs.join(' ')}`
      : `[fixel-mcp] Failed to start fixel: ${result.error.message}`;
    return { output: msg, isError: true };
  }

  const output = [result.stdout, result.stderr].filter(Boolean).join('').trim();
  return {
    output:  output || '(no output)',
    isError: (result.status ?? 0) !== 0,
  };
}

// ─── Request handlers ─────────────────────────────────────────────────────────

type ToolArgs = Record<string, unknown>;

function handleScan(args: ToolArgs): RunResult {
  const scanPath = typeof args['path'] === 'string' ? args['path'] : '.';
  return runFixel(['scan', scanPath]);
}

function handleVerify(args: ToolArgs): RunResult {
  const fixelArgs = ['verify'];
  if (typeof args['component'] === 'string') {
    fixelArgs.push('--component', args['component']);
  }
  if (typeof args['node'] === 'string') {
    fixelArgs.push('--node', args['node']);
  }
  return runFixel(fixelArgs);
}

function handleAnnotate(args: ToolArgs): RunResult {
  const component = typeof args['component'] === 'string' ? args['component'] : '';
  const node      = typeof args['node']      === 'string' ? args['node']      : '';
  const fixelArgs = ['annotate', '--component', component, '--node', node];
  if (args['dryRun'] === true) fixelArgs.push('--dry-run');
  return runFixel(fixelArgs);
}

// ─── Server setup ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pkg = require('../../package.json') as { version: string };

  const server = new Server(
    { name: 'fixel', version: pkg.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request: { params: { name?: string; arguments?: unknown } }) => {
    const { name, arguments: rawArgs } = request.params;
    const args = (typeof rawArgs === 'object' && rawArgs !== null ? rawArgs : {}) as ToolArgs;

    let result: RunResult;

    switch (name) {
      case 'fixel_scan':
        result = handleScan(args);
        break;
      case 'fixel_verify':
        result = handleVerify(args);
        break;
      case 'fixel_annotate':
        result = handleAnnotate(args);
        break;
      default:
        throw new Error(`Unknown tool: ${String(name)}`);
    }

    return {
      content: [{ type: 'text', text: result.output }],
      isError: result.isError,
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  console.error('[fixel-mcp]', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
