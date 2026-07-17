#!/usr/bin/env node
// Copyright (c) 2025 Amrutha Kollu. All rights reserved.
// Licensed under the Functional Source License, Version 1.1 (FSL-1.1-MIT) — see LICENSE for details.

/**
 * fixel scan — token reconnaissance for a Figma component
 *
 * Fetches a Figma node, extracts every unique fill colour, compares them
 * against the project's token file, and prints a ready-to-paste patch for
 * any missing or primitive-only tokens.
 *
 * Usage:
 *   fixel scan --node FILEKEY:NODEID
 *   fixel scan --node FILEKEY:NODEID --group badge
 *   fixel scan --node FILEKEY:NODEID --group badge --write
 *
 * Flags:
 *   --node  <FILEKEY:NODEID>  Figma node to scan (required)
 *   --group <name>            Token group name for suggestions (default: "component")
 *   --write                   Also write suggestions to .fixel-scan.json
 *   --no-cache                Bypass the 24-hour Figma API cache
 *
 * Exit codes:
 *   0  scan complete (including when tokens are missing — missing tokens are not an error)
 *   1  fatal error (Figma API failure, config missing, token file not found)
 */

import * as fs   from 'node:fs';
import * as path from 'node:path';

import {
  FixelConfigError,
  loadConfig,
  loadEnvFile,
  parseNodeArg,
  resolveFigmaToken,
} from '../core/config';

import {
  FigmaApiError,
  fetchFigmaNode,
  findComponentRoot,
} from '../core/figma-client';

import {
  buildSuggestions,
  buildTokenIndex,
  classifyFills,
  extractFills,
  formatTokenPatch,
  readTokenFile,
  type TokenSuggestion,
} from '../core/tokens';

// ─── ANSI helpers ─────────────────────────────────────────────────────────────

const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  cyan:   '\x1b[36m',
};

// ─── CLI args ─────────────────────────────────────────────────────────────────

function normalizeNodeArg(nodeArg: string): string {
  const colonIndex = nodeArg.indexOf(':');
  if (colonIndex === -1) return nodeArg;
  const fileKey = nodeArg.substring(0, colonIndex);
  const nodeId  = nodeArg.substring(colonIndex + 1).replace(/-/g, ':');
  return `${fileKey}:${nodeId}`;
}

interface ScanArgs {
  nodeRaw:  string;
  group:    string;
  write:    boolean;
  noCache:  boolean;
}

function parseArgs(argv: string[]): ScanArgs {
  const flag = (f: string): string | null => {
    const i = argv.indexOf(f);
    return i !== -1 ? (argv[i + 1] ?? null) : null;
  };

  const nodeRaw = flag('--node');
  if (!nodeRaw) {
    console.error('\n  Usage: fixel scan --node FILEKEY:NODEID [--group <name>]\n');
    console.error('  Example: fixel scan --node AbCdEfGhIjKlMnOpQrStUv:397:23320 --group badge\n');
    process.exit(1);
  }

  return {
    nodeRaw: normalizeNodeArg(nodeRaw),
    group:   (flag('--group') ?? 'component').trim(),
    write:   argv.includes('--write'),
    noCache: argv.includes('--no-cache'),
  };
}

// ─── Token key formatter ──────────────────────────────────────────────────────

function formatTokenKey(key: string): string {
  const isValidIdentifier = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key);
  if (!isValidIdentifier) {
    return `'${key}'`;
  }
  return key;
}

function applyTokenKeyFormatting(patch: string): string {
  return patch.split('\n').map((line) =>
    line.replace(/^(\s*)([^\s:]+)(\s*:)/, (_, indent, key, colon) =>
      `${indent}${formatTokenKey(key)}${colon}`,
    ),
  ).join('\n');
}

// ─── Report printer ───────────────────────────────────────────────────────────

