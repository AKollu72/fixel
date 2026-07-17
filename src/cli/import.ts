#!/usr/bin/env node
// Copyright (c) 2025 Amrutha Kollu. All rights reserved.
// Licensed under the Functional Source License, Version 1.1 (FSL-1.1-MIT) — see LICENSE for details.

/**
 * fixel import — generates token files from Figma design system styles
 *
 * Reads published FILL and TEXT styles from a Figma file and outputs:
 *   • tokens.ts  — an `as const` semantic token object (new file), or a
 *                  paste-ready merge patch (if the token file already exists)
 *   • fixel.config.json  — typography.scale entries merged in (--write only)
 *
 * Usage:
 *   fixel import --file FILEKEY           (dry-run: prints what it would write)
 *   fixel import --file FILEKEY --write   (writes the files)
 *
 * Reads Figma *styles* (FILL and TEXT).
 * Variables (Enterprise REST API) are not supported in v1.
 *
 * Exit codes:
 *   0  success (including "no styles found")
 *   1  fatal error (Figma API, config, or filesystem error)
 */

import * as fs   from 'node:fs';
import * as path from 'node:path';

import {
  FixelConfigError,
  loadConfig,
  loadEnvFile,
  resolveFigmaToken,
} from '../core/config';

import {
  FigmaApiError,
  fetchFileStyles,
  type ResolvedFillStyle,
  type ResolvedTextStyle,
} from '../core/figma-client';

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

interface ImportArgs {
  fileKey: string;
  write:   boolean;
  noCache: boolean;
}

function parseArgs(argv: string[]): ImportArgs {
  const flag = (f: string): string | null => {
    const i = argv.indexOf(f);
    return i !== -1 ? (argv[i + 1] ?? null) : null;
  };

  const fileKey = flag('--file');
  if (!fileKey) {
    console.error(`\n  Usage: fixel import --file FILEKEY [--write]\n`);
    console.error(`  Example: fixel import --file AbCdEfGhIjKlMnOpQrStUv --write\n`);
    process.exit(1);
  }

  return {
    fileKey,
    write:   argv.includes('--write'),
    noCache: argv.includes('--no-cache'),
  };
}

// ─── Name derivation: color tokens ───────────────────────────────────────────

/**
 * Converts a word or phrase to a camelCase JavaScript identifier segment.
 * "Primary Background" → "primaryBackground"
 */
function toCamelIdent(s: string): string {
  const words = s.trim().split(/[\s_-]+/).filter(Boolean);
  return words
    .map((w, i) => {
      const clean = w.replace(/[^a-zA-Z0-9]/g, '');
      if (!clean) return '';
      return i === 0
        ? clean.charAt(0).toLowerCase() + clean.slice(1)
        : clean.charAt(0).toUpperCase() + clean.slice(1);
    })
    .join('');
}

/**
 * Converts a Figma FILL style name to a { group, role } token path.
 *
 * Rule: first "/"-segment → lowercase group; remaining segments → camelCase role.
 *   "Brand/Primary/Background"  → { group: "brand",   role: "primaryBackground" }
 *   "Surface/Default"           → { group: "surface",  role: "default" }
 *   "Primary"                   → { group: "primary",  role: "value" }
 */
function fillStyleToPath(styleName: string): { group: string; role: string } {
  const segments = styleName.split('/').map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return { group: 'unknown', role: 'value' };

  const group = toCamelIdent(segments[0]).toLowerCase();
  if (segments.length === 1) return { group, role: 'value' };

  const roleSegments = segments.slice(1);
  const role = roleSegments
    .map((seg, i) => {
      const id = toCamelIdent(seg);
      return i === 0 ? id : id.charAt(0).toUpperCase() + id.slice(1);
    })
    .join('');

  return { group, role: role || 'value' };
}

// ─── Name derivation: typography tokens ──────────────────────────────────────

