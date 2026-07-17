// Copyright (c) 2025 Amrutha Kollu. All rights reserved.
// Licensed under the Functional Source License, Version 1.1 (FSL-1.1-MIT) — see LICENSE for details.

/**
 * Deterministic value extractors for Figma node trees.
 *
 * Every function here runs BEFORE the AI model sees any data.  The values
 * they return are injected into the generation prompt as resolved facts so
 * the AI never has to infer spacing, icon sizes, border radii, or variant
 * coverage from sparse JSON.
 *
 * All functions accept `Record<string, unknown>` rather than the typed
 * FigmaNode interface so they can be called on raw API responses, trimmed
 * node trees, or sub-nodes without a cast at every call-site.
 */

// ─── Spacing ──────────────────────────────────────────────────────────────────

export interface ResolvedSpacingEntry {
  containerName: string;
  itemSpacing:   number | null;   // flex gap between children
  paddingTop:    number | null;
  paddingBottom: number | null;
  paddingLeft:   number | null;
  paddingRight:  number | null;
}

/**
 * Recursively walks the full Figma node tree and collects gap/padding values
 * from every NAMED container that has at least one non-zero spacing property.
 *
 * Skips:
 *   - INSTANCE nodes  — nested components own their spacing
 *   - Variant-selector frames  — e.g. "Size=MD, Type=Primary" are layout
 *     metadata, not component structure; their spacing is not design intent
 *
 * Must run BEFORE trimNode so inner container gaps (e.g. "Icon + Label" at
 * depth 4) are not lost.
 */
export function extractSpacingEntries(
  node:  Record<string, unknown>,
  depth = 0,
  seen:  Map<string, ResolvedSpacingEntry> = new Map(),
): Map<string, ResolvedSpacingEntry> {
  if (depth > 6) return seen;

  const name = String(node['name'] ?? '').trim();
  const iS   = node['itemSpacing']   !== undefined ? Number(node['itemSpacing'])   : null;
  const pT   = node['paddingTop']    !== undefined ? Number(node['paddingTop'])    : null;
  const pB   = node['paddingBottom'] !== undefined ? Number(node['paddingBottom']) : null;
  const pL   = node['paddingLeft']   !== undefined ? Number(node['paddingLeft'])   : null;
  const pR   = node['paddingRight']  !== undefined ? Number(node['paddingRight'])  : null;

  const hasSpacing       = [iS, pT, pB, pL, pR].some((v) => v !== null && v > 0);
  const isVariantWrapper = /Size=|Type=|State=|Style=/.test(name);

  if (hasSpacing && name && !isVariantWrapper && !seen.has(name)) {
    seen.set(name, {
      containerName: name,
      itemSpacing: iS, paddingTop: pT, paddingBottom: pB, paddingLeft: pL, paddingRight: pR,
    });
  }

  const children = node['children'] as Record<string, unknown>[] | undefined;
  for (const child of children ?? []) {
    if (child['type'] === 'INSTANCE') continue;
    extractSpacingEntries(child, depth + 1, seen);
  }
  return seen;
}

/**
 * Formats spacing entries as a concise human-readable block for the prompt.
 * Placed before the raw Figma JSON so the AI reads exact gap/padding values
 * before scanning the tree.
 */
export function buildSpacingSummary(
  entries: Map<string, ResolvedSpacingEntry>,
): string {
  const lines: string[] = [];

  for (const e of entries.values()) {
    const parts: string[] = [];
    if (e.itemSpacing !== null && e.itemSpacing > 0)
      parts.push(`gap: ${e.itemSpacing}px`);

    const pyVal = e.paddingTop !== null && e.paddingTop === e.paddingBottom
      ? e.paddingTop : null;
    const pxVal = e.paddingLeft !== null && e.paddingLeft === e.paddingRight
      ? e.paddingLeft : null;

    if (pyVal !== null && pyVal > 0)
      parts.push(`py: ${pyVal}px`);
    else {
      if (e.paddingTop    !== null && e.paddingTop    > 0) parts.push(`pt: ${e.paddingTop}px`);
      if (e.paddingBottom !== null && e.paddingBottom > 0) parts.push(`pb: ${e.paddingBottom}px`);
    }
    if (pxVal !== null && pxVal > 0)
      parts.push(`px: ${pxVal}px`);
    else {
      if (e.paddingLeft  !== null && e.paddingLeft  > 0) parts.push(`pl: ${e.paddingLeft}px`);
      if (e.paddingRight !== null && e.paddingRight > 0) parts.push(`pr: ${e.paddingRight}px`);
    }

    if (parts.length > 0)
      lines.push(`  "${e.containerName}": ${parts.join(', ')}`);
  }

  return lines.length > 0
    ? `\nResolved spacing from Figma container layers (exact values — do NOT change):\n${lines.join('\n')}\n`
    : '';
}

