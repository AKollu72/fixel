#!/usr/bin/env node
// Copyright (c) 2025 Amrutha Kollu. All rights reserved.
// Licensed under the Functional Source License, Version 1.1 (FSL-1.1-MIT) — see LICENSE for details.

/**
 * fixel generate — AI-powered Figma-to-component generator
 *
 * Usage:
 *   fixel generate --name Badge --node FILEKEY:NODEID
 *   fixel generate --name Badge --node FILEKEY:NODEID --dry-run
 *   fixel generate --name Badge --node FILEKEY:NODEID --force
 *   fixel generate --name Badge --node FILEKEY:NODEID --figma-depth 8
 *
 * Flags:
 *   --name         <ComponentName>  PascalCase component name (required)
 *   --node         <FILEKEY:NODEID> Figma node (required)
 *   --dry-run                       Print output without writing files
 *   --force                         Overwrite existing files
 *   --skip-tests                    Skip spec-test generation
 *   --figma-depth  <N>              Figma API tree depth (default: 6, max: 10)
 *   --no-cache                      Bypass the Figma API cache
 *
 * Exit codes:
 *   0  all files written (or dry-run completed)
 *   1  audit failed, AI error, config error, or Figma API error
 */

import * as fs   from 'node:fs';
import * as path from 'node:path';

import Anthropic from '@anthropic-ai/sdk';

import {
  FixelConfigError,
  createDefaultConfig,
  loadConfig,
  loadEnvFile,
  parseNodeArg,
  resolveAiApiKey,
  resolveFigmaToken,
  type TypographyScale,
} from '../core/config';

import {
  FigmaApiError,
  fetchFigmaNode,
  findComponentRoot,
} from '../core/figma-client';

import {
  extractTextStyles,
  buildTypographySummary,
  resolveTypographyToken,
  toSpecTextStyles,
} from '../core/typography';

import {
  buildSpacingSummary,
  buildIconSizesSummary,
  buildVariantDimensionMap,
  buildVariantDimensionBlock,
  buildSpec,
  extractCornerRadii,
  extractIconSizes,
  extractSpacingEntries,
  selectRepresentativeVariants,
} from '../core/extractors';

import {
  auditCode,
  hasErrors,
  type AuditViolation,
} from '../core/audit';

import { readTokenFile, buildTokenIndex, extractFills, findApproximatedTokens } from '../core/tokens';
import { buildSystemPrompt } from '../prompts/system-prompt';

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

interface GenerateArgs {
  name:       string;
  nodeRaw:    string;
  dryRun:     boolean;
  force:      boolean;
  skipTests:  boolean;
  figmaDepth: number;
  noCache:    boolean;
}

function parseArgs(argv: string[]): GenerateArgs {
  const flag = (f: string): string | null => {
    const i = argv.indexOf(f);
    return i !== -1 ? (argv[i + 1] ?? null) : null;
  };

  const name    = flag('--name');
  const nodeRaw = flag('--node');

  if (!name || !nodeRaw) {
    console.error('\n  Usage: fixel generate --name <ComponentName> --node FILEKEY:NODEID\n');
    console.error('  Example: fixel generate --name Badge --node AbCdEfGhIjKlMnOpQrStUv:397:23320\n');
    process.exit(1);
  }

  const depthStr  = flag('--figma-depth');
  const figmaDepth = depthStr
    ? Math.max(3, Math.min(10, parseInt(depthStr, 10)))
    : 6;

  return {
    name,
    nodeRaw:   normalizeNodeArg(nodeRaw),
    figmaDepth,
    dryRun:    argv.includes('--dry-run'),
    force:     argv.includes('--force'),
    skipTests: argv.includes('--skip-tests'),
    noCache:   argv.includes('--no-cache'),
  };
}

// ─── File writer ──────────────────────────────────────────────────────────────

function writeOutputFile(
  filePath: string,
  content:  string,
  opts:     { dryRun: boolean; force: boolean },
): void {
  const rel = path.relative(process.cwd(), filePath);

  if (opts.dryRun) {
    console.log(`\n${'─'.repeat(72)}\n[DRY RUN] ${rel}\n${'─'.repeat(72)}\n${content}`);
    return;
  }

  if (!opts.force && fs.existsSync(filePath)) {
    console.warn(`  ${C.yellow}⚠${C.reset}  Skipping (already exists — use --force): ${rel}`);
    return;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`  ${C.green}✓${C.reset}  ${rel}`);
}