const SIZE_ABBREVS: Record<string, string> = {
  xs: 'Xs', 'extra small': 'Xs', xsmall: 'Xs', 'x-small': 'Xs',
  sm: 'Sm', small:  'Sm',
  md: 'Md', medium: 'Md',
  lg: 'Lg', large:  'Lg',
  xl: 'Xl', 'extra large': 'Xl', xlarge: 'Xl', 'x-large': 'Xl',
  '2xl': 'Xxl', xxl: 'Xxl', '2xlarge': 'Xxl', xxlarge: 'Xxl',
  '3xl': 'Xxxl', xxxl: 'Xxxl', '3xlarge': 'Xxxl', xxxlarge: 'Xxxl',
};

/**
 * Converts a Figma TEXT style name to a camelCase typography token.
 * Applies standard size-word abbreviations so output matches common conventions.
 *   "Label/Small"     → "labelSm"
 *   "Display/Large"   → "displayLg"
 *   "Headline/Medium" → "headlineMd"
 */
function textStyleToToken(styleName: string): string {
  const segments = styleName.split('/').map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return 'unknownStyle';

  return segments
    .map((seg, i) => {
      const lower  = seg.toLowerCase();
      const abbrev = SIZE_ABBREVS[lower];
      if (abbrev) {
        return i === 0 ? abbrev.charAt(0).toLowerCase() + abbrev.slice(1) : abbrev;
      }
      const id = toCamelIdent(seg);
      return i === 0 ? id : id.charAt(0).toUpperCase() + id.slice(1);
    })
    .join('');
}

// ─── Color token helpers ──────────────────────────────────────────────────────

interface ColorToken {
  group: string;
  role:  string;
  hex:   string;
  name:  string;   // original Figma style name (for display)
}

/**
 * Converts resolved FILL styles into deduplicated, sorted color tokens.
 * Duplicate group+role pairs are suffixed with 2, 3, … and a warning is emitted.
 */
function buildColorTokens(
  fills: [string, ResolvedFillStyle][],
): { tokens: ColorToken[]; warnings: string[] } {
  const warnings: string[] = [];
  const seen = new Map<string, number>();
  const tokens: ColorToken[] = [];

  for (const [, style] of fills) {
    const { group, role } = fillStyleToPath(style.name);
    const key   = `${group}.${role}`;
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);

    const finalRole = count === 0 ? role : `${role}${count + 1}`;
    if (count > 0) {
      warnings.push(`Duplicate name "${key}" → renamed "${group}.${finalRole}" (style: "${style.name}")`);
    }
    tokens.push({ group, role: finalRole, hex: style.hex, name: style.name });
  }

  tokens.sort((a, b) => {
    const g = a.group.localeCompare(b.group);
    return g !== 0 ? g : a.role.localeCompare(b.role);
  });

  return { tokens, warnings };
}

/**
 * Renders the complete tokens.ts file content from a list of color tokens.
 * Values are aligned within each group for readability.
 */
function renderTokensTs(tokens: ColorToken[], fileKey: string): string {
  const groups = new Map<string, ColorToken[]>();
  for (const t of tokens) {
    const list = groups.get(t.group) ?? [];
    list.push(t);
    groups.set(t.group, list);
  }

  const lines: string[] = [
    `// Generated by \`fixel import --file ${fileKey} --write\``,
    `// Re-run to update.  Never edit hex values here — they come from Figma.`,
    `export const semantic = {`,
  ];

  for (const group of [...groups.keys()].sort()) {
    const entries = groups.get(group)!;
    const maxLen  = Math.max(...entries.map((e) => e.role.length));
    lines.push(`  ${group}: {`);
    for (const t of entries) {
      const pad = ' '.repeat(maxLen - t.role.length + 2);
      lines.push(`    ${t.role}:${pad}'${t.hex}',`);
    }
    lines.push(`  },`);
  }

  lines.push(`} as const;`);
  return lines.join('\n') + '\n';
}

/**
 * Identifies which tokens are not yet present in an existing token file.
 * Detection: looks for `role:` or `role :` as a property key in the source.
 */
