#!/usr/bin/env node
// Copyright (c) 2025 Amrutha Kollu. All rights reserved.
// Licensed under the Functional Source License, Version 1.1 (FSL-1.1-MIT) — see LICENSE for details.

/**
 * fixel annotate — post drift findings as a Figma comment
 *
 * Runs the same drift checks as `fixel verify` against a component's stored
 * spec, then posts a single summary comment on the Figma node if any
 * unresolved drift exists.  Overridden checks are never posted.
 *
 * Usage:
 *   fixel annotate --component Badge --node FILEKEY:NODEID
 *   fixel annotate --component Badge --node FILEKEY:NODEID --dry-run
 *
 * Flags:
 *   --component <Name>    Component to check (required)
 *   --node <FILEKEY:ID>   Figma file key + node ID to post on (required)
 *   --dry-run             Print the comment text without posting
 *
 * Required Figma token scope:
 *   "Create, modify, and delete comments in accessible files"
 *   (Comments → Write on the PAT creation screen)
 *
 * Exit codes:
 *   0  comment posted, nothing to post, or --dry-run
 *   1  drift check failure or Figma API error
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
  type FixelSpec,
} from '../core/extractors';

import {
  loadOverrides,
} from '../core/overrides';

import {
  type CheckResult,
  runDriftChecks,
  componentStatus,
} from '../core/drift';

import {
  FigmaWriteError,
  postComment,
  listComments,
} from '../core/figma-writer';

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

interface AnnotateArgs {
  component: string;
  nodeRaw:   string;
  dryRun:    boolean;
}

function parseArgs(argv: string[]): AnnotateArgs {
  const flag = (f: string): string | null => {
    const i = argv.indexOf(f);
    return i !== -1 ? (argv[i + 1] ?? null) : null;
  };

  const component = flag('--component');
  const nodeRaw   = flag('--node');

  if (!component) {
    console.error(`\n  ${C.red}✗${C.reset}  --component <Name> is required.\n`);
    console.error(`  Usage: fixel annotate --component Badge --node FILEKEY:NODEID\n`);
    process.exit(1);
  }
  if (!nodeRaw) {
    console.error(`\n  ${C.red}✗${C.reset}  --node FILEKEY:NODEID is required.\n`);
    console.error(`  Usage: fixel annotate --component Badge --node FILEKEY:NODEID\n`);
    process.exit(1);
  }

  return { component, nodeRaw: normalizeNodeArg(nodeRaw), dryRun: argv.includes('--dry-run') };
}

// ─── Comment helpers ──────────────────────────────────────────────────────────

/**
 * Normalises Figma node IDs for comparison.
 * The Figma API may return IDs with either ":" or "-" as separator;
 * normalising both sides to "-" ensures we match posted vs stored IDs.
 */
function normaliseNodeId(id: string): string {
  return id.replace(/:/g, '-');
}

/**
 * Builds the single summary comment body for all drift findings.
 *
 * Format:
 *   [Fixel] Drift detected on Badge
 *   • Typography 12px / weight 500: variant="labelMd" not found — ...
 *   • Border-radius 8px: '8px' not found as string — ...
 *   Detected 2026-06-10 · automated spec check.
 */
