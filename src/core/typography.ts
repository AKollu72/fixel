// Copyright (c) 2025 Amrutha Kollu. All rights reserved.
// Licensed under the Functional Source License, Version 1.1 (FSL-1.1-MIT) — see LICENSE for details.

import { FixelConfigError } from './config';
import type { TypographyScale, TypographyScaleEntry } from './config';

// ─── Resolution ───────────────────────────────────────────────────────────────

/**
 * Resolves a (fontSize, fontWeight) pair to a typography token entry using the
 * scale defined in fixel.config.json.
 *
 * Lookup order (first match wins):
 *   1. Exact key   — "12/500"   matches fontSize=12, fontWeight=500 only
 *   2. Any-weight  — "12/any"   matches fontSize=12 at any fontWeight
 *   3. undefined   — no entry covers this combination (caller decides fallback)
 *
 * Why exact-then-any instead of range comparisons:
 *   Hard-coded range guards (e.g. `if (fontSize >= 14)`) bake one project's
 *   scale boundaries into the tool and break for any other scale.
 *   Exact keys are user-configured — if a project uses 15px body text they
 *   add "15/400" to their scale and it works without touching fixel.
 *   Range logic can still be expressed: supply only "any"-weight entries for
 *   large font sizes that are always bold (e.g. "34/any" covers all H1 weights).
 */
export function resolveTypographyToken(
  fontSize:   number,
  fontWeight: number,
  scale:      TypographyScale,
): TypographyScaleEntry {
  // 1. Exact match
  const exact = scale[`${fontSize}/${fontWeight}`];
  if (exact) return exact;

  // 2. Any-weight wildcard
  const anyWeight = scale[`${fontSize}/any`];
  if (anyWeight) return anyWeight;

  // 3. No match — surface a config error immediately.
  //    Continuing with a missing token would silently produce wrong typography
  //    in generated components and false-positive drift errors in verify.
  throw new FixelConfigError(
    `No typography scale entry found for fontSize=${fontSize} fontWeight=${fontWeight}.\n` +
    `  Add one of the following to the typography.scale section of fixel.config.json:\n\n` +
    `    "${fontSize}/${fontWeight}": { "token": "YOUR_TOKEN", "lineHeight": "16px" }\n` +
    `  or, to match this font size at any weight:\n` +
    `    "${fontSize}/any":          { "token": "YOUR_TOKEN", "lineHeight": "16px" }\n\n` +
    `  See your project's typography definition for the correct token name and line-height.`,
  );
}

// ─── Text-style extraction ────────────────────────────────────────────────────

/**
 * A typography token resolved from a single Figma TEXT node.
 * Every field comes from deterministic lookup — nothing is inferred.
 */
export interface ResolvedTextStyle {
  fontSize:     number;
  fontWeight:   number;
  /** Figma's raw lineHeightPx for this node (used as fallback if token has no lineHeight). */
  lineHeightPx: number;
  /** Token name from the scale, e.g. "MD_Medium". */
  token:        string;
  /** The lineHeight value from the scale entry, e.g. "16px". */
  lineHeight:   string;
}

/**
 * Recursively walks a Figma node tree and returns one ResolvedTextStyle per
 * unique token found.  Duplicate tokens (same fontSize+fontWeight in multiple
 * text nodes) are collapsed — the component prompt only needs to know which
 * variants are present, not how many times each appears.
 *
 * TEXT nodes inside INSTANCE children are skipped: nested component instances
 * own their own typography and should not generate false-positive verify checks
 * on the parent component.
 *
 * @param node   Any FigmaNode — the function recurses into children automatically.
 * @param scale  The resolved typography scale from fixel.config.json.
 * @param seen   Internal dedup set — callers should omit this argument.
 */
export function extractTextStyles(
  node:   Record<string, unknown>,
  scale:  TypographyScale,
  seen:   Map<string, ResolvedTextStyle> = new Map(),
): ResolvedTextStyle[] {
  if (node['type'] === 'TEXT' && node['style']) {
    const s          = node['style'] as Record<string, unknown>;
    const fontSize   = Number(s['fontSize']    ?? 14);
    const fontWeight = Number(s['fontWeight']  ?? 400);
    const lhPx       = Number(s['lineHeightPx'] ?? 0);

    // resolveTypographyToken throws FixelConfigError when no match is found,
    // so entry is always a valid scale entry from this point forward.
    const entry = resolveTypographyToken(fontSize, fontWeight, scale);

    if (!seen.has(entry.token)) {
      seen.set(entry.token, {
        fontSize,
        fontWeight,
        lineHeightPx: lhPx,
        token:        entry.token,
        lineHeight:   entry.lineHeight,
      });
    }
  }

  for (const child of (node['children'] as Record<string, unknown>[] | undefined) ?? []) {
    // Do not walk into INSTANCE nodes — their typography belongs to the
    // sub-component, not the component being generated/verified.
    if (child['type'] === 'INSTANCE') continue;
    extractTextStyles(child, scale, seen);
  }

  return [...seen.values()];
}