// ─── Violation printer ────────────────────────────────────────────────────────

function printViolations(violations: AuditViolation[]): void {
  const errors   = violations.filter((v) => v.severity === 'error');
  const warnings = violations.filter((v) => v.severity === 'warning');

  if (errors.length > 0) {
    console.error(`\n  ${C.red}${C.bold}Audit errors — file NOT written:${C.reset}\n`);
    for (const v of errors) {
      console.error(`  ${C.red}✗${C.reset}  [${v.pattern}] line ${v.line}:${v.column}`);
      console.error(`     ${C.dim}${v.snippet}${C.reset}`);
      console.error(`     ${v.suggestion}\n`);
    }
  }
  if (warnings.length > 0) {
    console.warn(`  ${C.yellow}⚠  Audit warnings (file written — review before merging):${C.reset}\n`);
    for (const v of warnings) {
      console.warn(`  ${C.yellow}⚠${C.reset}  [${v.pattern}] line ${v.line}:${v.column}`);
      console.warn(`     ${C.dim}${v.snippet}${C.reset}`);
      console.warn(`     ${v.suggestion}\n`);
    }
  }
}

// ─── AI client ────────────────────────────────────────────────────────────────

const SLEEP = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Calls the configured AI provider and returns the raw response text.
 * Retries up to 3 times on rate-limit errors with exponential backoff.
 */
async function callAI(
  systemPrompt: string,
  userMessage:  string,
  apiKey:       string,
  model:        string,
  label:        string,
): Promise<string> {
  const client = new Anthropic({ apiKey });

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: 16000,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: userMessage }],
      });

      const block = response.content.find(
        (b): b is Anthropic.Messages.TextBlock => b.type === 'text',
      );
      if (!block) throw new Error(`No text content in AI response for ${label}`);

      const u = response.usage as {
        input_tokens: number; output_tokens: number;
        cache_read_input_tokens?: number;
      };
      const cached = u.cache_read_input_tokens ?? 0;
      console.log(
        `     ${label}: in=${u.input_tokens} (${cached} cached)  out=${u.output_tokens}`,
      );

      return block.text;
    } catch (err: unknown) {
      if (err instanceof Anthropic.RateLimitError && attempt < 3) {
        const delayMs = 1000 * Math.pow(2, attempt - 1);
        console.warn(`  Rate-limited — retrying in ${delayMs / 1000}s (${attempt}/3)…`);
        await SLEEP(delayMs);
        continue;
      }
      throw err;
    }
  }
  throw new Error(`${label} failed after 3 attempts`);
}

/** Extracts the content of an XML-style tag from the AI response. */
function extractTag(raw: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(raw);
  return match ? match[1].trim() : null;
}

// ─── Node trimmer ─────────────────────────────────────────────────────────────

/**
 * Reduces a full Figma node to the fields the AI needs, discarding noise.
 * Pre-resolves typography tokens onto TEXT nodes so the AI reads a fact,
 * not raw font metrics.
 */
