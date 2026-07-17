// Copyright (c) 2025 Amrutha Kollu. All rights reserved.
// Licensed under the Functional Source License, Version 1.1 (FSL-1.1-MIT) — see LICENSE for details.

import * as fs   from 'node:fs';
import * as path from 'node:path';

import { FixelConfigError } from './config';
import type { ResolvedConfig } from './config';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * A single fill colour extracted from a Figma node tree,
 * plus the names of every node that carries it.
 */
export interface FillOccurrence {
  hex:       string;    // uppercase hex, e.g. "#2563EB" or "#2563EB80"
  opacity:   number;    // 0–1 effective fill opacity
  nodeNames: string[];  // Figma layer names that use this fill
}

/**
 * Three-way status of a Figma fill colour against the project's token file.
 *
 *   reachable    — hex is already exported from a semantic/constants export;
 *                  components can import it today.
 *   primitiveOnly — hex exists in a private primitive ramp (e.g. `brand[500]`)
 *                  but has no semantic alias — components cannot import primitives.
 *                  A semantic alias must be added before `fixel generate` will work.
 *   new          — hex is not in the token file at all; a new token is needed.
 */
export type FillStatus = 'reachable' | 'primitiveOnly' | 'new';

export interface ClassifiedFill {
  hex:    string;
  status: FillStatus;
  usedIn: string[];
}

export interface TokenSuggestion {
  hex:           string;
  suggestedName: string;   // full path per namingConvention, e.g. "semantic.badge.bg"
  usedIn:        string[];
  status:        FillStatus;
}

/**
 * Lookup index built from the project's token source file.
 * All hex values are stored uppercase (e.g. "#2563EB").
 */
export interface TokenIndex {
  /** Hex values exported from a semantic or constants object — usable in component code. */
  reachable:     Set<string>;
  /**
   * Hex values that appear only inside private primitive ramp declarations
   * and are not referenced by any semantic/constants export.
   * Components cannot import these directly.
   */
  primitiveOnly: Set<string>;
}

// ─── Fill extraction ──────────────────────────────────────────────────────────

/**
 * Recursively walks a Figma node tree and collects every unique SOLID fill,
 * mapping each hex value to the Figma layer names that carry it.
 *
 * Skips INSTANCE nodes — their fills belong to the sub-component definition,
 * not to the component being scanned.  This prevents inherited fills from
 * parent component sets from appearing as "missing tokens" for a leaf component.
 *
 * Semi-transparent fills (opacity < 1 or alpha < 1) are included and produce
 * an 8-digit hex (e.g. "#2563EB80").  These need distinct token entries from
 * their fully-opaque counterparts.
 */
export function extractFills(
  node:  Record<string, unknown>,
  depth = 0,
  out:   Map<string, FillOccurrence> = new Map(),
): Map<string, FillOccurrence> {
  if (depth > 8) return out;

  const fills = node['fills'] as Array<{
    type:    string;
    color?:  { r: number; g: number; b: number; a: number };
    opacity?: number;
  }> | undefined;

  for (const fill of fills ?? []) {
    if (fill.type !== 'SOLID' || !fill.color) continue;

    const { r, g, b, a } = fill.color;
    const opacity    = fill.opacity ?? 1;
    const effectiveA = Math.round(a * opacity * 255);

    const hexBody = [r, g, b]
      .map((v) => Math.round(v * 255).toString(16).padStart(2, '0'))
      .join('');
    const alphaHex = effectiveA < 255
      ? effectiveA.toString(16).padStart(2, '0')
      : '';
    const hex = `#${hexBody}${alphaHex}`.toUpperCase();

    const nodeName = String(node['name'] ?? '').trim();
    const existing  = out.get(hex);
    if (existing) {
      if (nodeName && !existing.nodeNames.includes(nodeName)) {
        existing.nodeNames.push(nodeName);
      }
    } else {
      out.set(hex, { hex, opacity, nodeNames: nodeName ? [nodeName] : [] });
    }
  }

  const children = node['children'] as Record<string, unknown>[] | undefined;
  for (const child of children ?? []) {
    if (child['type'] === 'INSTANCE') continue;
    extractFills(child, depth + 1, out);
  }

  return out;
}

