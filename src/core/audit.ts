// Copyright (c) 2025 Amrutha Kollu. All rights reserved.
// Licensed under the Functional Source License, Version 1.1 (FSL-1.1-MIT) — see LICENSE for details.

import type { ResolvedConfig, ProhibitedPattern } from './config';

// ─── Public types ─────────────────────────────────────────────────────────────

/**
 * A single violation found by the anti-pattern scanner.
 *
 * `severity` controls whether the CLI blocks file writing:
 *   error   — file is NOT written; the user must fix this before generation succeeds
 *   warning — file IS written; a caution is printed for manual review
 */
export interface AuditViolation {
  /** The ProhibitedPattern identifier that triggered this violation. */
  pattern:    ProhibitedPattern;
  severity:   'error' | 'warning';
  /** 1-based line number in the generated code. */
  line:       number;
  /** 1-based column number of the match start on that line. */
  column:     number;
  /** The exact text that triggered the violation (≤ 120 chars). */
  snippet:    string;
  /** Human-readable explanation and concrete fix instruction. */
  suggestion: string;
}

// ─── Pattern definition (internal) ───────────────────────────────────────────

/**
 * Internal descriptor for a built-in pattern.
 *
 * `frameworks`:
 *   '*'           — always runs regardless of config.framework
 *   string[]      — only runs when config.framework is in the list
 *
 * `check` receives:
 *   stripped  — comment-stripped source (same length, same newlines — safe for index math)
 *   original  — original source (used to extract snippets and line context)
 *   config    — full resolved config
 *
 * It must never throw.  Return [] when nothing is found.
 */
interface PatternDef {
  id:         ProhibitedPattern;
  severity:   'error' | 'warning';
  frameworks: '*' | string[];
  check: (
    stripped: string,
    original: string,
    config:   ResolvedConfig,
  ) => AuditViolation[];
}

// ─── Comment stripper ─────────────────────────────────────────────────────────

/**
 * Replaces the content of line and block comments with space characters,
 * preserving the exact string length and all newline positions.
 *
 * Invariant (relied on by every pattern check below):
 *   stripped.length === original.length
 *   Every '\n' in stripped is at the same byte offset as in original.
 *
 * This lets match.index from a search on stripped be used directly to compute
 * line/column numbers against original — no offset translation needed.
 *
 * Caveat: // or /* sequences inside string literals are also blanked.  In
 * practice, generated component code does not embed hex values or rgba() calls
 * inside string literals that also contain comment openers, so this is fine.
 */
function stripComments(source: string): string {
  // Block comments: replace inner chars with spaces, keep newlines.
  let out = source.replace(/\/\*[\s\S]*?\*\//g, (match) =>
    match.replace(/[^\n]/g, ' '),
  );
  // Line comments: replace with equal-length run of spaces.
  out = out.replace(/\/\/[^\n]*/g, (match) => ' '.repeat(match.length));
  return out;
}

// ─── Position helper ──────────────────────────────────────────────────────────

/** Converts a byte index into a 1-based { line, column } pair. */
function positionAt(source: string, index: number): { line: number; column: number } {
  const before = source.slice(0, index);
  const lines  = before.split('\n');
  return {
    line:   lines.length,
    column: (lines[lines.length - 1] ?? '').length + 1,
  };
}

/** Extracts the source line at `index` from the original (un-stripped) source. */
function sourceLine(original: string, index: number): string {
  const lineStart = original.lastIndexOf('\n', index - 1) + 1;
  const lineEnd   = original.indexOf('\n', index);
  return original.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
}

// ─── Built-in pattern definitions ────────────────────────────────────────────