function trimNode(
  node:  Record<string, unknown>,
  scale: TypographyScale,
): Record<string, unknown> {
  const keep: Record<string, unknown> = {
    name: node['name'],
    type: node['type'],
  };

  if (node['componentPropertyDefinitions'])
    keep['componentPropertyDefinitions'] = node['componentPropertyDefinitions'];

  for (const f of ['paddingLeft','paddingRight','paddingTop','paddingBottom','itemSpacing','cornerRadius']) {
    if (node[f] !== undefined) keep[f] = node[f];
  }

  if (node['absoluteBoundingBox']) {
    const b = node['absoluteBoundingBox'] as Record<string, number>;
    keep['size'] = { width: b['width'], height: b['height'] };
  }

  if (node['fills'])   keep['fills']   = node['fills'];
  if (node['strokes']) keep['strokes'] = node['strokes'];
  if (node['effects']) keep['effects'] = node['effects'];

  if (node['type'] === 'TEXT' && node['style']) {
    const s          = node['style'] as Record<string, unknown>;
    const fontSize   = Number(s['fontSize']   ?? 14);
    const fontWeight = Number(s['fontWeight'] ?? 400);
    keep['textStyle'] = { fontSize, fontWeight, lineHeightPx: s['lineHeightPx'] };
    try {
      const entry = resolveTypographyToken(fontSize, fontWeight, scale);
      keep['_resolvedTypographyToken'] = entry.token;
      keep['_resolvedLineHeight']      = entry.lineHeight;
    } catch {
      // FixelConfigError — token not in scale; AI will see raw font metrics only.
    }
  }

  const children = node['children'] as Record<string, unknown>[] | undefined;
  if (children && children.length > 0) {
    keep['variantNames'] = children.map((c) => c['name']);
    const reps = selectRepresentativeVariants(children);
    keep['representativeVariants'] = reps.map((c) => trimNode(c, scale));
  }

  return keep;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args   = parseArgs(process.argv.slice(2));
  const parsed = parseNodeArg(args.nodeRaw);

  const totalSteps = args.skipTests ? 7 : 8;

  console.log(`\n${C.bold}  fixel generate${C.reset}`);
  console.log(`  Component:  ${args.name}`);
  console.log(`  Figma node: ${args.nodeRaw}`);
  if (args.dryRun)    console.log(`  Mode:       dry-run`);
  if (args.skipTests) console.log(`  Tests:      skipped`);
  console.log('');

  // ── Load config + env ──────────────────────────────────────────────────────
  loadEnvFile();
  const config    = loadConfig();
  const apiKey    = resolveAiApiKey(config);
  const { scale } = config.typography;

  // B4: warn when the typography scale has never been customised
  if (JSON.stringify(scale) === JSON.stringify(createDefaultConfig().typography.scale)) {
    console.warn(
      `  \x1b[33m⚠\x1b[0m  Your typography scale is still the default — token names may not exist in your project.\n` +
      `     Edit \x1b[36mfixel.config.json\x1b[0m → \x1b[36mtypography.scale\x1b[0m to match your design system.\n`,
    );
  }

  // Resolve output paths
  const componentDir  = path.resolve(process.cwd(), config.output.componentDir, args.name);
  const componentPath = path.join(componentDir, `${args.name}.tsx`);
  const storiesPath   = path.join(componentDir, `${args.name}.stories.tsx`);
  const testsPath     = path.join(componentDir, config.output.testSubdir, `${args.name}.fixel.test.tsx`);
  const specPath      = path.join(componentDir, `${args.name}.fixel.json`);
  const writeOpts     = { dryRun: args.dryRun, force: args.force };

  // ── Step 1: Fetch Figma ────────────────────────────────────────────────────
  console.log(`  [1/${totalSteps}] Fetching Figma design data…`);
  const rawNode = await fetchFigmaNode({
    accessToken: resolveFigmaToken(config),
    fileKey:     parsed.fileKey,
    nodeId:      parsed.nodeId,
    depth:       args.figmaDepth,
    noCache:     args.noCache,
  });
  const componentRoot = findComponentRoot(rawNode);

  // ── Step 2: Deterministic extraction ──────────────────────────────────────
  console.log(`  [2/${totalSteps}] Extracting design values…`);
  const nodeForExtraction = rawNode as unknown as Record<string, unknown>;

  const textStyles     = extractTextStyles(nodeForExtraction, scale);
  const spacingEntries = extractSpacingEntries(nodeForExtraction);
  const iconSizes      = extractIconSizes(nodeForExtraction);
  const cornerRadii    = extractCornerRadii(nodeForExtraction);
  const rawVariantNames = (componentRoot as unknown as Record<string, unknown>)['children']
    ? ((componentRoot as unknown as Record<string, unknown>)['children'] as Record<string, unknown>[])
        .map((c) => String(c['name'] ?? ''))
    : [];
  const variantDims    = buildVariantDimensionMap(rawVariantNames);

  if (textStyles.length > 0) {
    console.log(`     Typography: ${textStyles.map((s) => `${s.fontSize}px→${s.token}`).join(', ')}`);
  }
  if (spacingEntries.size > 0) {
    console.log(`     Spacing:    ${[...spacingEntries.keys()].join(', ')}`);
  }
  if (iconSizes.size > 0) {
    console.log(`     Icons:      ${[...iconSizes.values()].map((i) => `${i.nodeName}(${i.width}×${i.height})`).join(', ')}`);
  }
  if (cornerRadii.size > 0) {
    console.log(`     Radii:      ${[...cornerRadii].sort((a, b) => a - b).join(', ')}px`);
  }

  // ── Step 3: Build system prompt ────────────────────────────────────────────
  console.log(`  [3/${totalSteps}] Loading context…`);
  const tokenSource  = readTokenFile(config);
  const systemPrompt = buildSystemPrompt(config, tokenSource);

  // Warn about colours the AI will likely approximate with a nearby token
  const fills        = extractFills(nodeForExtraction);
  const tokenIndex   = buildTokenIndex(tokenSource, config);
  const approximated = findApproximatedTokens(fills, tokenIndex, tokenSource, config);
  for (const a of approximated) {
    console.warn(
      `  ${C.yellow}⚠${C.reset}  Color approximated: ${a.inputHex} → ${a.tokenName} (${a.tokenHex})\n` +
      `     Add a token for ${a.inputHex} to get an exact match.`,
    );
  }

  // ── Step 4: Build user message ─────────────────────────────────────────────
  const trimmed         = trimNode(nodeForExtraction, scale);
  const typographyBlock = buildTypographySummary(textStyles);
  const spacingBlock    = buildSpacingSummary(spacingEntries);
  const iconBlock       = buildIconSizesSummary(iconSizes);
  const variantBlock    = buildVariantDimensionBlock(variantDims);

  const componentMessage = [
    `Generate ONLY the ${args.name}.tsx component file. Do not generate stories or tests.`,
    ``,
    `Figma node: ${args.name} (file ${parsed.fileKey})`,
    variantBlock,
    typographyBlock,
    spacingBlock,
    iconBlock,
    `<figma_data>`,
    JSON.stringify(trimmed, null, 2),
    `</figma_data>`,
    ``,
    `Requirements:`,
    `- Exported TypeScript interface: ${args.name}Props`,
    `- All variant props as TypeScript unions derived from the Figma variant names`,
    `- All states (hover, active, focus, disabled) via CSS pseudo-selectors`,
    `- Export all constant tables (TYPE_TOKENS, TEXT_VARIANT, SIZE_MAP, etc.)`,
    `- JSDoc comment at the top listing variants and usage examples`,
    ``,
    `Output the complete ${args.name}.tsx file contents inside this XML tag:`,
    `<component>`,
    `[file contents here]`,
    `</component>`,
  ].join('\n');

  // ── Step 5: Generate component ─────────────────────────────────────────────
  console.log(`  [4/${totalSteps}] Generating component…`);
  const rawComponent = await callAI(
    systemPrompt, componentMessage, apiKey, config.ai.model, 'Component',
  );
  const componentCode = extractTag(rawComponent, 'component');
  if (!componentCode) {
    console.error(`\n  ${C.red}Could not parse <component> tag from AI response.${C.reset}`);
    dumpDebug(args.name, 'component', rawComponent);
    process.exit(1);
  }

  // ── Step 6: Audit component ────────────────────────────────────────────────
  console.log(`  [5/${totalSteps}] Auditing component…`);
  const compViolations = auditCode(componentCode, config);
  printViolations(compViolations);

  if (hasErrors(compViolations)) {
    console.error(`\n  ${C.red}${C.bold}Component audit failed — no files written.${C.reset}`);
    console.error(`  Fix the errors above, then re-run.`);
    console.error(`  To record an intentional deviation: add it to ${args.name}.fixel.overrides.json\n`);
    process.exit(1);
  }

  writeOutputFile(componentPath, componentCode, writeOpts);

  if (config.framework === 'css-modules' && !args.dryRun) {
    const cssPath = path.join(componentDir, `${args.name}.module.css`);
    if (!args.force && fs.existsSync(cssPath)) {
      console.warn(`  ${C.yellow}⚠${C.reset}  Skipping (already exists — use --force): ${path.relative(process.cwd(), cssPath)}`);
    } else {
      fs.mkdirSync(componentDir, { recursive: true });
      fs.writeFileSync(cssPath, `/* Generated by Fixel — add your styles here */\n`, 'utf8');
      console.log(`  ${C.green}✓${C.reset}  ${path.relative(process.cwd(), cssPath)}`);
    }
  }

  // ── Step 7: Generate stories ───────────────────────────────────────────────
  console.log(`  [6/${totalSteps}] Generating stories…`);
  const storiesMessage = [
    `Generate ONLY the ${args.name}.stories.tsx Storybook story file for this component:`,
    ``,
    `<component_code>`,
    componentCode,
    `</component_code>`,
    variantBlock,
    ``,
    `Requirements:`,
    `- Import from '${config.storybook.adapterPackage}'`,
    `- satisfies Meta<typeof ${args.name}> — CSF3 format`,
    `- Do NOT include tags: ['autodocs']`,
    `- One story per Figma variant (all values in VARIANT DIMENSIONS above)`,
    `- Args must only use props from ${args.name}Props`,
    ``,
    `Output inside: <stories>[file contents here]</stories>`,
  ].join('\n');

  const rawStories  = await callAI(systemPrompt, storiesMessage, apiKey, config.ai.model, 'Stories ');
  const storiesCode = extractTag(rawStories, 'stories');

  if (!storiesCode) {
    console.error(`\n  ${C.red}Could not parse <stories> tag.${C.reset}`);
    dumpDebug(args.name, 'stories', rawStories);
  } else {
    const storiesViolations = auditCode(storiesCode, config);
    printViolations(storiesViolations);
    if (!hasErrors(storiesViolations)) {
      writeOutputFile(storiesPath, storiesCode, writeOpts);
    }
  }

  // ── Step 8: Generate spec tests ────────────────────────────────────────────
  if (!args.skipTests) {
    console.log(`  [7/${totalSteps}] Generating spec tests…`);
    const specSummary = textStyles
      .map((s) => `  ${s.token}: fontSize="${s.fontSize}px", lineHeight="${s.lineHeight}"`)
      .join('\n');

    const testsMessage = [
      `Generate the ${args.name}.fixel.test.tsx spec-lock test file for this component.`,
      ``,
      `<component_code>`,
      componentCode,
      `</component_code>`,
      ``,
      `Figma-resolved typography spec:`,
      specSummary || '  (no text styles)',
      ``,
      `Requirements:`,
      `- File path: ${path.relative(process.cwd(), testsPath)}`,
      `- Use ${config.testing.framework} + ${config.testing.renderLibrary}`,
      `- Import exported constant tables from '../${args.name}'`,
      `- Import typography from '${config.typography.importPath}'`,
      `- Import semantic from '${config.tokens.importPath}'`,
      `- Test that TYPE_TOKENS produces distinct values for each variant`,
      `- Test that typography tokens match the spec above`,
      ``,
      `Output inside: <tests>[file contents here]</tests>`,
    ].join('\n');

    const rawTests  = await callAI(systemPrompt, testsMessage, apiKey, config.ai.model, 'Tests   ');
    const testsCode = extractTag(rawTests, 'tests');

    if (!testsCode) {
      console.warn(`  ${C.yellow}⚠  Could not parse <tests> tag — skipping test file.${C.reset}`);
    } else {
      writeOutputFile(testsPath, testsCode, writeOpts);
    }
  }

  // ── Write spec file ────────────────────────────────────────────────────────
  console.log(`  [${args.skipTests ? 7 : 8}/${totalSteps}] Writing spec…`);
  const spec = buildSpec({
    figmaFile:     parsed.fileKey,
    figmaNode:     parsed.nodeId,
    textStyles:    toSpecTextStyles(textStyles),
    spacingEntries,
    iconSizes,
    cornerRadii,
  });

  if (!args.dryRun) {
    fs.mkdirSync(componentDir, { recursive: true });
    fs.writeFileSync(specPath, JSON.stringify(spec, null, 2) + '\n', 'utf8');
    console.log(`  ${C.green}✓${C.reset}  ${path.relative(process.cwd(), specPath)}`);
  }

  if (!args.dryRun) {
    console.log(`\n  ${C.green}${C.bold}Done!${C.reset} — ${args.name}`);
    console.log(`\n  Next steps:`);
    console.log(`    npm run storybook    → visual check`);
    console.log(`    npm run typecheck    → TypeScript`);
    console.log(`    npx jest             → spec tests`);
    console.log(`    fixel verify --component ${args.name} --node ${args.nodeRaw}  → drift check\n`);
  }
}

// ─── Debug dump ───────────────────────────────────────────────────────────────

function dumpDebug(name: string, stage: string, raw: string): void {
  try {
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    const dir      = path.resolve(process.cwd(), 'node_modules', '.cache', 'fixel-debug');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${safeName}-${stage}-${Date.now()}.txt`);
    fs.writeFileSync(file, raw, 'utf8');
    console.error(`  Debug: raw AI response saved to ${path.relative(process.cwd(), file)}\n`);
  } catch {
    // Best-effort — debug dump is non-fatal.
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
    process.exit(1);
  }
  if (err instanceof Error && err.message.includes('ANTHROPIC_API_KEY')) {
    console.error(`\n  ${C.red}AI key error:${C.reset} ${err.message}\n`);
    process.exit(1);
  }
  console.error(`\n  ${C.red}Error:${C.reset} ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
