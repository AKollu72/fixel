// Copyright (c) 2025 Amrutha Kollu. All rights reserved.
// Licensed under the Functional Source License, Version 1.1 (FSL-1.1-MIT).

/**
 * Tests for the local scan engine — auditCode() and the six built-in patterns.
 *
 * Each describe block targets one pattern or concern.  Known limitations are
 * explicitly documented as passing tests so regressions are visible.
 */

import { auditCode } from '../../core/audit';
import type { ResolvedConfig } from '../../core/config';

// ─── Config helpers ───────────────────────────────────────────────────────────

/**
 * Builds a minimal ResolvedConfig for auditCode().
 * Only `framework` and `prohibitedPatterns` are read by the audit engine.
 */
function mkConfig(framework: string, patterns: string[]): ResolvedConfig {
  return {
    figma:     { accessToken: '' },
    framework,
    storybook: { framework: 'nextjs-vite', adapterPackage: '@storybook/nextjs-vite' },
    tokens: {
      file: '', format: 'typescript-object' as const, importPath: '',
      semanticExport: 'semantic', constantsExport: 'constants',
      namingConvention: 'semantic.{group}.{role}',
    },
    typography: { importPath: '', scale: {}, tailwindClass: 'typography-{token}' },
    output:     { componentDir: './src/components', testSubdir: '__tests__' },
    testing:    { framework: 'jest' as const, renderLibrary: '@testing-library/react' },
    ai:         { provider: 'anthropic' as const, model: 'claude-sonnet-4-6' },
    prohibitedPatterns: patterns,
  } as ResolvedConfig;
}

const MUI_CONFIG      = mkConfig('mui',      ['raw-hex', 'raw-rgba', 'bare-border-radius']);
const TAILWIND_CONFIG = mkConfig('tailwind', ['raw-hex', 'raw-rgba', 'tailwind-raw-hex-arbitrary', 'tailwind-raw-rgb-arbitrary']);

// ─── raw-hex ──────────────────────────────────────────────────────────────────

describe('auditCode — raw-hex', () => {
  it('flags a hex literal in double quotes', () => {
    const violations = auditCode(`const color = "#1a73e8";`, MUI_CONFIG);
    expect(violations.some((v) => v.pattern === 'raw-hex')).toBe(true);
  });

  it('flags a hex literal in single quotes', () => {
    const violations = auditCode(`const color = '#1a73e8';`, MUI_CONFIG);
    expect(violations.some((v) => v.pattern === 'raw-hex')).toBe(true);
  });

  it('flags a shorthand 3-digit hex', () => {
    const violations = auditCode(`const c = '#fff';`, MUI_CONFIG);
    expect(violations.some((v) => v.pattern === 'raw-hex')).toBe(true);
  });

  it('does not flag a semantic token reference', () => {
    const violations = auditCode(`const color = semantic.action.primary;`, MUI_CONFIG);
    expect(violations.filter((v) => v.pattern === 'raw-hex')).toHaveLength(0);
  });

  // Known limitation — documented so any future fix is visible as a test change.
  it('KNOWN LIMITATION: does not catch hex in backtick template literals', () => {
    // eslint-disable-next-line no-template-curly-in-string
    const violations = auditCode('const color = `#1a73e8`;', MUI_CONFIG);
    // This should ideally be caught, but currently is not.
    expect(violations.filter((v) => v.pattern === 'raw-hex')).toHaveLength(0);
  });

  it('violation includes line number and severity=error', () => {
    const code = `\nconst color = '#ff0000';\n`;
    const violations = auditCode(code, MUI_CONFIG);
    const hex = violations.find((v) => v.pattern === 'raw-hex');
    expect(hex).toBeDefined();
    expect(hex!.severity).toBe('error');
    expect(hex!.line).toBeGreaterThan(0);
  });
});

// ─── raw-rgba ─────────────────────────────────────────────────────────────────

describe('auditCode — raw-rgba', () => {
  it('flags an rgba() call', () => {
    const violations = auditCode(`const bg = "rgba(0, 0, 0, 0.5)";`, MUI_CONFIG);
    expect(violations.some((v) => v.pattern === 'raw-rgba')).toBe(true);
  });

  it('flags an rgb() call', () => {
    const violations = auditCode(`const bg = "rgb(26, 115, 232)";`, MUI_CONFIG);
    expect(violations.some((v) => v.pattern === 'raw-rgba')).toBe(true);
  });

  it('flags rgba inside a style prop', () => {
    const violations = auditCode(
      `<div style={{ background: 'rgba(255,255,255,0.9)' }} />`,
      MUI_CONFIG,
    );
    expect(violations.some((v) => v.pattern === 'raw-rgba')).toBe(true);
  });

  it('does not flag code with no rgba/rgb calls', () => {
    const violations = auditCode(
      `const bg = semantic.surface.overlay;`,
      MUI_CONFIG,
    );
    expect(violations.filter((v) => v.pattern === 'raw-rgba')).toHaveLength(0);
  });
});

