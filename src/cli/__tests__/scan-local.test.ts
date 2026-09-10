// Copyright (c) 2025 Amrutha Kollu. All rights reserved.
// Licensed under the Functional Source License, Version 1.1 (FSL-1.1-MIT).

/**
 * Tests for the local scan engine — auditCode() and the six built-in patterns.
 *
 * Each describe block targets one pattern or concern.  Known limitations are
 * explicitly documented as passing tests so regressions are visible.
 */

import * as os              from 'node:os';
import * as fs              from 'node:fs';
import * as path            from 'node:path';
import { spawnSync }        from 'node:child_process';

import { auditCode }         from '../../core/audit';
import { collectReactFiles } from '../scan';
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

  // Fix 0.2.3: backtick template literals are now caught.
  it('catches hex in a bare backtick template literal', () => {
    // eslint-disable-next-line no-template-curly-in-string
    const violations = auditCode('const color = `#1a73e8`;', MUI_CONFIG);
    expect(violations.filter((v) => v.pattern === 'raw-hex')).toHaveLength(1);
  });

  it('catches hex embedded inside a CSS tagged template literal', () => {
    // e.g. styled-components / emotion: css`color: #1a73e8;`
    const violations = auditCode('const s = css`color: #1a73e8; background: #fff;`;', MUI_CONFIG);
    expect(violations.filter((v) => v.pattern === 'raw-hex').length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT flag hex inside a single-line comment (comment is stripped)', () => {
    const code = '// The brand blue is #1a73e8 — use semantic.action.primary\nconst x = 1;';
    const violations = auditCode(code, MUI_CONFIG);
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

// ─── collectReactFiles — extension and exclusion rules ───────────────────────

describe('collectReactFiles — file extension rules', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixel-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Write a file relative to tmpDir and return its absolute path. */
  function write(name: string, content = ''): string {
    const p = path.join(tmpDir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
    return p;
  }

  it('collects .ts files', () => {
    write('theme.ts', 'export const primary = "#1a73e8";');
    const files = collectReactFiles(tmpDir);
    expect(files.some((f) => f.endsWith('theme.ts'))).toBe(true);
  });

  it('collects .js files', () => {
    write('colors.js', 'module.exports = { primary: "#1a73e8" };');
    const files = collectReactFiles(tmpDir);
    expect(files.some((f) => f.endsWith('colors.js'))).toBe(true);
  });

  it('collects .tsx and .jsx files as before', () => {
    write('Button.tsx');
    write('Badge.jsx');
    const files = collectReactFiles(tmpDir);
    expect(files.some((f) => f.endsWith('Button.tsx'))).toBe(true);
    expect(files.some((f) => f.endsWith('Badge.jsx'))).toBe(true);
  });

  it('excludes *.test.ts files', () => {
    write('theme.test.ts', 'const x = "#1a73e8";');
    const files = collectReactFiles(tmpDir);
    expect(files.some((f) => f.endsWith('theme.test.ts'))).toBe(false);
  });

  it('excludes *.spec.ts files', () => {
    write('theme.spec.ts');
    const files = collectReactFiles(tmpDir);
    expect(files.some((f) => f.endsWith('theme.spec.ts'))).toBe(false);
  });

  it('excludes *.d.ts declaration files', () => {
    write('types.d.ts', 'export type Color = string;');
    const files = collectReactFiles(tmpDir);
    expect(files.some((f) => f.endsWith('types.d.ts'))).toBe(false);
  });

  it('excludes *.config.ts files', () => {
    write('tailwind.config.ts');
    const files = collectReactFiles(tmpDir);
    expect(files.some((f) => f.endsWith('tailwind.config.ts'))).toBe(false);
  });

  it('excludes *.config.js files', () => {
    write('jest.config.js');
    const files = collectReactFiles(tmpDir);
    expect(files.some((f) => f.endsWith('jest.config.js'))).toBe(false);
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

// ─── CLI dispatch regression ──────────────────────────────────────────────────
//
// 0.2.3 introduced a `require.main === module` guard in scan.ts so tests could
// import collectReactFiles.  The bug: index.ts loads scan via
// `require('./cli/scan')`, which sets require.main to index.js — so the guard
// fired and main() was never called.  scan produced zero output, exit 0.
//
// Fix (0.2.4): export runScanCli() and have index.ts call it explicitly.
// These tests ensure that class of bug cannot silently regress again.

describe('CLI dispatch — regression for 0.2.3 require.main bug', () => {
  const ROOT       = path.resolve(__dirname, '..', '..', '..');
  const DIST_INDEX = path.join(ROOT, 'dist', 'index.js');

  // ── Tier 1: unit — export shape (works without a built dist) ──────────────

  it('scan module exports runScanCli (required by index.ts dispatch path)', () => {
    // When index.ts does require('./cli/scan'), it must be able to call
    // runScanCli().  If this export is missing the dispatch is silently broken.
    // ts-jest requires the TypeScript source directly, same require() semantic.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const scanModule = require('../scan') as Record<string, unknown>;
    expect(typeof scanModule.runScanCli).toBe('function');
    expect(typeof scanModule.collectReactFiles).toBe('function');
  });

  // ── Tier 2: integration — live dispatch (requires built dist) ─────────────
  //
  // This is the real smoke test: spawns dist/index.js the same way that
  // fixel-bin.js does and the MCP server does, and asserts non-empty output.
  // Skipped when dist/ hasn't been built yet (run `npm run build` first).

  it('fixel scan produces output via dist/index.js dispatch (0.2.3 regression guard)', () => {
    if (!fs.existsSync(DIST_INDEX)) {
      console.warn('[skip] dist/index.js not found — run npm run build first');
      return;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixel-dispatch-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'Clean.tsx'), 'const x = 1;');

      const result = spawnSync(
        process.execPath,
        [DIST_INDEX, 'scan', tmpDir],
        {
          encoding:  'utf8',
          timeout:   30_000,
          cwd:       tmpDir,
          env:       { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
        },
      );

      // Regression symptom: stdout === '' and stderr === '' with exit code 0.
      // Any output proves that runScanCli() was reached via the dispatch path.
      const combined = ((result.stdout ?? '') + (result.stderr ?? '')).trim();
      expect(result.signal).toBeNull();         // was not killed by timeout
      expect(combined.length).toBeGreaterThan(0); // output must be non-empty
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