// ─── Icon sizes ───────────────────────────────────────────────────────────────

export interface ResolvedIconSize {
  nodeName: string;
  nodeType: string;
  width:    number;
  height:   number;
}

/**
 * Recursively extracts exact rendered sizes of icon/vector nodes from
 * `absoluteBoundingBox`.
 *
 * Captures:
 *   - VECTOR and BOOLEAN_OPERATION  (SVG path data nodes)
 *   - FRAME/INSTANCE/COMPONENT whose name contains icon-related keywords AND
 *     whose bounding box is ≤ 64px (larger frames are layout containers)
 *
 * Excludes composite layout groups like "Icon + Label" (name contains " + ")
 * because those are containers of multiple elements, not single icon glyphs.
 *
 * Skips INSTANCE children — nested components own their icon sizes.
 */
export function extractIconSizes(
  node:  Record<string, unknown>,
  depth = 0,
  seen:  Map<string, ResolvedIconSize> = new Map(),
): Map<string, ResolvedIconSize> {
  if (depth > 6) return seen;

  const name = String(node['name'] ?? '').trim();
  const type = String(node['type'] ?? '');

  const isVectorNode    = ['VECTOR', 'BOOLEAN_OPERATION'].includes(type);
  const isCompositeGroup = name.includes(' + ');
  const isIconFrame     = !isCompositeGroup &&
    ['FRAME', 'INSTANCE', 'COMPONENT'].includes(type) &&
    /icon|close|dismiss|arrow|chevron|caret|check|cross|plus|minus|trash|edit|search|bell|star|heart/i
      .test(name);

  if ((isVectorNode || isIconFrame) && node['absoluteBoundingBox']) {
    const box = node['absoluteBoundingBox'] as { width: number; height: number };
    const w   = Math.round(box.width);
    const h   = Math.round(box.height);
    if (w > 0 && h > 0 && w <= 64 && h <= 64 && !seen.has(name)) {
      seen.set(name, { nodeName: name, nodeType: type, width: w, height: h });
    }
  }

  const children = node['children'] as Record<string, unknown>[] | undefined;
  for (const child of children ?? []) {
    if (child['type'] === 'INSTANCE') continue;
    extractIconSizes(child, depth + 1, seen);
  }
  return seen;
}

/**
 * Formats icon sizes as a concise block for the prompt.
 * Placed before the Figma JSON so the AI never defaults to 20px for icons.
 */
export function buildIconSizesSummary(
  icons: Map<string, ResolvedIconSize>,
): string {
  if (icons.size === 0) return '';
  const lines = [...icons.values()].map(
    (ic) => `  "${ic.nodeName}" (${ic.nodeType}): ${ic.width}×${ic.height}px`,
  );
  return (
    `\nIcon/vector sizes from Figma (exact — DO NOT default to 20px):\n` +
    `  Use these pixel values as the CSS width/height of the SVG element.\n` +
    lines.join('\n') + '\n'
  );
}

// ─── Corner radii ─────────────────────────────────────────────────────────────

/**
 * Collects all unique non-zero `cornerRadius` values from COMPONENT and
 * non-root FRAME nodes.
 *
 * Skips:
 *   - COMPONENT_SET at depth 0  (grouping boundary, no visual radius)
 *   - FRAME at depth 0          (canvas wrapper with decorative radius)
 *   - INSTANCE nodes            (nested sub-components own their radius)
 *
 * These values are used by the audit to verify that every cornerRadius from
 * Figma appears in the component code as a CSS string literal ('6px'), not
 * as a bare number that MUI would multiply by theme.shape.borderRadius.
 */
export function extractCornerRadii(
  node:  Record<string, unknown>,
  depth = 0,
  seen:  Set<number> = new Set(),
): Set<number> {
  if (depth > 6) return seen;

  const type = String(node['type'] ?? '');
  const isVisual =
    type === 'COMPONENT' ||
    (type === 'FRAME' && depth > 0);

  if (isVisual && typeof node['cornerRadius'] === 'number' && node['cornerRadius'] > 0) {
    seen.add(Math.round(node['cornerRadius'] as number));
  }

  const children = node['children'] as Record<string, unknown>[] | undefined;
  for (const child of children ?? []) {
    if (child['type'] === 'INSTANCE') continue;
    extractCornerRadii(child, depth + 1, seen);
  }
  return seen;
}