// ─── Token file I/O ───────────────────────────────────────────────────────────

/**
 * Reads the project's token file from disk and returns its source text.
 * The path is resolved relative to the current working directory using
 * `config.tokens.file`.
 *
 * @throws {FixelConfigError} when the file does not exist at the configured path.
 */
export function readTokenFile(config: ResolvedConfig): string {
  const filePath = path.resolve(process.cwd(), config.tokens.file);
  if (!fs.existsSync(filePath)) {
    throw new FixelConfigError(
      `Token file not found at "${config.tokens.file}".\n` +
      `  Resolved to: ${filePath}\n` +
      `  Update tokens.file in fixel.config.json to point to your token file.`,
    );
  }
  return fs.readFileSync(filePath, 'utf8');
}

// ─── Token index building ─────────────────────────────────────────────────────

/**
 * Extracts the body of every `export const <name> = { ... }` declaration
 * whose name appears in `exportNames`, using a brace-depth counter.
 *
 * A lazy regex (`\{[\s\S]+?\}`) is NOT used here because semantic objects
 * contain nested sub-objects — the first closing brace it finds would belong
 * to an inner key, not the export itself.  The balanced-brace scanner walks
 * forward one character at a time and stops only when the depth returns to zero.
 *
 * Returns the concatenated bodies of all matched exports (multiple exports can
 * share a name in pathological files, though that's unusual).
 */
function extractExportedObjectsBody(source: string, exportNames: string[]): string {
  const chunks: string[] = [];

  for (const name of exportNames) {
    // Match `export const <name> = {` or `export const <name>: SomeType = {`
    const headRe = new RegExp(
      `export\\s+const\\s+${name}\\s*(?::[^=]+)?=\\s*\\{`,
      'g',
    );

    for (const head of source.matchAll(headRe)) {
      // The opening `{` is the last character of the matched header.
      const openIdx = (head.index ?? 0) + head[0].length - 1;
      const endIdx  = scanToMatchingBrace(source, openIdx);
      chunks.push(source.slice(openIdx, endIdx));
    }
  }

  return chunks.join('\n');
}

/**
 * Builds a map of `rampName[slot]` → uppercase hex string from all private
 * primitive ramp declarations found in the source.
 *
 * Primitive ramps are `const <name> = { 50: '#...', 100: '#...' }` or
 * `const <name>: ColorRamp = { ... }` — non-exported flat number-to-hex maps.
 * They are private by convention (not exported); components cannot import them.
 *
 * A lazy match is safe here: primitive ramps are flat (no nested objects),
 * so the first `};` is always the ramp's own terminator.
 */
