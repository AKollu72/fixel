// Copyright (c) 2025 Amrutha Kollu. All rights reserved.
// Licensed under the Functional Source License, Version 1.1 (FSL-1.1-MIT) — see LICENSE for details.

/**
 * Shared drift-check types and logic used by fixel verify and fixel annotate.
 *
 * Extracted here so both commands run identical comparisons.  Only genuinely
 * shared code lives here; command-specific behaviour stays in the CLI files.
 */

import type { ResolvedConfig }                              from './config';
import { auditCode }                                        from './audit';
import { getOverride, type Override, type OverridesFile }   from './overrides';
import type { FixelSpec }                                   from './extractors';
import { tokenToKebab }                                     from './typography';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * pass     — check passed cleanly.
 * warn     — check failed but is advisory only (spacing, icon sizes).
 * fail     — check failed and is a blocking error.
 * override — check failed but has a registered entry in fixel.overrides.json.
 *            Does not affect component status or exit code.
 */
export type CheckStatus = 'pass' | 'warn' | 'fail' | 'override';

export interface CheckResult {
  label:         string;
  figmaValue:    string;
  status:        CheckStatus;
  detail:        string;
  /**
   * Stable identifier for --write-overrides.
   * Absent for anti-pattern audit checks (use // fixel-ignore for those).
   */
  overrideKey?:  string;
  /** Populated when status === 'override'. */
  overrideInfo?: Override;
}

// ─── Value-in-code helpers ────────────────────────────────────────────────────

/**
 * Returns true when a pixel value is expressed in the code in any of the
 * common CSS-in-JS forms:
 *   '16px'   "16px"   16 (bare number in sx)   px: 2 (MUI 8px-grid shorthand)
 */
export function valueInCode(code: string, px: number): boolean {
  if (code.includes(`'${px}px'`) || code.includes(`"${px}px"`)) return true;
  if (new RegExp(`[:\\s]\\s*${px}[^0-9.]`).test(code))          return true;
  if (px % 8 === 0) {
    const u = px / 8;
    if (
      code.includes(`px: ${u}`) || code.includes(`py: ${u}`) ||
      code.includes(`p: ${u}`)  || code.includes(`gap: ${u}`)
    ) return true;
  }
  return false;
}

/**
 * Tailwind-aware spacing check: accepts arbitrary values (gap-[16px]) and
 * named 4px-grid utilities (gap-4) for gap/padding prefixes.
 */
function tailwindSpacingInCode(code: string, px: number): boolean {
  for (const prefix of ['gap', 'p', 'px', 'py', 'pt', 'pr', 'pb', 'pl']) {
    if (code.includes(`${prefix}-[${px}px]`)) return true;
    if (px % 4 === 0) {
      const n = px / 4;
      if (new RegExp(`\\b${prefix}-${n}\\b`).test(code)) return true;
    }
  }
  if (code.includes(`'${px}px'`) || code.includes(`"${px}px"`)) return true;
  return false;
}

const TAILWIND_ROUNDED: Record<number, string> = {
  2:    'rounded-sm',
  4:    'rounded',
  6:    'rounded-md',
  8:    'rounded-lg',
  12:   'rounded-xl',
  16:   'rounded-2xl',
  24:   'rounded-3xl',
  9999: 'rounded-full',
};

/**
 * Returns the first Tailwind rounded utility found for this radius, or null.
 * Accepts: rounded-[Npx] (arbitrary), named utilities, rounded-full for pill (>=100px).
 */
function tailwindRadiusFound(code: string, radius: number): string | null {
  if (code.includes(`rounded-[${radius}px]`)) return `rounded-[${radius}px]`;
  if (radius >= 100 && code.includes('rounded-full')) return 'rounded-full';
  const named = TAILWIND_ROUNDED[radius];
  if (named && code.includes(named)) return named;
  return null;
}

// ─── Spec-based audit ─────────────────────────────────────────────────────────