function buildMergePatch(
  tokens:         ColorToken[],
  existingSource: string,
): { newTokens: ColorToken[]; presentCount: number } {
  const newTokens: ColorToken[] = [];
  let presentCount = 0;

  for (const t of tokens) {
    if (new RegExp(`\\b${t.role}\\s*:`).test(existingSource)) {
      presentCount++;
    } else {
      newTokens.push(t);
    }
  }

  return { newTokens, presentCount };
}

/**
 * Renders a paste-ready partial TypeScript block for a set of new tokens,
 * grouped by namespace for easy insertion into an existing token file.
 */
function renderMergePatchBlock(tokens: ColorToken[]): string {
  const groups = new Map<string, ColorToken[]>();
  for (const t of tokens) {
    const list = groups.get(t.group) ?? [];
    list.push(t);
    groups.set(t.group, list);
  }

  const lines: string[] = [];
  for (const [group, entries] of [...groups.entries()].sort()) {
    const maxLen = Math.max(...entries.map((e) => e.role.length));
    lines.push(`  ${group}: {`);
    for (const t of entries) {
      const pad = ' '.repeat(maxLen - t.role.length + 2);
      lines.push(`    ${t.role}:${pad}'${t.hex}',`);
    }
    lines.push(`  },`);
  }
  return lines.join('\n');
}

// ─── Typography helpers ───────────────────────────────────────────────────────

interface TypographyEntry {
  scaleKey:   string;   // "11/500"
  token:      string;   // "labelSm"
  lineHeight: string;   // "16px"
  styleName:  string;   // original Figma style name
}

/**
 * Converts resolved TEXT styles into typography scale entries.
 * Deduplicates on scaleKey (first occurrence wins) and on token name (suffixed).
 */
function buildTypographyEntries(
  texts: [string, ResolvedTextStyle][],
): { entries: TypographyEntry[]; warnings: string[] } {
  const warnings: string[] = [];
  const seenKeys   = new Map<string, string>();  // scaleKey → first token name
  const seenTokens = new Set<string>();
  const entries: TypographyEntry[] = [];

  for (const [, style] of texts) {
    const scaleKey  = `${style.fontSize}/${style.fontWeight}`;
    const baseToken = textStyleToToken(style.name);
    let   token     = baseToken;

    if (seenTokens.has(token)) {
      let n = 2;
      while (seenTokens.has(`${baseToken}${n}`)) n++;
      token = `${baseToken}${n}`;
      warnings.push(`Duplicate token name "${baseToken}" from "${style.name}" — renamed to "${token}"`);
    }
    seenTokens.add(token);

    if (seenKeys.has(scaleKey)) {
      warnings.push(`Scale key "${scaleKey}" already mapped to "${seenKeys.get(scaleKey)}" — skipping "${style.name}"`);
      continue;
    }
    seenKeys.set(scaleKey, token);

    entries.push({
      scaleKey,
      token,
      lineHeight: `${style.lineHeightPx}px`,
      styleName:  style.name,
    });
  }

  // Largest font size first (mirrors the convention in fixel.config.example.json)
  entries.sort((a, b) => {
    const [fsA] = a.scaleKey.split('/').map(Number);
    const [fsB] = b.scaleKey.split('/').map(Number);
    return fsB - fsA;
  });

  return { entries, warnings };
}

// ─── Config merge ─────────────────────────────────────────────────────────────

/**
 * Merges typography scale entries into fixel.config.json.
 * Only adds keys that are not already present in the existing scale.
 * Returns the number of entries actually added.
 */