function extractRampMap(source: string): Map<string, string> {
  const slotToHex = new Map<string, string>();

  // Match:  const primary: ColorScheme = { ... };
  //         const neutral = { ... };
  const rampRe     = /const\s+(\w+)\s*(?::\s*\w+\s*)?=\s*\{([\s\S]+?)\}\s*;/g;
  const rampSlotRe = /(\d+|main)\s*:\s*['"]#([0-9a-fA-F]{3,8})['"]/g;

  for (const rampMatch of source.matchAll(rampRe)) {
    const rampName = rampMatch[1];
    const rampBody = rampMatch[2];
    for (const slot of rampBody.matchAll(rampSlotRe)) {
      slotToHex.set(`${rampName}[${slot[1]}]`, `#${slot[2].toUpperCase()}`);
    }
  }

  return slotToHex;
}

/**
 * Builds a TokenIndex from the raw source of a `"typescript-object"` token file.
 *
 * The index distinguishes three populations of hex values:
 *
 *   reachable     — hex literals that appear directly inside the exported
 *                   semantic / constants objects, plus any primitive ramp
 *                   slots that those objects reference (e.g. `primary[500]`).
 *                   These can be imported by components today.
 *
 *   primitiveOnly — hex values that exist only inside private ramp declarations
 *                   and are NOT referenced by any exported object.  Components
 *                   cannot import these without a semantic alias.
 *
 * The `semanticExport` and `constantsExport` names from `config.tokens` drive
 * which declarations are considered "exported" — no hardcoded names.
 */
export function buildTokenIndex(source: string, config: ResolvedConfig): TokenIndex {
  const hexLiteralRe = /['"]#([0-9a-fA-F]{3,8})['"]/g;

  // 1. All hex values anywhere in the file.
  const allHexes = new Set<string>();
  for (const m of source.matchAll(hexLiteralRe)) {
    allHexes.add(`#${m[1].toUpperCase()}`);
  }

  // 2. Private ramp map: "primary[500]" → "#2563EB"
  const rampMap = extractRampMap(source);

  // 3. Extract the bodies of the configured semantic and constants exports.
  const exportNames  = [config.tokens.semanticExport, config.tokens.constantsExport];
  const exportedBody = extractExportedObjectsBody(source, exportNames);

  // 4. Hex values that appear directly inside the exported objects.
  const reachable = new Set<string>();
  for (const m of exportedBody.matchAll(hexLiteralRe)) {
    reachable.add(`#${m[1].toUpperCase()}`);
  }

  // 5. Ramp slots referenced from the exported objects: `primary[500]`, `neutral[main]`
  const referencedSlotRe = /(\w+)\[(\d+|main)\]/g;
  for (const ref of exportedBody.matchAll(referencedSlotRe)) {
    const key = `${ref[1]}[${ref[2]}]`;
    const hex = rampMap.get(key);
    if (hex) reachable.add(hex);
  }

  // 6. primitiveOnly = (all hexes in file) − (reachable hexes)
  const primitiveOnly = new Set<string>();
  for (const hex of allHexes) {
    if (!reachable.has(hex)) primitiveOnly.add(hex);
  }

  return { reachable, primitiveOnly };
}

// ─── Fill classification ──────────────────────────────────────────────────────

/**
 * Classifies each Figma fill against the token index, returning one
 * ClassifiedFill per unique hex value.
 *
 * The result is sorted so that already-reachable fills come first
 * (useful for rendering a "✓ already covered" section before the new-token
 * suggestions in `fixel scan` output).
 */
export function classifyFills(
  fills: Map<string, FillOccurrence>,
  index: TokenIndex,
): ClassifiedFill[] {
  const results: ClassifiedFill[] = [];

  for (const occ of fills.values()) {
    const status: FillStatus =
      index.reachable.has(occ.hex)     ? 'reachable'
      : index.primitiveOnly.has(occ.hex) ? 'primitiveOnly'
      : 'new';

    results.push({ hex: occ.hex, status, usedIn: occ.nodeNames });
  }

  // reachable first, then primitiveOnly, then new
  const ORDER: Record<FillStatus, number> = { reachable: 0, primitiveOnly: 1, new: 2 };
  return results.sort((a, b) => ORDER[a.status] - ORDER[b.status]);
}

// ─── Token name suggestion ────────────────────────────────────────────────────

/**
 * Suggests a semantic token name for a fill by analysing the Figma layer names
 * that use it and applying the project's naming convention.
 *
 * Role detection scans node names for common semantic keywords:
 *   bg / background  → "bg"
 *   fg / text / label → "fg"
 *   border / stroke  → "border"
 *   icon / glyph     → "icon"
 *   description / caption → "description"
 *
 * State detection appends a qualifier for interactive states:
 *   hover, active/pressed, focus, disabled, selected
 *
 * The detected role (with optional state suffix) is substituted into the
 * `{role}` placeholder of the naming convention from config.tokens.namingConvention.
 * The group name is substituted into `{group}`.
 *
 * Falls back to "color{ordinal+1}" when no role keyword is detected.
 *
 * @param occurrence   Fill data including the node names that use it.
 * @param group        Group name passed by the user (e.g. "badge", "alert").
 * @param ordinal      Zero-based index within the set of new fills (used for fallback names).
 * @param convention   Naming convention string, e.g. "semantic.{group}.{role}".
 */
export function suggestTokenName(
  occurrence: FillOccurrence,
  group:      string,
  ordinal:    number,
  convention: string,
): string {
  const names = occurrence.nodeNames.join(' ').toLowerCase();

  const role =
    /background|bg/.test(names)               ? 'bg'          :
    /foreground|fg|text|label|type/.test(names) ? 'fg'         :
    /border|stroke|outline/.test(names)        ? 'border'      :
    /icon|glyph/.test(names)                   ? 'icon'        :
    /description|subtitle|caption/.test(names) ? 'description' :
    null;

  const state =
    /hover/.test(names)           ? '.hover'    :
    /active|pressed/.test(names)  ? '.active'   :
    /focus/.test(names)           ? '.focus'    :
    /disabled/.test(names)        ? '.disabled' :
    /selected/.test(names)        ? '.selected' :
    '';

  // When no semantic keyword matched, walk the node names for a meaningful hint.
  // Skip generic Figma layer names (Frame, Rectangle, …) and variant props (State=hover).
  let resolvedRole: string;
  if (role !== null) {
    resolvedRole = `${role}${state}`;
  } else {
    const genericPat = /^(Frame|Rectangle|Group|Vector|Ellipse|Component|Instance|Union|Polygon|Section)\s*\d*$/i;
    const variantPat = /^[A-Za-z]+=.+/;
    const hint = occurrence.nodeNames
      .map(n => n.trim())
      .filter(n =>
        !genericPat.test(n) &&
        !variantPat.test(n) &&
        n.toLowerCase() !== group.toLowerCase() &&
        n.length > 0,
      )
      .map(n => n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24))
      .find(n => n.length > 0) ?? null;
    resolvedRole = hint ?? `color${ordinal + 1}`;
  }

  return convention
    .replace('{group}', group)
    .replace('{role}',  resolvedRole);
}

/**
 * Builds the full list of TokenSuggestions for a set of classified fills.
 * Only `new` and `primitiveOnly` fills get name suggestions — reachable fills
 * are included with their existing name left empty (callers use status to filter).
 */
export function buildSuggestions(
  classified: ClassifiedFill[],
  fills:      Map<string, FillOccurrence>,
  group:      string,
  config:     ResolvedConfig,
): TokenSuggestion[] {
  const convention = config.tokens.namingConvention;
  let ordinal = 0;

  return classified.map((cf) => {
    const occ  = fills.get(cf.hex) ?? { hex: cf.hex, opacity: 1, nodeNames: cf.usedIn };
    const name = cf.status !== 'reachable'
      ? suggestTokenName(occ, group, ordinal++, convention)
      : '';

    return {
      hex:           cf.hex,
      suggestedName: name,
      usedIn:        cf.usedIn,
      status:        cf.status,
    };
  });
}

// ─── Patch formatting ─────────────────────────────────────────────────────────

/**
 * Formats a ready-to-paste TypeScript patch for the user's token file.
 *
 * Only `new` tokens are included in the patch body — `primitiveOnly` tokens
 * already have hex values in the file and need a semantic alias added manually
 * (we can't safely determine which primitive key to reference).
 *
 * Output format (typescript-object):
 *
 *   // Add inside: export const semantic = { ... }
 *   badge: {
 *     // Background, Label
 *     bg: '#2563EB',
 *     // Border
 *     border: '#1D4ED8',
 *   },
 *
 * The leaf key is derived by stripping the convention prefix and group
 * from the suggested name:
 *   "semantic.badge.bg"      →  "bg"
 *   "semantic.badge.bg.hover" → "'bg.hover'" (quoted, since keys with dots
 *                               need quoting in TypeScript object literals)
 */
export function formatTokenPatch(
  suggestions: TokenSuggestion[],
  group:       string,
  config:      ResolvedConfig,
): string {
  const newTokens = suggestions.filter((s) => s.status === 'new');
  if (newTokens.length === 0) return '';

  const exportName = config.tokens.semanticExport;
  const lines: string[] = [
    `// Add inside: export const ${exportName} = { ... }`,
    `  ${group}: {`,
  ];

  for (const t of newTokens) {
    // e.g. "semantic.badge.bg.hover" → strip "semantic." and "badge."
    const leafKey = extractLeafKey(t.suggestedName, group, config.tokens.namingConvention);
    // Quote the key if it contains a dot (nested path — user decides the nesting structure)
    const keyStr  = leafKey.includes('.') ? `'${leafKey}'` : leafKey;
    const comment       = t.usedIn.slice(0, 3).join(', ');
    const isPlaceholder = /^color\d+$/.test(leafKey);
    if (comment) lines.push(`    // ${comment}`);
    if (isPlaceholder) lines.push(`    // placeholder — rename to a semantic role`);
    lines.push(`    ${keyStr}: '${t.hex}',`);
  }

  lines.push('  },');
  return lines.join('\n');
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * Scans forward from the `{` at `start` and returns the index immediately past
 * its matching `}`.  Skips string literals, template literals, and comments so
 * that braces inside them are never counted.
 *
 * Handles:
 *   Single / double quoted strings  'foo { bar }' → skipped entirely
 *   Template literals               `gap: ${n}px`  → `${...}` scanned recursively
 *   Line comments                   // { ignored }
 *   Block comments                  /* { ignored } *\/
 *
 * Returns `source.length` on unterminated input (malformed file guard).
 */
function scanToMatchingBrace(source: string, start: number): number {
  let depth = 1;
  let i     = start + 1;   // start just after the opening `{`

  while (i < source.length && depth > 0) {
    const ch = source[i];

    if      (ch === '{')                         { depth++; i++; }
    else if (ch === '}')                         { depth--; i++; }
    else if (ch === "'" || ch === '"')           { i = skipQuotedString(source, i, ch); }
    else if (ch === '`')                         { i = skipTemplateLiteral(source, i); }
    else if (ch === '/' && source[i + 1] === '/') {
      const eol = source.indexOf('\n', i + 2);
      i = eol === -1 ? source.length : eol + 1;
    }
    else if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
    }
    else { i++; }
  }

  return i;
}

/**
 * Advances past a single- or double-quoted string literal, honouring
 * backslash escapes.  Returns the index after the closing quote.
 */
function skipQuotedString(source: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if      (ch === '\\') { i += 2; }          // skip escaped character
    else if (ch === quote) { return i + 1; }    // past closing quote
    else                   { i++; }
  }
  return source.length;
}