// ─── bare-border-radius (MUI only) ───────────────────────────────────────────

describe('auditCode — bare-border-radius', () => {
  it('flags a bare numeric borderRadius in MUI sx', () => {
    const violations = auditCode(`<Box sx={{ borderRadius: 6 }} />`, MUI_CONFIG);
    expect(violations.some((v) => v.pattern === 'bare-border-radius')).toBe(true);
  });

  it('does NOT flag borderRadius: "6px" (string — correct usage)', () => {
    const violations = auditCode(`<Box sx={{ borderRadius: '6px' }} />`, MUI_CONFIG);
    expect(violations.filter((v) => v.pattern === 'bare-border-radius')).toHaveLength(0);
  });

  // Framework gate: bare-border-radius is MUI-only, does not fire for Tailwind.
  it('does NOT flag bare-border-radius in a Tailwind project', () => {
    const violations = auditCode(`<Box sx={{ borderRadius: 6 }} />`, TAILWIND_CONFIG);
    expect(violations.filter((v) => v.pattern === 'bare-border-radius')).toHaveLength(0);
  });
});

// ─── Tailwind arbitrary-value patterns ───────────────────────────────────────

describe('auditCode — tailwind-raw-hex-arbitrary', () => {
  it('flags hex inside Tailwind arbitrary-value brackets', () => {
    const violations = auditCode(
      `<div className="bg-[#1a73e8]" />`,
      TAILWIND_CONFIG,
    );
    expect(violations.some((v) => v.pattern === 'tailwind-raw-hex-arbitrary')).toBe(true);
  });

  it('does NOT flag Tailwind arbitrary hex in a MUI project', () => {
    const violations = auditCode(`<div className="bg-[#1a73e8]" />`, MUI_CONFIG);
    expect(violations.filter((v) => v.pattern === 'tailwind-raw-hex-arbitrary')).toHaveLength(0);
  });
});

describe('auditCode — tailwind-raw-rgb-arbitrary', () => {
  it('flags rgba inside Tailwind arbitrary-value brackets', () => {
    const violations = auditCode(
      `<div className="bg-[rgba(0,0,0,0.5)]" />`,
      TAILWIND_CONFIG,
    );
    expect(violations.some((v) => v.pattern === 'tailwind-raw-rgb-arbitrary')).toBe(true);
  });

  it('does NOT flag Tailwind arbitrary rgba in a MUI project', () => {
    const violations = auditCode(`<div className="bg-[rgba(0,0,0,0.5)]" />`, MUI_CONFIG);
    expect(violations.filter((v) => v.pattern === 'tailwind-raw-rgb-arbitrary')).toHaveLength(0);
  });
});

// ─── Clean code ───────────────────────────────────────────────────────────────

describe('auditCode — clean code returns no violations', () => {
  it('passes a component that uses only semantic tokens', () => {
    const code = `
import { semantic } from '@/tokens/colors';
export const Button = () => (
  <button
    style={{
      backgroundColor: semantic.action.primary,
      borderRadius: '6px',
      color: semantic.text.onPrimary,
    }}
  >
    Click me
  </button>
);
    `.trim();
    const violations = auditCode(code, MUI_CONFIG);
    expect(violations).toHaveLength(0);
  });

  it('passes a Tailwind component that uses only utility classes (no arbitrary values)', () => {
    const code = `
export const Badge = ({ label }: { label: string }) => (
  <span className="rounded bg-primary-500 px-2 py-1 text-white typography-body-sm">
    {label}
  </span>
);
    `.trim();
    const violations = auditCode(code, TAILWIND_CONFIG);
    expect(violations).toHaveLength(0);
  });

  it('does not flag hex values inside comments', () => {
    const code = `
// The primary brand color is #1a73e8 — use semantic.action.primary instead.
const color = semantic.action.primary;
    `.trim();
    const violations = auditCode(code, MUI_CONFIG);
    // Comments are stripped before pattern matching — no violation should fire.
    expect(violations.filter((v) => v.pattern === 'raw-hex')).toHaveLength(0);
  });
});

// ─── Violation shape ──────────────────────────────────────────────────────────

describe('AuditViolation shape', () => {
  it('includes pattern, severity, line, column, snippet, and suggestion', () => {
    const violations = auditCode(`const c = '#ff0000';`, MUI_CONFIG);
    expect(violations.length).toBeGreaterThan(0);
    const v = violations[0];
    expect(typeof v.pattern).toBe('string');
    expect(v.severity === 'error' || v.severity === 'warning').toBe(true);
    expect(typeof v.line).toBe('number');
    expect(typeof v.column).toBe('number');
    expect(typeof v.snippet).toBe('string');
    expect(typeof v.suggestion).toBe('string');
  });
});