// ─── Prompt helpers ───────────────────────────────────────────────────────────

/**
 * Builds the resolved-typography block injected at the top of the component
 * generation prompt.
 *
 * Placing this above the raw Figma JSON means the AI reads the correct token
 * name before it has a chance to infer one from the data.  It is the primary
 * guard against the "MD button uses LG_Medium" class of typography error.
 *
 * Returns an empty string when no text styles were found, so callers can
 * concatenate unconditionally.
 */
export function buildTypographySummary(styles: ResolvedTextStyle[]): string {
  if (styles.length === 0) return '';

  const lines = dedupeByToken(styles).map(
    (s) =>
      `  fontSize=${s.fontSize} fontWeight=${s.fontWeight}` +
      ` → use variant="${s.token}" (lineHeight: ${s.lineHeight})`,
  );

  return (
    `\nResolved typography tokens (read _resolvedTypographyToken on each TEXT node ` +
    `— do NOT infer from font size or name):\n` +
    lines.join('\n') +
    '\n'
  );
}

/**
 * Formats resolved text styles as a Markdown lookup table for injection into
 * the system prompt.  Shown once per session (cached via prompt caching) so
 * the AI always has the full project scale in context.
 *
 * Generating this table from fixel.config.json at runtime means it stays
 * correct as the design system evolves, rather than requiring manual updates
 * to a hardcoded prompt template.
 */
export function buildTypographyTable(scale: TypographyScale): string {
  const entries = Object.entries(scale);
  if (entries.length === 0) return '';

  const rows = entries
    .map(([key, entry]) => {
      const [fsSuffix, fwSuffix] = key.split('/');
      const fsLabel = `${fsSuffix}px`;
      const fwLabel = fwSuffix === 'any' ? 'any' : fwSuffix;
      return `| ${fsLabel.padEnd(8)} | ${fwLabel.padEnd(10)} | ${entry.token.padEnd(20)} | ${entry.lineHeight.padEnd(10)} |`;
    });

  return [
    '\nTYPOGRAPHY SCALE (from fixel.config.json — use these values exactly):',
    '| fontSize | fontWeight | token                | lineHeight |',
    '|----------|------------|----------------------|------------|',
    ...rows,
    '',
    'The lineHeight is already baked into each variant definition.',
    'DO NOT add lineHeight to any Typography sx override.',
    '',
  ].join('\n');
}

// ─── Spec helpers (used by generate + verify) ─────────────────────────────────

/**
 * Returns the subset of ResolvedTextStyles that would be written to
 * ComponentName.fixel.json — one entry per unique token, sorted
 * deterministically so the spec file produces stable git diffs.
 */
export function toSpecTextStyles(
  styles: ResolvedTextStyle[],
): Array<{ fontSize: number; fontWeight: number; token: string; lineHeight: string }> {
  return dedupeByToken(styles)
    .sort((a, b) => a.token.localeCompare(b.token))
    .map(({ fontSize, fontWeight, token, lineHeight }) => ({
      fontSize,
      fontWeight,
      token,
      lineHeight,
    }));
}

// ─── Token naming helpers ─────────────────────────────────────────────────────

/**
 * Converts a typography token name to kebab-case for Tailwind class lookups.
 * Handles camelCase (bodySm → body-sm), PascalCase+underscore (LG_Bold → lg-bold),
 * and UPPER_UNDERSCORE (MD_Medium → md-medium).
 */
export function tokenToKebab(token: string): string {
  return token
    .replace(/_/g, '-')
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Returns styles with duplicate tokens removed (keeps first occurrence). */
function dedupeByToken(styles: ResolvedTextStyle[]): ResolvedTextStyle[] {
  const seen = new Set<string>();
  return styles.filter(({ token }) => {
    if (seen.has(token)) return false;
    seen.add(token);
    return true;
  });
}