// ─── Variant dimensions ───────────────────────────────────────────────────────

/**
 * Parses ALL variant names from a Figma component set into a dimension →
 * values map.
 *
 * @example
 * Input:  ["Type=Neutral, Size=SM", "Type=Success, Size=MD"]
 * Output: Map { "Type" => ["Neutral","Success"], "Size" => ["SM","MD"] }
 *
 * This map is injected into both the component and stories prompts as an
 * explicit "MUST include ALL of these" block, ensuring the AI covers every
 * variant — not just those visible in the representative sample.
 */
export function buildVariantDimensionMap(
  variantNames: string[],
): Map<string, string[]> {
  const dims = new Map<string, string[]>();
  for (const name of variantNames) {
    for (const part of name.split(',')) {
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      const key = part.slice(0, eq).trim();
      const val = part.slice(eq + 1).trim();
      if (!dims.has(key)) dims.set(key, []);
      if (!dims.get(key)!.includes(val)) dims.get(key)!.push(val);
    }
  }
  return dims;
}

/**
 * Formats the variant dimension map as a human-readable block for the prompt.
 * Tells the AI the full set of values for every dimension so it cannot miss
 * values that weren't represented in the 13-24 representative variants.
 */
export function buildVariantDimensionBlock(
  dims: Map<string, string[]>,
): string {
  if (dims.size === 0) return '';
  const lines = [...dims.entries()].map(
    ([k, vs]) => `  ${k}:  ${vs.map((v) => `"${v}"`).join(' | ')}`,
  );
  return (
    `\nVARIANT DIMENSIONS — ALL values below exist in Figma and MUST be covered:\n` +
    `(TypeScript union types and story exports must include every value listed)\n` +
    lines.join('\n') + '\n'
  );
}

// ─── Representative variant selection ────────────────────────────────────────

/**
 * Selects a representative subset of variants from a large component set.
 * Used when the full variant list exceeds MAX_REPS — sending all variants to
 * the AI wastes context on near-identical states.
 *
 * Algorithm:
 *   A. Every value of the primary dimension (Type/Color/Variant) in default state
 *   B. Every size in default state
 *   C. Every style value (Icon Only, Split…) in default state
 *   D. Key interaction states: Disabled, Hover, Focus
 *   E. Last primary-value Disabled (often the most visually distinct case)
 *
 * The primary dimension cap is bypassed: every primary value always gets a
 * representative regardless of how many have already been selected.  This
 * prevents complex components from silently dropping entire input types.
 */