const BUILT_IN_PATTERNS: PatternDef[] = [

  // ── raw-hex ────────────────────────────────────────────────────────────────
  // Fires when a hex colour literal appears inside a string in generated code.
  // Matches '#rrggbb', '#rrggbbaa', '#rgb', '#rgba' forms inside single or
  // double quotes.  Not fired on bare identifiers like PR #443 in comments
  // (comments are stripped before scanning).
  {
    id:         'raw-hex',
    severity:   'error',
    frameworks: '*',
    check(stripped, original) {
      const violations: AuditViolation[] = [];
      const re = /['"]#[0-9a-fA-F]{3,8}['"]/g;
      for (const m of stripped.matchAll(re)) {
        const pos = positionAt(original, m.index ?? 0);
        violations.push({
          pattern:    'raw-hex',
          severity:   'error',
          line:       pos.line,
          column:     pos.column,
          snippet:    m[0].slice(0, 120),
          suggestion:
            'Replace this hex literal with a semantic token from your token file.\n' +
            '  Run "fixel scan --node <id>" to identify which token covers this colour.',
        });
      }
      return violations;
    },
  },

  // ── raw-rgba ───────────────────────────────────────────────────────────────
  // Fires on any `rgba(` or `rgb(` function call in generated code.
  // CSS colour functions should always be pre-resolved to semantic tokens;
  // dynamic alpha blending belongs in the token file, not in component code.
  {
    id:         'raw-rgba',
    severity:   'error',
    frameworks: '*',
    check(stripped, original) {
      const violations: AuditViolation[] = [];
      const re = /rgba?\s*\(/g;
      for (const m of stripped.matchAll(re)) {
        const idx = m.index ?? 0;
        const pos = positionAt(original, idx);
        violations.push({
          pattern:    'raw-rgba',
          severity:   'error',
          line:       pos.line,
          column:     pos.column,
          snippet:    sourceLine(original, idx).slice(0, 120),
          suggestion:
            'Replace this rgba() / rgb() call with a semantic token.\n' +
            '  Semi-transparent colours should be declared in your token file, ' +
            'not computed inline.',
        });
      }
      return violations;
    },
  },

  // ── bare-border-radius ─────────────────────────────────────────────────────
  // MUI sx multiplies bare numeric borderRadius values by
  // theme.shape.borderRadius (default = 4).  Writing `borderRadius: 6` renders
  // as 24px, not 6px.  Always use the CSS string form: `borderRadius: '6px'`.
  //
  // Escape hatch: add `// fixel-ignore` on the same line to suppress for a
  // deliberate use of the MUI multiplier (e.g. `borderRadius: 1` for 4px).
  {
    id:         'bare-border-radius',
    severity:   'error',
    frameworks: ['mui'],
    check(stripped, original) {
      const violations: AuditViolation[] = [];
      // Matches `borderRadius: 6` but NOT `borderRadius: '6px'` or `borderRadius: 6px`
      // Negative lookahead: not followed by another digit, `px`, `%`, or a quote.
      const re = /\bborderRadius\s*:\s*(\d+)(?![\d.px%'"`])/g;
      for (const m of stripped.matchAll(re)) {
        const idx  = m.index ?? 0;
        const line = sourceLine(original, idx);
        // Skip lines with an explicit ignore comment
        if (/fixel-ignore|MUI multiplier/i.test(line)) continue;
        const val = Number(m[1]);
        const pos = positionAt(original, idx);
        violations.push({
          pattern:    'bare-border-radius',
          severity:   'error',
          line:       pos.line,
          column:     pos.column,
          snippet:    line.slice(0, 120),
          suggestion:
            `borderRadius: ${val} renders as ${val * 4}px in MUI sx (×4 multiplier).\n` +
            `  Use the CSS string form instead: borderRadius: '${val}px'\n` +
            `  To intentionally use the multiplier, add: // fixel-ignore`,
        });
      }
      return violations;
    },
  },

  // ── missing-imports ────────────────────────────────────────────────────────
  // Fires when generated code references a token export (e.g. `semantic.`) but
  // does not import it from the configured token file path.
  // Severity is 'warning' because the generated file may use a re-export path
  // that doesn't literally contain config.tokens.importPath — a false positive
  // here is less harmful than a false negative from the colour checks above.
  {
    id:         'missing-imports',
    severity:   'warning',
    frameworks: '*',
    check(stripped, original, config) {
      const violations: AuditViolation[] = [];

      for (const exportName of [config.tokens.semanticExport, config.tokens.constantsExport]) {
        // Check if the export name is referenced as `semantic.something`
        const usageRe = new RegExp(`\\b${exportName}\\s*\\.`);
        if (!usageRe.test(stripped)) continue;

        // Check that an import for this export exists anywhere in the file.
        // Accepts both:
        //   import { semantic } from '...'
        //   import { semantic, constants } from '...'
        const importRe = new RegExp(
          `import[^;{]*\\b${exportName}\\b[^;]*from\\s*['"]${escapeRegex(config.tokens.importPath)}['"]`,
        );
        if (importRe.test(original)) continue;

        violations.push({
          pattern:    'missing-imports',
          severity:   'warning',
          line:       1,
          column:     1,
          snippet:    `${exportName}.`,
          suggestion:
            `"${exportName}" is used but not imported from "${config.tokens.importPath}".\n` +
            `  Add at the top of the file:\n` +
            `    import { ${exportName} } from '${config.tokens.importPath}'`,
        });
      }

      return violations;
    },
  },

  // ── lineHeight-override ────────────────────────────────────────────────────
  // MUI Typography variants already bake in the correct lineHeight.
  // Writing `lineHeight: 1` collapses it to the raw font-size, breaking
  // vertical rhythm across the entire component.
  // This pattern is intentionally NOT in the default prohibitedPatterns list —
  // it must be explicitly added by users who want this check.
  {
    id:         'lineHeight-override',
    severity:   'error',
    frameworks: ['mui'],
    check(stripped, original) {
      const violations: AuditViolation[] = [];
      const re = /lineHeight\s*:\s*1[^0-9.]/g;
      for (const m of stripped.matchAll(re)) {
        const idx = m.index ?? 0;
        const pos = positionAt(original, idx);
        violations.push({
          pattern:    'lineHeight-override',
          severity:   'error',
          line:       pos.line,
          column:     pos.column,
          snippet:    sourceLine(original, idx).slice(0, 120),
          suggestion:
            'lineHeight: 1 overrides the MUI Typography variant\'s built-in line-height.\n' +
            '  Remove this property — the correct lineHeight is already defined in the variant.',
        });
      }
      return violations;
    },
  },

  // ── tailwind-raw-hex-arbitrary ─────────────────────────────────────────────
  // Fires when a raw hex literal appears inside a Tailwind arbitrary-value
  // bracket in a className expression (e.g. bg-[#1a73e8], text-[#fff]).
  // Arbitrary-value class names bypass the project's semantic token system;
  // all colours must come from the semantic token import.
  //
  // Gate: only active when config.framework === 'tailwind'.
  // Escape hatch: add `// fixel-ignore` on the same line to suppress for a
  // deliberate one-off (e.g. a debug overlay that does not map to a token).
  {
    id:         'tailwind-raw-hex-arbitrary',
    severity:   'error',
    frameworks: ['tailwind'],
    check(stripped, original) {
      const violations: AuditViolation[] = [];
      // Matches [#rgb], [#rrggbb], [#rrggbbaa] inside Tailwind arbitrary values.
      const re = /\[#[0-9a-fA-F]{3,8}\]/g;
      for (const m of stripped.matchAll(re)) {
        const idx  = m.index ?? 0;
        const line = sourceLine(original, idx);
        if (/fixel-ignore/i.test(line)) continue;
        const pos = positionAt(original, idx);
        violations.push({
          pattern:    'tailwind-raw-hex-arbitrary',
          severity:   'error',
          line:       pos.line,
          column:     pos.column,
          snippet:    line.slice(0, 120),
          suggestion:
            'Replace the raw hex inside the Tailwind arbitrary value with a semantic token:\n' +
            '  ❌  className="bg-[#1a73e8]"\n' +
            '  ✅  style={{ backgroundColor: semantic.button.bg }}\n' +
            '  Run "fixel scan --node <id>" to identify the matching token.',
        });
      }
      return violations;
    },
  },

  // ── tailwind-raw-rgb-arbitrary ─────────────────────────────────────────────
  // Fires when an rgb() or rgba() call appears inside a Tailwind arbitrary-value
  // bracket in a className expression (e.g. bg-[rgba(0,0,0,0.5)]).
  // Semi-transparent colours must be declared as tokens in the token file, not
  // computed inline — otherwise the value is undiscoverable during a design audit.
  //
  // Gate: only active when config.framework === 'tailwind'.
  // Escape hatch: add `// fixel-ignore` on the same line.
  {
    id:         'tailwind-raw-rgb-arbitrary',
    severity:   'error',
    frameworks: ['tailwind'],
    check(stripped, original) {
      const violations: AuditViolation[] = [];
      // Matches [rgba(...)], [rgb(...)] inside Tailwind arbitrary values.
      const re = /\[rgba?\s*\([^)]*\)\]/g;
      for (const m of stripped.matchAll(re)) {
        const idx  = m.index ?? 0;
        const line = sourceLine(original, idx);
        if (/fixel-ignore/i.test(line)) continue;
        const pos = positionAt(original, idx);
        violations.push({
          pattern:    'tailwind-raw-rgb-arbitrary',
          severity:   'error',
          line:       pos.line,
          column:     pos.column,
          snippet:    line.slice(0, 120),
          suggestion:
            'Replace the rgb()/rgba() call inside the Tailwind arbitrary value with a token:\n' +
            '  ❌  className="bg-[rgba(0,0,0,0.5)]"\n' +
            '  ✅  className={`bg-[${semantic.overlay.bg}]`}\n' +
            '  Semi-transparent colours must be declared in the token file, not computed inline.',
        });
      }
      return violations;
    },
  },

];

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Scans a string of generated code for anti-patterns and returns one
 * AuditViolation per match found.
 *
 * Which patterns run is determined by three gates, all of which must pass:
 *   1. The pattern ID must be in `config.prohibitedPatterns`.
 *   2. The pattern's `frameworks` must be `'*'` or include `config.framework`.
 *   3. The individual check function must return a non-empty array.
 *
 * This function never throws.  If an individual pattern check panics, its
 * error is caught, logged as a warning, and scanning continues with the
 * remaining patterns.  An empty array is returned only when no violations
 * are found across all active patterns.
 *
 * @param code    The generated source code string to scan.  Not a file path.
 * @param config  Resolved fixel config (provides framework, prohibitedPatterns,
 *                token import paths).
 */
export function auditCode(code: string, config: ResolvedConfig): AuditViolation[] {
  const stripped    = stripComments(code);
  const violations: AuditViolation[] = [];
  const activeIds   = new Set(config.prohibitedPatterns);

  for (const def of BUILT_IN_PATTERNS) {
    // Gate 1: pattern must be opted-in via config.prohibitedPatterns
    if (!activeIds.has(def.id)) continue;

    // Gate 2: framework must match
    if (
      def.frameworks !== '*' &&
      !def.frameworks.includes(config.framework)
    ) continue;

    // Gate 3: run the check, catching any unexpected error
    try {
      const found = def.check(stripped, code, config);
      violations.push(...found);
    } catch (err) {
      // A pattern check crashing must never block the rest of the audit.
      console.warn(
        `  fixel audit: pattern "${def.id}" threw an unexpected error — skipping.\n` +
        `  ${(err as Error).message}`,
      );
    }
  }

  return violations;
}

/**
 * Convenience predicate — returns true when `auditCode` results contain at
 * least one 'error'-severity violation.  Used by the CLI to decide whether
 * to block writing the generated file.
 */
export function hasErrors(violations: AuditViolation[]): boolean {
  return violations.some((v) => v.severity === 'error');
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/** Escapes a string for safe use inside a RegExp constructor. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