/**
 * Advances past a template literal, including any nested `${...}` expressions.
 * Template expressions are scanned with `scanToMatchingBrace` so they handle
 * their own nested strings, templates, and comments correctly.
 * Returns the index after the closing backtick.
 */
function skipTemplateLiteral(source: string, start: number): number {
  let i = start + 1;   // start after opening backtick
  while (i < source.length) {
    const ch = source[i];
    if      (ch === '\\') { i += 2; }          // skip escaped character
    else if (ch === '`')  { return i + 1; }    // past closing backtick
    else if (ch === '$' && source[i + 1] === '{') {
      // source[i+1] is the `{` — scan to its matching `}` then continue
      i = scanToMatchingBrace(source, i + 1);
    }
    else { i++; }
  }
  return source.length;
}

/**
 * Extracts the leaf portion of a suggested token name by removing the
 * static prefix (everything before `{group}`) and the group segment itself.
 *
 * Examples (convention = "semantic.{group}.{role}"):
 *   "semantic.badge.bg"       → "bg"
 *   "semantic.badge.bg.hover" → "bg.hover"
 *   "tokens.badge.border"     → "border"
 *
 * Falls back to the full suggested name when the group cannot be located,
 * so callers always receive a non-empty string.
 */
function extractLeafKey(
  suggestedName: string,
  group:         string,
  convention:    string,
): string {
  // Build a prefix to strip: replace {group} with the actual group and {role} with ""
  // e.g. convention "semantic.{group}.{role}" → prefix "semantic.badge."
  // Strip `{role}` and everything after it, but NOT the dot immediately before it.
  // "semantic.{group}.{role}" → "semantic.badge." (trailing dot preserved)
  // Without the trailing dot, slice() would return ".bg" instead of "bg".
  const groupPrefix = convention
    .replace('{group}', group)
    .replace(/\{role\}.*$/, '');

  if (suggestedName.startsWith(groupPrefix)) {
    return suggestedName.slice(groupPrefix.length);
  }

  // Fallback: find the group segment manually
  const groupSeg = `.${group}.`;
  const idx      = suggestedName.indexOf(groupSeg);
  if (idx !== -1) {
    return suggestedName.slice(idx + groupSeg.length);
  }

  return suggestedName;
}