export function selectRepresentativeVariants(
  children: Record<string, unknown>[],
): Record<string, unknown>[] {
  const MAX_REPS = 24;
  if (children.length <= MAX_REPS) return children;

  type PropMap = Record<string, string>;

  const parsed: Array<{ name: string; props: PropMap; node: Record<string, unknown> }> = [];
  for (const child of children) {
    const name  = String(child['name'] ?? '');
    const props: PropMap = {};
    for (const part of name.split(',')) {
      const eq = part.indexOf('=');
      if (eq > 0) props[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
    if (Object.keys(props).length > 0) parsed.push({ name, props, node: child });
  }
  if (parsed.length === 0) return children.slice(0, MAX_REPS);

  const dims = new Map<string, string[]>();
  for (const { props } of parsed) {
    for (const [k, v] of Object.entries(props)) {
      if (!dims.has(k)) dims.set(k, []);
      if (!dims.get(k)!.includes(v)) dims.get(k)!.push(v);
    }
  }

  const stateDim   = [...dims.keys()].find((k) => /^state$/i.test(k));
  const sizeDim    = [...dims.keys()].find((k) => /^size$/i.test(k));
  const styleDim   = [...dims.keys()].find((k) => /^style$/i.test(k));
  const primaryDim = [...dims.keys()]
    .filter((k) => k !== stateDim && k !== sizeDim && k !== styleDim)
    .sort((a, b) => dims.get(b)!.length - dims.get(a)!.length)[0];

  const defaultState = stateDim
    ? (dims.get(stateDim)!.find((v) => /^default$/i.test(v)) ?? dims.get(stateDim)![0])
    : undefined;
  const firstSize    = sizeDim   ? dims.get(sizeDim)![0]    : undefined;
  const firstStyle   = styleDim  ? dims.get(styleDim)![0]   : undefined;
  const firstPrimary = primaryDim ? dims.get(primaryDim)![0] : undefined;

  const selected = new Map<string, Record<string, unknown>>();

  const pick = (matcher: (p: PropMap) => boolean, bypassCap = false): void => {
    if (!bypassCap && selected.size >= MAX_REPS) return;
    const found = parsed.find(({ name, props }) => !selected.has(name) && matcher(props));
    if (found) selected.set(found.name, found.node);
  };

  // A — every primary-dimension value (bypass cap)
  if (primaryDim) {
    for (const val of dims.get(primaryDim)!) {
      pick((p) =>
        p[primaryDim] === val &&
        (!stateDim  || p[stateDim]  === defaultState) &&
        (!sizeDim   || !firstSize   || p[sizeDim]   === firstSize) &&
        (!styleDim  || !firstStyle  || p[styleDim]  === firstStyle),
        true,
      );
    }
  }
  // B — each size in default state
  if (sizeDim) {
    for (const size of dims.get(sizeDim)!) {
      pick((p) =>
        p[sizeDim] === size &&
        (!stateDim   || p[stateDim]   === defaultState) &&
        (!primaryDim || !firstPrimary || p[primaryDim] === firstPrimary) &&
        (!styleDim   || !firstStyle   || p[styleDim]   === firstStyle),
      );
    }
  }
  // C — each style value
  if (styleDim) {
    for (const style of dims.get(styleDim)!) {
      pick((p) =>
        p[styleDim] === style &&
        (!stateDim   || p[stateDim]   === defaultState) &&
        (!primaryDim || !firstPrimary || p[primaryDim] === firstPrimary) &&
        (!sizeDim    || !firstSize    || p[sizeDim]    === firstSize),
      );
    }
  }
  // D — Disabled, Hover, Focus
  if (stateDim) {
    for (const state of dims.get(stateDim)!.filter((s) => /disabled|hover|focus/i.test(s))) {
      pick((p) =>
        p[stateDim] === state &&
        (!primaryDim || !firstPrimary || p[primaryDim] === firstPrimary) &&
        (!sizeDim    || !firstSize    || p[sizeDim]    === firstSize) &&
        (!styleDim   || !firstStyle   || p[styleDim]   === firstStyle),
      );
    }
    // E — last primary + Disabled
    const lastPrimary = primaryDim ? dims.get(primaryDim)!.at(-1) : undefined;
    if (lastPrimary && lastPrimary !== firstPrimary) {
      const disabledState = dims.get(stateDim)!.find((s) => /disabled/i.test(s));
      if (disabledState) {
        pick((p) => p[stateDim!] === disabledState && p[primaryDim!] === lastPrimary);
      }
    }
  }

  return selected.size > 0 ? [...selected.values()] : children.slice(0, MAX_REPS);
}

// ─── Spec serialisation helpers ───────────────────────────────────────────────

/**
 * The machine-readable record written to ComponentName.fixel.json alongside
 * each generated component.  Committed to git so PR diffs show design changes,
 * and read by `fixel verify` for offline drift detection.
 */
export interface FixelSpec {
  /**
   * Spec format version.  Absent on files generated before versioning was
   * introduced — treat those as v0 legacy.  Not written by buildSpec() yet;
   * will be set once the first breaking spec change warrants a version bump.
   */
  version?:     number; // absent = v0 (pre-versioning legacy)
  figmaFile:    string;
  figmaNode:    string;
  generatedAt:  string;
  resolvedTextStyles: Array<{
    fontSize:   number;
    fontWeight: number;
    token:      string;
    lineHeight: string;
  }>;
  resolvedSpacing: Array<{
    containerName: string;
    itemSpacing:   number | null;
    paddingTop:    number | null;
    paddingBottom: number | null;
    paddingLeft:   number | null;
    paddingRight:  number | null;
  }>;
  resolvedIconSizes: Array<{
    nodeName: string;
    nodeType: string;
    width:    number;
    height:   number;
  }>;
  resolvedCornerRadii: number[];
}

/** Serialises extracted values into a FixelSpec for writing to disk. */
export function buildSpec(opts: {
  figmaFile:     string;
  figmaNode:     string;
  textStyles:    Array<{ fontSize: number; fontWeight: number; token: string; lineHeight: string }>;
  spacingEntries: Map<string, ResolvedSpacingEntry>;
  iconSizes:      Map<string, ResolvedIconSize>;
  cornerRadii:    Set<number>;
}): FixelSpec {
  return {
    figmaFile:    opts.figmaFile,
    figmaNode:    opts.figmaNode,
    generatedAt:  new Date().toISOString(),
    resolvedTextStyles:  opts.textStyles,
    resolvedSpacing:     [...opts.spacingEntries.values()],
    resolvedIconSizes:   [...opts.iconSizes.values()],
    resolvedCornerRadii: [...opts.cornerRadii].sort((a, b) => a - b),
  };
}