/**
 * Compares the current component source against its stored fixel.json spec.
 * No network calls — uses only values recorded at generation time.
 *
 * Checks:
 *   1. Typography   — MUI: variant="TOKEN" present; Tailwind: tailwindClass    (error)
 *                     present in code (e.g. "typography-label-xs").
 *   2. Spacing      — every gap/padding value must appear in the code          (warn)
 *   3. Icon sizes   — every icon must use its Figma px dimensions              (warn)
 *   4. Raw hex      — no raw hex string literals in the code                   (error)
 *   5. Border-radius — cornerRadius values as CSS string literals              (error)
 *
 * When a check's overrideKey has a matching entry in `overrides`, the check
 * is reported as 'override' rather than 'fail' or 'warn'.  Override checks
 * are excluded from componentStatus() and do not affect the exit code.
 */
export function auditAgainstSpec(
  code:      string,
  spec:      FixelSpec,
  overrides: OverridesFile,
  component: string,
  config:    ResolvedConfig,
): CheckResult[] {
  const checks: CheckResult[] = [];

  // 1. Typography — framework-aware
  for (const s of spec.resolvedTextStyles) {
    let found:    boolean;
    let tokenRef: string;

    if (config.framework === 'tailwind') {
      // Tailwind typography is a CSS class, e.g. "typography-label-xs"
      const cls = config.typography.tailwindClass.replace('{token}', tokenToKebab(s.token));
      found    = code.includes(cls);
      tokenRef = cls;
    } else {
      // MUI and generic: look for variant="TOKEN" or assignment/prop = "TOKEN"
      found    = new RegExp(`(?:variant=|[=:]\\s*)["'\`]${s.token}["'\`]`).test(code);
      tokenRef = `variant="${s.token}"`;
    }

    const overrideKey = `typography.${s.token}`;
    const ov          = getOverride(overrides, component, overrideKey);
    checks.push({
      label:       `Typography  ${s.fontSize}px / weight ${s.fontWeight}`,
      figmaValue:  s.token,
      status:      found ? 'pass' : ov ? 'override' : 'fail',
      detail:      found
        ? `${tokenRef} ✓`
        : ov
        ? `${tokenRef} not found — override: ${ov.reason}`
        : `${tokenRef} not found — wrong or removed typography variant`,
      overrideKey,
      ...(ov ? { overrideInfo: ov } : {}),
    });
  }

  // 2. Spacing
  type SpacingTuple = [label: string, key: string, val: number | null];
  for (const e of spec.resolvedSpacing ?? []) {
    const pairs: SpacingTuple[] = [
      [`gap "${e.containerName}"`,           `spacing.${e.containerName}.itemSpacing`,   e.itemSpacing],
      [`paddingTop "${e.containerName}"`,    `spacing.${e.containerName}.paddingTop`,    e.paddingTop],
      [`paddingBottom "${e.containerName}"`, `spacing.${e.containerName}.paddingBottom`, e.paddingBottom],
      [`paddingLeft "${e.containerName}"`,   `spacing.${e.containerName}.paddingLeft`,   e.paddingLeft],
      [`paddingRight "${e.containerName}"`,  `spacing.${e.containerName}.paddingRight`,  e.paddingRight],
    ];
    for (const [label, overrideKey, val] of pairs) {
      if (val === null || val === 0) continue;
      const found = config.framework === 'tailwind'
        ? tailwindSpacingInCode(code, val)
        : valueInCode(code, val);
      const ov    = getOverride(overrides, component, overrideKey);
      const failDetail = config.framework === 'tailwind'
        ? `${val}px not found — expected gap-[${val}px]${val % 4 === 0 ? ` or gap-${val / 4}` : ''} (or px-/py-/p- equivalent)`
        : `${val}px not found — may have changed or uses unrecognised shorthand`;
      checks.push({
        label:      `Spacing     ${label}`,
        figmaValue: `${val}px`,
        status:     found ? 'pass' : ov ? 'override' : 'warn',
        detail:     found
          ? `${val}px ✓`
          : ov
          ? `${val}px not found — override: ${ov.reason}`
          : failDetail,
        overrideKey,
        ...(ov ? { overrideInfo: ov } : {}),
      });
    }
  }

  // 3. Icon sizes
  for (const ic of spec.resolvedIconSizes ?? []) {
    const found       = valueInCode(code, ic.width) && valueInCode(code, ic.height);
    const overrideKey = `iconSize.${ic.nodeName}`;
    const ov          = getOverride(overrides, component, overrideKey);
    checks.push({
      label:      `Icon size   "${ic.nodeName}"`,
      figmaValue: `${ic.width}×${ic.height}px`,
      status:     found ? 'pass' : ov ? 'override' : 'warn',
      detail:     found
        ? `${ic.width}×${ic.height}px ✓`
        : ov
        ? `${ic.width}×${ic.height}px not confirmed — override: ${ov.reason}`
        : `${ic.width}×${ic.height}px not confirmed — may be defaulting to 20px`,
      overrideKey,
      ...(ov ? { overrideInfo: ov } : {}),
    });
  }

  // 4. Raw hex
  const hexMatch = code.match(/['"]#[0-9a-fA-F]{3,8}['"]/);
  const hexKey   = 'colors.rawHex';
  const hexOv    = getOverride(overrides, component, hexKey);
  checks.push({
    label:      'Colors      raw hex',
    figmaValue: 'none (all colors must use semantic tokens)',
    status:     hexMatch ? (hexOv ? 'override' : 'fail') : 'pass',
    detail:     hexMatch
      ? hexOv
      ? `${hexMatch[0]} found — override: ${hexOv.reason}`
      : `${hexMatch[0]} found — replace with a semantic token`
      : 'No raw hex values ✓',
    overrideKey: hexKey,
    ...(hexOv ? { overrideInfo: hexOv } : {}),
  });

  // 5. Border-radius
  for (const radius of spec.resolvedCornerRadii ?? []) {
    const overrideKey = `borderRadius.${radius}`;
    const ov          = getOverride(overrides, component, overrideKey);

    let radiusPasses: boolean;
    let passDetail:   string;
    let failDetail:   string;

    if (config.framework === 'tailwind') {
      const tw   = tailwindRadiusFound(code, radius);
      radiusPasses = tw !== null;
      passDetail   = tw !== null ? `${tw} ✓` : '';
      failDetail   = `rounded-[${radius}px] or rounded-full (pill) not found`;
    } else {
      radiusPasses = new RegExp(`['"\`]${radius}px['"\`]`).test(code);
      passDetail   = `'${radius}px' ✓`;
      failDetail   = `'${radius}px' not found as string — bare ${radius} renders as ${radius * 4}px in MUI sx (×4)`;
    }

    checks.push({
      label:      `Border-radius  ${radius}px`,
      figmaValue: `${radius}px`,
      status:     radiusPasses ? 'pass' : ov ? 'override' : 'fail',
      detail:     radiusPasses
        ? passDetail
        : ov
        ? `${radius}px not found — override: ${ov.reason}`
        : failDetail,
      overrideKey,
      ...(ov ? { overrideInfo: ov } : {}),
    });
  }

  return checks;
}

// ─── Combined drift + audit ───────────────────────────────────────────────────

/**
 * Runs the full check suite for a component: spec-based drift checks followed
 * by the static anti-pattern audit.  Returns the combined result list.
 *
 * Single entry point used by both `fixel verify` and `fixel annotate` so their
 * results are always identical — the same findings that fail CI also get posted
 * as Figma comments.
 */
export function runDriftChecks(
  code:      string,
  spec:      FixelSpec,
  overrides: OverridesFile,
  component: string,
  config:    ResolvedConfig,
): CheckResult[] {
  const checks = auditAgainstSpec(code, spec, overrides, component, config);

  for (const v of auditCode(code, config)) {
    checks.push({
      label:      `Audit [${v.pattern}]`,
      figmaValue: '',
      status:     v.severity === 'error' ? 'fail' : 'warn',
      detail:     `line ${v.line}: ${v.snippet.slice(0, 80)}`,
      // no overrideKey — use // fixel-ignore to suppress audit violations
    });
  }

  return checks;
}

// ─── Component status ─────────────────────────────────────────────────────────

/**
 * Derives the overall component status from its check results.
 * Override checks are excluded — they are intentional deviations and must not
 * block the build or trigger a Figma annotation.
 */
export function componentStatus(checks: CheckResult[]): CheckStatus {
  const active = checks.filter((c) => c.status !== 'override');
  if (active.some((c) => c.status === 'fail')) return 'fail';
  if (active.some((c) => c.status === 'warn')) return 'warn';
  return 'pass';
}