function printReport(
  suggestions:    TokenSuggestion[],
  group:          string,
  patch:          string,
): void {
  const reachable     = suggestions.filter((s) => s.status === 'reachable');
  const primitiveOnly = suggestions.filter((s) => s.status === 'primitiveOnly');
  const newTokens     = suggestions.filter((s) => s.status === 'new');

  // ── Summary line ──────────────────────────────────────────────────────────
  const total   = suggestions.length;
  const summary = [
    `${C.green}${reachable.length} reachable${C.reset}`,
    primitiveOnly.length
      ? `${C.yellow}${primitiveOnly.length} primitive-only${C.reset}`
      : null,
    `${C.yellow}${newTokens.length} new${C.reset}`,
  ].filter(Boolean).join('  ·  ');

  console.log(`\n  ${C.bold}${total} unique fill(s) found${C.reset}  ·  ${summary}\n`);

  // ── Reachable ─────────────────────────────────────────────────────────────
  if (reachable.length > 0) {
    console.log(`  ${C.dim}Already covered by existing tokens:${C.reset}`);
    for (const s of reachable) {
      const nodeList = s.usedIn.slice(0, 3).join(', ');
      console.log(`    ${C.green}✓${C.reset}  ${s.hex}  — ${nodeList}`);
    }
    console.log('');
  }

  // ── Primitive-only ────────────────────────────────────────────────────────
  if (primitiveOnly.length > 0) {
    console.log(
      `  ${C.yellow}⚠  These hex values exist in a private primitive ramp but have no` +
      ` semantic alias.${C.reset}`,
    );
    console.log(
      `  ${C.dim}Components cannot import primitives directly.  Add a semantic alias` +
      ` before running fixel generate.${C.reset}`,
    );
    for (const s of primitiveOnly) {
      const nodeList = s.usedIn.slice(0, 3).join(', ');
      console.log(`    ${C.yellow}!${C.reset}  ${s.hex}  — ${nodeList}  →  needs: ${s.suggestedName}`);
    }
    console.log('');
  }

  // ── New tokens ────────────────────────────────────────────────────────────
  if (newTokens.length > 0) {
    console.log(`  ${C.bold}New tokens needed before fixel generate:${C.reset}\n`);
    for (const s of newTokens) {
      const nodeList = s.usedIn.slice(0, 4).join(', ');
      console.log(
        `    ${C.yellow}⊕${C.reset}  ${C.cyan}${s.hex}${C.reset}  →  ${s.suggestedName}`,
      );
      console.log(`       Used in: ${nodeList}`);
    }
    console.log('');
  }

  // ── Patch ─────────────────────────────────────────────────────────────────
  if (patch) {
    console.log(`  ${C.bold}Suggested addition to your token file:${C.reset}\n`);
    for (const line of applyTokenKeyFormatting(patch).split('\n')) {
      console.log(`    ${line}`);
    }
    console.log('');
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args   = parseArgs(process.argv.slice(2));
  const parsed = parseNodeArg(args.nodeRaw);

  console.log(`\n${C.bold}  fixel scan${C.reset}`);
  console.log(`  Figma node:  ${args.nodeRaw}`);
  console.log(`  Token group: ${args.group}\n`);

  // ── Load config ────────────────────────────────────────────────────────────
  loadEnvFile();
  const config = loadConfig();

  const figmaToken = resolveFigmaToken(config);

  // ── Fetch Figma node ───────────────────────────────────────────────────────
  console.log('  Fetching Figma design data…');
  const rawNode = await fetchFigmaNode({
    accessToken: figmaToken,
    fileKey:     parsed.fileKey,
    nodeId:      parsed.nodeId,
    depth:       6,
    noCache:     args.noCache,
  });

  const node = findComponentRoot(rawNode);
  console.log(`  Node: ${node.name} (${node.type})\n`);

  // ── Extract fills ──────────────────────────────────────────────────────────
  const fills = extractFills(node as unknown as Record<string, unknown>);

  if (fills.size === 0) {
    console.log(`  ${C.yellow}No SOLID fills found in this node.${C.reset}`);
    console.log(`  The node may be an annotation frame rather than a component.\n`);
    process.exit(0);
  }

  // ── Compare against token file ─────────────────────────────────────────────
  const tokenSource = readTokenFile(config);
  const tokenIndex  = buildTokenIndex(tokenSource, config);
  const classified  = classifyFills(fills, tokenIndex);
  const suggestions = buildSuggestions(classified, fills, args.group, config);
  const patch       = formatTokenPatch(suggestions, args.group, config);

  // ── Print report ───────────────────────────────────────────────────────────
  printReport(suggestions, args.group, patch);

  // ── Next steps ─────────────────────────────────────────────────────────────
  const hasNew     = suggestions.some((s) => s.status === 'new');
  const hasPrimOnly = suggestions.some((s) => s.status === 'primitiveOnly');

  if (!hasNew && !hasPrimOnly) {
    console.log(`  ${C.green}${C.bold}All fills are covered by existing tokens.${C.reset}`);
    console.log(`  You can run fixel generate directly:\n`);
    console.log(`    ${C.cyan}fixel generate --name <Component> --node ${args.nodeRaw}${C.reset}\n`);
  } else {
    console.log(`  ${C.bold}Next steps:${C.reset}`);
    if (hasNew || hasPrimOnly) {
      console.log(`    1. Add the tokens above to ${config.tokens.file}`);
      console.log(`    2. Then run fixel generate:\n`);
    }
    console.log(`       ${C.cyan}fixel generate --name <Component> --node ${args.nodeRaw}${C.reset}\n`);
  }

  // ── Optional: write suggestions JSON ──────────────────────────────────────
  if (args.write) {
    const outPath = path.resolve(process.cwd(), '.fixel-scan.json');
    const payload = {
      scannedAt: new Date().toISOString(),
      figmaNode:  args.nodeRaw,
      group:      args.group,
      suggestions,
    };
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    console.log(`  ${C.green}✓${C.reset}  Suggestions written to .fixel-scan.json\n`);
  }
}

// ─── Entry ────────────────────────────────────────────────────────────────────

main().catch((err: unknown) => {
  if (err instanceof FixelConfigError) {
    console.error(`\n  ${C.yellow}Config error:${C.reset} ${err.message}\n`);
    process.exit(1);
  }
  if (err instanceof FigmaApiError) {
    console.error(`\n  ${C.red}Figma API error:${C.reset} ${err.message}\n`);
    if (err.statusCode === 403) {
      console.error(`  Check that FIGMA_ACCESS_TOKEN is set and has read access to this file.\n`);
    }
    process.exit(1);
  }
  console.error(`\n  ${C.red}Error:${C.reset} ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
