#!/usr/bin/env node
// Copyright (c) 2025 Amrutha Kollu. All rights reserved.
// Licensed under the MIT License — see LICENSE for details.

/**
 * fixel scan — two modes
 *
 * LOCAL MODE (no Figma call):
 *   fixel scan <path>
 *
 *   Loads the project's token file from fixel.config.json, walks all .tsx
 *   and .jsx files under <path>, and runs the prohibited-pattern audit on each.
 *   Reports raw-hex, raw-rgba, bare-border-radius, and framework-specific
 *   patterns.  Exits 1 when any error-severity violation is found.
 *
 *   If no token file is configured, exits 1 with a pointer to "fixel import".
 *
 * FIGMA MODE (token gap analysis):
 *   fixel scan --node FILEKEY:NODEID [--group <name>] [--write] [--no-cache]
 *
 *   Fetches a Figma node, extracts every unique fill colour, compares them
 *   against the project's token file, and prints a ready-to-paste patch for
 *   any missing or primitive-only tokens.  Always exits 0.
 *
 * Exit codes:
 *   0  scan complete (local: no violations; figma: always 0)
 *   1  violations found (local) | fatal error (either mode)
 */

import * as fs   from 'node:fs';
import * as path from 'node:path';

import {
  FixelConfigError,
  loadConfig,
  loadEnvFile,
  parseNodeArg,
  resolveFigmaToken,
  type ResolvedConfig,
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

import {
  auditCode,
  type AuditViolation,
} from '../core/audit';

import { stdoutC } from '../core/color';

// ─── ANSI helpers (gated on stdout TTY / NO_COLOR) ───────────────────────────

const C = stdoutC();

// ─── Help ─────────────────────────────────────────────────────────────────────

function printScanHelp(): void {
  console.log(`
  fixel scan — audit local React files or analyse a Figma node

  Usage:
    fixel scan <path>                         Audit .ts/.tsx/.js/.jsx files for prohibited patterns
    fixel scan --node FILEKEY:NODEID          Token gap analysis for a Figma node

  Options:
    --node <FILEKEY:NODEID>   Figma file key + node ID (Figma mode)
    --group <name>            Token group name (Figma mode, default: component)
    --write                   Write suggestions to .fixel-scan.json (Figma mode)
    --no-cache                Bypass the 24-hour Figma API cache (Figma mode)
    --help, -h                Show this help

  Examples:
    fixel scan ./src
    fixel scan ./src/components/Button.tsx
    fixel scan --node AbCdEfGhIjKlMnOpQrStUv:397:23320 --group badge
`);
}

// ─── CLI args ─────────────────────────────────────────────────────────────────

function normalizeNodeArg(nodeArg: string): string {
  const colonIndex = nodeArg.indexOf(':');
  if (colonIndex === -1) return nodeArg;
  const fileKey = nodeArg.substring(0, colonIndex);
  const nodeId  = nodeArg.substring(colonIndex + 1).replace(/-/g, ':');
  return `${fileKey}:${nodeId}`;
}

type ScanMode = 'local' | 'figma';

interface ScanArgs {
  mode:      ScanMode;
  localPath: string | null;   // set in local mode
  nodeRaw:   string | null;   // set in figma mode
  group:     string;
  write:     boolean;
  noCache:   boolean;
}

function parseArgs(argv: string[]): ScanArgs {
  const flag = (f: string): string | null => {
    const i = argv.indexOf(f);
    return i !== -1 ? (argv[i + 1] ?? null) : null;
  };

  const nodeRaw = flag('--node');

  // A positional argument is any arg that:
  //   (a) does not start with '--'
  //   (b) is not the value immediately after a known flag
  const flagValuePositions = new Set<number>();
  ['--node', '--group'].forEach((f) => {
    const i = argv.indexOf(f);
    if (i !== -1) flagValuePositions.add(i + 1);
  });
  const positional = argv.find(
    (a, i) => !a.startsWith('--') && !flagValuePositions.has(i),
  ) ?? null;

  // Local mode: positional path arg, no --node
  if (positional && !nodeRaw) {
    return {
      mode:      'local',
      localPath: positional,
      nodeRaw:   null,
      group:     'component',
      write:     false,
      noCache:   false,
    };
  }

  // Figma mode: --node required
  if (!nodeRaw) {
    console.error(`
  Usage:

    fixel scan <path>                         Audit local React files (no Figma call)
    fixel scan --node FILEKEY:NODEID          Token gap analysis for a Figma node

  Examples:
    fixel scan ./src
    fixel scan --node AbCdEfGhIjKlMnOpQrStUv:397:23320 --group badge
`);
    process.exit(1);
  }

  return {
    mode:      'figma',
    localPath: null,
    nodeRaw:   normalizeNodeArg(nodeRaw),
    group:     (flag('--group') ?? 'component').trim(),
    write:     argv.includes('--write'),
    noCache:   argv.includes('--no-cache'),
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

// ─── Local scan helpers ───────────────────────────────────────────────────────

/**
 * Paths the scanner must never audit, pre-resolved to absolute paths.
 * Today this is exactly the configured token file — the one file where raw
 * hex values are supposed to live.  Deliberately NOT the whole directory:
 * layouts like src/components/tokens.ts put real components beside the token
 * file, and those must still be scanned.
 */
export interface ScanExclusions {
  files: Set<string>;
}

/**
 * Recursively collect React/TypeScript source files, skipping noise dirs
 * and non-source files.
 *
 * Collected extensions: .tsx, .ts, .jsx, .js
 * Excluded:
 *   *.test.*  / *.spec.*  — test files
 *   *.d.ts                — TypeScript declaration files
 *   *.config.ts / *.config.js — config files (tailwind.config.ts etc.)
 *   the token file itself (when `exclude` is passed) — siblings are scanned
 */
export function collectReactFiles(dir: string, exclude?: ScanExclusions): string[] {
  const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results; // unreadable directory — skip silently
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      results.push(...collectReactFiles(full, exclude));
    } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
      // The token file is design-value ground truth — hex literals are
      // REQUIRED there, so it is never scanned.
      if (exclude?.files.has(path.resolve(full))) continue;
      if (
        /\.test\./.test(entry.name)           ||   // *.test.ts, *.test.tsx, etc.
        /\.spec\./.test(entry.name)           ||   // *.spec.*
        /\.d\.ts$/.test(entry.name)           ||   // *.d.ts declaration files
        /\.config\.(ts|js)$/.test(entry.name)      // tailwind.config.ts etc.
      ) continue;
      results.push(path.join(dir, entry.name));
    }
  }
  return results;
}