function formatComment(
  componentName: string,
  driftChecks:   CheckResult[],
  today:         string,
): string {
  const lines: string[] = [`[Fixel] Drift detected on ${componentName}`];

  for (const c of driftChecks) {
    if (c.status !== 'fail' && c.status !== 'warn') continue;
    const label = c.label.trim().replace(/\s{2,}/g, ' ');
    lines.push(`• ${label}: ${c.detail}`);
  }

  lines.push(`Detected ${today} · automated spec check.`);
  return lines.join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  loadEnvFile();
  const config    = loadConfig();
  const overrides = loadOverrides(process.cwd());
  const parsed    = parseNodeArg(args.nodeRaw);

  const componentBaseDir = path.resolve(process.cwd(), config.output.componentDir);
  const componentDir     = path.join(componentBaseDir, args.component);
  const specPath         = path.join(componentDir, `${args.component}.fixel.json`);
  const codePath         = path.join(componentDir, `${args.component}.tsx`);

  // ── Guard: spec file must exist ───────────────────────────────────────────
  if (!fs.existsSync(specPath)) {
    console.error(
      `\n  ${C.yellow}⚠${C.reset}  "${args.component}" has no fixel.json spec yet.\n\n` +
      `  Generate the component first:\n` +
      `    ${C.cyan}fixel generate --name ${args.component} --node ${args.nodeRaw}${C.reset}\n`,
    );
    process.exit(1);
  }

  if (!fs.existsSync(codePath)) {
    console.error(
      `\n  ${C.red}✗${C.reset}  Component source not found: ${codePath}\n`,
    );
    process.exit(1);
  }

  // ── Run drift checks ──────────────────────────────────────────────────────
  const spec   = JSON.parse(fs.readFileSync(specPath, 'utf8')) as FixelSpec;
  const code   = fs.readFileSync(codePath, 'utf8');
  const checks = runDriftChecks(code, spec, overrides, args.component, config);
  const status = componentStatus(checks);

  if (status === 'pass') {
    console.log(
      `\n  ${C.green}✓${C.reset}  ${C.bold}${args.component}${C.reset}  No drift to annotate.\n`,
    );
    return;
  }

  // ── Compose comment ───────────────────────────────────────────────────────
  const today   = new Date().toISOString().slice(0, 10);
  const message = formatComment(args.component, checks, today);

  if (args.dryRun) {
    console.log(`\n${C.bold}  fixel annotate${C.reset}  ${C.dim}--dry-run${C.reset}\n`);
    console.log(`  ${C.dim}Would post to file ${parsed.fileKey}, node ${parsed.nodeId}:${C.reset}\n`);
    console.log(message.split('\n').map((l) => `  ${l}`).join('\n'));
    console.log();
    return;
  }

  // ── Duplicate prevention ──────────────────────────────────────────────────
  const accessToken = resolveFigmaToken(config);

  const existing = await listComments(parsed.fileKey, accessToken);
  const duplicate = existing.find((c) =>
    c.message.startsWith('[Fixel]') &&
    normaliseNodeId(c.client_meta?.node_id ?? '') === normaliseNodeId(parsed.nodeId) &&
    !c.resolved_at,
  );

  if (duplicate) {
    console.log(
      `\n  ${C.cyan}⊘${C.reset}  Existing Fixel annotation found on ${args.component} ` +
      `(comment ${duplicate.id}) — skipping.\n` +
      `  ${C.dim}Resolve the existing comment in Figma to allow a new one.${C.reset}\n`,
    );
    return;
  }

  // ── Post comment ──────────────────────────────────────────────────────────
  const result = await postComment({
    fileKey:     parsed.fileKey,
    message,
    nodeId:      parsed.nodeId,
    accessToken,
  });

  const errorCount = checks.filter((c) => c.status === 'fail').length;
  const warnCount  = checks.filter((c) => c.status === 'warn').length;

  console.log(
    `\n  ${C.red}✗${C.reset}  ${C.bold}${args.component}${C.reset}  ` +
    `${errorCount} error(s) · ${warnCount} warning(s)\n`,
  );
  console.log(
    `  ${C.green}✓${C.reset}  Comment posted to Figma  ` +
    `${C.dim}(id: ${result.commentId} · node ${parsed.nodeId})${C.reset}\n`,
  );
}

// ─── Entry ────────────────────────────────────────────────────────────────────

main().catch((err: unknown) => {
  if (err instanceof FixelConfigError) {
    console.error(`\n  ${C.yellow}Config error:${C.reset} ${err.message}\n`);
    process.exit(1);
  }
  if (err instanceof FigmaWriteError) {
    console.error(`\n  ${C.red}Figma error:${C.reset} ${err.message}\n`);
    process.exit(1);
  }
  console.error(`\n  ${C.red}Error:${C.reset} ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