function mergeTypographyIntoConfig(configPath: string, entries: TypographyEntry[]): number {
  const json = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;

  const typo  = (json['typography'] ?? {}) as Record<string, unknown>;
  const scale = (typo['scale']     ?? {}) as Record<string, unknown>;

  let added = 0;
  for (const e of entries) {
    if (scale[e.scaleKey] !== undefined) continue;
    scale[e.scaleKey] = { token: e.token, lineHeight: e.lineHeight };
    added++;
  }

  typo['scale']       = scale;
  json['typography']  = typo;

  fs.writeFileSync(configPath, JSON.stringify(json, null, 2) + '\n', 'utf8');
  return added;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log(`\n${C.bold}  fixel import${C.reset}  ${C.dim}${args.fileKey}${C.reset}`);
  if (!args.write) console.log(`  ${C.dim}Dry-run — pass --write to apply changes.${C.reset}`);
  console.log();

  loadEnvFile();
  const config     = loadConfig();
  const token      = resolveFigmaToken(config);
  const configPath = path.resolve(process.cwd(), 'fixel.config.json');

  // ── Fetch & resolve styles ─────────────────────────────────────────────────
  const result = await fetchFileStyles({
    accessToken: token,
    fileKey:     args.fileKey,
    noCache:     args.noCache,
    onProgress:  (msg) => console.log(msg),
  });

  console.log(`  ${C.green}✓${C.reset}  File: ${C.bold}${result.fileName}${C.reset}`);

  const allFills = Object.entries(result.resolvedStyles)
    .filter((e): e is [string, ResolvedFillStyle] => e[1].styleType === 'FILL');
  const allTexts = Object.entries(result.resolvedStyles)
    .filter((e): e is [string, ResolvedTextStyle] => e[1].styleType === 'TEXT');

  const fillTotal = Object.values(result.stylesMeta).filter((m) => m.styleType === 'FILL').length;
  const textTotal = Object.values(result.stylesMeta).filter((m) => m.styleType === 'TEXT').length;

  console.log(
    `  ${C.green}✓${C.reset}  ${allFills.length}/${fillTotal} FILL styles resolved · ` +
    `${allTexts.length}/${textTotal} TEXT styles resolved`,
  );

  if (result.skippedIds.length > 0) {
    const names = result.skippedIds
      .map((id) => result.stylesMeta[id]?.name ?? id)
      .slice(0, 8)
      .join(', ');
    const more = result.skippedIds.length > 8 ? ` +${result.skippedIds.length - 8} more` : '';
    console.log(
      `  ${C.yellow}⚠${C.reset}  ${result.skippedIds.length} skipped (no node carrying the style found at depth=4): ${names}${more}`,
    );
    console.log(`  ${C.dim}  Tip: run with --no-cache after the file is updated, or skip and fill in manually.${C.reset}`);
  }

  // ── Zero styles ────────────────────────────────────────────────────────────
  if (allFills.length === 0 && allTexts.length === 0) {
    console.log(
      `\n  ${C.yellow}No resolvable FILL or TEXT styles found.${C.reset}\n\n` +
      `  This usually means the file has no published styles, or styles are\n` +
      `  not applied to any visible nodes within depth=4.  Try the per-component\n` +
      `  workflow instead:\n\n` +
      `    ${C.cyan}fixel scan --node ${args.fileKey}:NODEID${C.reset}\n`,
    );
    process.exit(0);
  }

  // ── COLOR TOKENS ───────────────────────────────────────────────────────────
  if (allFills.length > 0) {
    console.log(`\n  ${C.bold}── Color tokens${C.reset}`);

    const { tokens, warnings } = buildColorTokens(allFills);
    for (const w of warnings) console.log(`  ${C.yellow}⚠${C.reset}  ${w}`);

    const tokenFilePath = path.resolve(process.cwd(), config.tokens.file);
    const fileExists    = fs.existsSync(tokenFilePath);

    if (!fileExists) {
      // ── New file ────────────────────────────────────────────────────────
      console.log(
        `\n  ${tokens.length} tokens  →  ${C.cyan}${config.tokens.file}${C.reset}` +
        `  ${C.dim}(file does not exist — would write)${C.reset}\n`,
      );

      const maxPath = Math.max(...tokens.map((t) => `${t.group}.${t.role}`.length));
      for (const t of tokens) {
        const p   = `${t.group}.${t.role}`;
        const pad = ' '.repeat(maxPath - p.length + 2);
        console.log(`    ${C.cyan}${p}${C.reset}${pad}${t.hex}`);
      }

      const tsContent = renderTokensTs(tokens, args.fileKey);
      console.log(`\n  ${C.bold}Generated tokens.ts:${C.reset}\n`);
      for (const line of tsContent.split('\n')) console.log(`    ${line}`);

      if (args.write) {
        fs.mkdirSync(path.dirname(tokenFilePath), { recursive: true });
        fs.writeFileSync(tokenFilePath, tsContent, 'utf8');
        console.log(`  ${C.green}✓${C.reset}  Wrote ${config.tokens.file}`);
      }
    } else {
      // ── Merge patch ─────────────────────────────────────────────────────
      const existing                = fs.readFileSync(tokenFilePath, 'utf8');
      const { newTokens, presentCount } = buildMergePatch(tokens, existing);

      console.log(
        `\n  ${C.dim}${config.tokens.file} already exists.${C.reset}  ` +
        `${newTokens.length} new  ·  ${presentCount} already present\n`,
      );

      if (newTokens.length === 0) {
        console.log(`  ${C.green}✓${C.reset}  All tokens already in file — nothing to add.\n`);
      } else {
        const maxPath = Math.max(...newTokens.map((t) => `${t.group}.${t.role}`.length));
        for (const t of newTokens) {
          const p   = `${t.group}.${t.role}`;
          const pad = ' '.repeat(maxPath - p.length + 2);
          console.log(`    ${C.green}+${C.reset}  ${C.cyan}${p}${C.reset}${pad}${t.hex}`);
        }

        const patch = renderMergePatchBlock(newTokens);
        console.log(`\n  ${C.bold}Paste-ready merge patch:${C.reset}\n`);
        for (const line of patch.split('\n')) console.log(`    ${line}`);

        if (args.write) {
          console.log(
            `\n  ${C.yellow}ℹ${C.reset}  ${config.tokens.file} not auto-modified — paste the block above into your token file.\n` +
            `  ${C.dim}  (Safe insertion into an existing TypeScript object requires a human review.)${C.reset}`,
          );
        }
      }
    }
  }

  // ── TYPOGRAPHY ─────────────────────────────────────────────────────────────
  if (allTexts.length > 0) {
    console.log(`\n  ${C.bold}── Typography${C.reset}`);

    const { entries, warnings: typoWarns } = buildTypographyEntries(allTexts);
    for (const w of typoWarns) console.log(`  ${C.yellow}⚠${C.reset}  ${w}`);

    const existingScale = config.typography.scale;
    const newEntries    = entries.filter((e) => !(e.scaleKey in existingScale));
    const presentCount  = entries.length - newEntries.length;

    if (newEntries.length === 0) {
      console.log(`\n  ${C.green}✓${C.reset}  All typography entries already in config — nothing to add.\n`);
    } else {
      console.log(
        `\n  ${newEntries.length} new scale entr${newEntries.length === 1 ? 'y' : 'ies'}  →  fixel.config.json typography.scale` +
        (presentCount > 0 ? `  ${C.dim}(${presentCount} already present)${C.reset}` : '') +
        '\n',
      );

      const maxKey = Math.max(...newEntries.map((e) => e.scaleKey.length));
      for (const e of newEntries) {
        const pad = ' '.repeat(maxKey - e.scaleKey.length + 2);
        console.log(
          `    ${C.cyan}"${e.scaleKey}"${C.reset}${pad}` +
          `{ "token": "${e.token}", "lineHeight": "${e.lineHeight}" }` +
          `  ${C.dim}// ${e.styleName}${C.reset}`,
        );
      }

      if (args.write) {
        if (!fs.existsSync(configPath)) {
          console.log(`\n  ${C.yellow}⚠${C.reset}  fixel.config.json not found — run fixel init first.`);
        } else {
          const added = mergeTypographyIntoConfig(configPath, newEntries);
          console.log(`\n  ${C.green}✓${C.reset}  Merged ${added} entr${added === 1 ? 'y' : 'ies'} into fixel.config.json typography.scale`);
        }
      }
    }
  }

  // ── Footer ─────────────────────────────────────────────────────────────────
  if (!args.write) {
    console.log(
      `\n  ${C.dim}Run with --write to apply.` +
      `  Token file patch must be pasted manually; typography config is merged automatically.${C.reset}\n`,
    );
  } else {
    console.log();
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