// ─── Fallback config (no fixel.config.json) ──────────────────────────────────

/**
 * Auto-detects the UI framework from package.json dependencies.
 * Falls back to 'tailwind' when package.json is absent or unreadable.
 */
function detectFramework(): string {
  try {
    const pkgPath = path.join(process.cwd(), 'package.json');
    if (!fs.existsSync(pkgPath)) return 'tailwind';
    const pkg  = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
    const deps = {
      ...(pkg['dependencies']    as Record<string, unknown> | undefined ?? {}),
      ...(pkg['devDependencies'] as Record<string, unknown> | undefined ?? {}),
    };
    if ('@mui/material' in deps || '@material-ui/core' in deps) return 'mui';
    if ('tailwindcss' in deps) return 'tailwind';
  } catch { /* best-effort */ }
  return 'tailwind';
}

/**
 * Builds a minimal ResolvedConfig adequate for auditCode().
 * Only `framework` and `prohibitedPatterns` are used by the local scan engine.
 */
function buildFallbackConfig(framework: string): ResolvedConfig {
  const patterns: string[] =
    framework === 'mui'
      ? ['raw-hex', 'raw-rgba', 'bare-border-radius']
      : ['raw-hex', 'raw-rgba', 'tailwind-raw-hex-arbitrary', 'tailwind-raw-rgb-arbitrary'];
  return {
    figma:     { accessToken: '' },
    framework,
    storybook: { framework: 'nextjs-vite', adapterPackage: '@storybook/nextjs-vite' },
    tokens: {
      file: '', format: 'typescript-object', importPath: '',
      semanticExport: 'semantic', constantsExport: 'constants',
      namingConvention: 'semantic.{group}.{role}',
    },
    typography: { importPath: '', scale: {}, tailwindClass: 'typography-{token}' },
    output:     { componentDir: './src/components', testSubdir: '__tests__' },
    testing:    { framework: 'jest', renderLibrary: '@testing-library/react' },
    ai:         { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    prohibitedPatterns: patterns,
  } as ResolvedConfig;
}

/** Run the prohibited-pattern audit on all React files under localPath. */
async function runLocalScan(localPath: string): Promise<void> {
  loadEnvFile();

  // ── Load config (falls back to built-in defaults when none found) ──────────
  let config: ResolvedConfig;
  let usingFallback = false;

  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof FixelConfigError) {
      const framework = detectFramework();
      config       = buildFallbackConfig(framework);
      usingFallback = true;
    } else {
      throw err;
    }
  }

  // ── Token file (when configured) ───────────────────────────────────────────
  // A missing token file is a warning, not a failure: the local scan engine
  // only needs `framework` + `prohibitedPatterns`, so `fixel init` followed by
  // `fixel scan` must work before `fixel import --write` has ever run.
  let tokenFileMissing = false;
  let exclusions: ScanExclusions | undefined;
  if (!usingFallback && config.tokens.file) {
    const tokenFilePath = path.resolve(process.cwd(), config.tokens.file);
    if (!fs.existsSync(tokenFilePath)) {
      tokenFileMissing = true;
    }
    // Exclude exactly the token file from the audit — raw hex is REQUIRED
    // there.  Applied whether or not the file exists yet, so a freshly
    // imported token file is never flagged either.  Sibling files in the
    // same directory ARE scanned (src/components/tokens.ts layouts).
    exclusions = { files: new Set([tokenFilePath]) };
  }

  // ── Locate files ───────────────────────────────────────────────────────────
  const scanRoot = path.resolve(process.cwd(), localPath);
  if (!fs.existsSync(scanRoot)) {
    console.error(`\n  ${C.red}Path not found:${C.reset} ${localPath}\n`);
    process.exit(1);
  }

  let files: string[];
  const scanStat = fs.statSync(scanRoot);
  if (scanStat.isFile()) {
    if (!/\.(tsx?|jsx?)$/.test(scanRoot)) {
      console.error(
        `\n  ${C.red}Unsupported file type:${C.reset} ${localPath}\n` +
        `  Supported extensions: .ts .tsx .js .jsx\n`,
      );
      process.exit(1);
    }
    if (exclusions?.files.has(path.resolve(scanRoot))) {
      console.log(
        `\n  ${C.dim}${localPath} is the configured token file — excluded from scanning` +
        ` (raw values are expected there).${C.reset}\n`,
      );
      process.exit(0);
    }
    files = [scanRoot];
  } else {
    files = collectReactFiles(scanRoot, exclusions);
  }

  console.log(`\n${C.bold}  fixel scan${C.reset}  ${C.dim}local${C.reset}`);
  console.log(`  Path:      ${localPath}`);
  if (usingFallback) {
    console.log(`  ${C.yellow}⚠${C.reset}  No fixel.config.json — using built-in defaults`);
  }
  console.log(`  Framework: ${config.framework}${usingFallback ? ` ${C.dim}(auto-detected)${C.reset}` : ''}`);
  if (!usingFallback) {
    console.log(`  Tokens:    ${config.tokens.file}${tokenFileMissing ? ` ${C.yellow}(not found — run "fixel import --file FILEKEY --write" to generate it)${C.reset}` : ` ${C.dim}(excluded from scan)${C.reset}`}`);
  }

  if (files.length === 0) {
    console.log(`\n  ${C.yellow}No .ts / .tsx / .js / .jsx files found under ${localPath}${C.reset}\n`);
    process.exit(0);
  }

  console.log(`  Files:     ${files.length}\n`);

  // ── Audit each file ────────────────────────────────────────────────────────
  let totalViolations = 0;
  let filesWithErrors = 0;

  for (const file of files) {
    let code: string;
    try {
      code = fs.readFileSync(file, 'utf8');
    } catch {
      console.warn(`  ${C.yellow}⚠${C.reset}  Could not read ${path.relative(process.cwd(), file)} — skipped`);
      continue;
    }

    const violations = auditCode(code, config);
    if (violations.length === 0) continue;

    const rel       = path.relative(process.cwd(), file);
    const hasErrors = violations.some((v: AuditViolation) => v.severity === 'error');
    if (hasErrors) filesWithErrors++;
    totalViolations += violations.length;

    console.log(`  ${C.bold}${rel}${C.reset}`);
    for (const v of violations) {
      const icon =
        v.severity === 'error'
          ? `${C.red}✗${C.reset}`
          : `${C.yellow}⚠${C.reset}`;
      console.log(`    ${icon}  line ${v.line}:${v.column}  ${C.dim}[${v.pattern}]${C.reset}`);
      console.log(`       ${v.snippet}`);
      // Print only the first line of the suggestion to keep output compact
      const firstLine = v.suggestion.split('\n')[0];
      console.log(`       ${C.dim}${firstLine}${C.reset}`);
    }
    console.log('');
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  if (totalViolations === 0) {
    console.log(`  ${C.green}${C.bold}✓ No prohibited patterns found across ${files.length} file(s).${C.reset}`);
    console.log(`  ${C.dim}Next: \`fixel verify\` compares your code against Figma (needs a Figma token — see README).${C.reset}\n`);
    process.exit(0);
  }

  const errorWord  = filesWithErrors === 1 ? 'file' : 'files';
  const violWord   = totalViolations === 1  ? 'violation' : 'violations';
  console.log(
    `  ${C.red}${C.bold}${totalViolations} ${violWord} in ${filesWithErrors} ${errorWord}.${C.reset}` +
    `  ${C.dim}Fix errors before committing.${C.reset}`,
  );
  console.log(`  ${C.dim}Next: fix the errors above and re-run. To check against Figma itself, see README for setup.${C.reset}\n`);
  process.exit(1);
}

// ─── Figma-mode report printer ────────────────────────────────────────────────

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

// ─── Figma-mode main ──────────────────────────────────────────────────────────

async function runFigmaScan(args: ScanArgs): Promise<void> {
  const parsed = parseNodeArg(args.nodeRaw!);

  console.log(`\n${C.bold}  fixel scan${C.reset}`);
  console.log(`  Figma node:  ${args.nodeRaw}`);
  console.log(`  Token group: ${args.group}\n`);

  loadEnvFile();
  const config = loadConfig();
  const figmaToken = resolveFigmaToken(config);

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

  const fills = extractFills(node as unknown as Record<string, unknown>);

  if (fills.size === 0) {
    console.log(`  ${C.yellow}No SOLID fills found in this node.${C.reset}`);
    console.log(`  The node may be an annotation frame rather than a component.\n`);
    process.exit(0);
  }

  const tokenSource = readTokenFile(config);
  const tokenIndex  = buildTokenIndex(tokenSource, config);
  const classified  = classifyFills(fills, tokenIndex);
  const suggestions = buildSuggestions(classified, fills, args.group, config);
  const patch       = formatTokenPatch(suggestions, args.group, config);

  printReport(suggestions, args.group, patch);

  const hasNew      = suggestions.some((s) => s.status === 'new');
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

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // process.argv: [node, fixel-bin.js, 'scan', ...rest]
  // slice(3) skips the 'scan' command word so parseArgs only sees the real arguments.
  const rest = process.argv.slice(3);
  if (rest.includes('--help') || rest.includes('-h')) {
    printScanHelp();
    process.exit(0);
  }
  const args = parseArgs(rest);

  if (args.mode === 'local') {
    await runLocalScan(args.localPath!);
    return;
  }

  await runFigmaScan(args);
}

// ─── Entry ────────────────────────────────────────────────────────────────────

/**
 * Run the scan CLI.  Exported so index.ts can call it explicitly after
 * `require('./cli/scan')` — this is what allows tests to import
 * `collectReactFiles` without triggering the CLI as a side effect.
 *
 * The 0.2.3 regression used `if (require.main === module)` at the TOP LEVEL,
 * which meant index.ts's `require('./cli/scan')` dispatch never called main().
 * The fix: export the runner and have index.ts call it explicitly.
 */
export function runScanCli(): void {
  main().catch((err: unknown) => {
    if (err instanceof FixelConfigError) {
      console.error(`\n  ${C.yellow}Config error:${C.reset} ${err.message}\n`);
    } else if (err instanceof FigmaApiError) {
      console.error(`\n  ${C.red}Figma API error:${C.reset} ${err.message}\n`);
      if (err.statusCode === 403) {
        console.error(`  Check that FIGMA_ACCESS_TOKEN is set and has read access to this file.\n`);
      }
    } else {
      console.error(`\n  ${C.red}Error:${C.reset} ${err instanceof Error ? err.message : String(err)}\n`);
    }
    // exitCode + natural drain instead of process.exit(1): hard-exiting while
    // undici (global fetch) is still tearing down its socket trips a libuv
    // assertion on Windows (src\win\async.c).  figma-client sends
    // 'Connection: close', so no keep-alive handle outlives the response and
    // the drain completes immediately.
    process.exitCode = 1;
  });
}

// Auto-run only when invoked directly (node dist/cli/scan.js).
// The normal dispatch path — index.ts → require('./cli/scan') → runScanCli() —
// does NOT go through this branch.
if (require.main === module) {
  runScanCli();
}
