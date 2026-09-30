// Copyright (c) 2025 Amrutha Kollu. All rights reserved.
// Licensed under the MIT License — see LICENSE for details.

/**
 * Regression tests for the 0.2.7 pre-launch P0 fixes.
 *
 * 1. init → scan works: a fixel.config.json whose token file doesn't exist
 *    yet must WARN and scan anyway, not hard-fail.
 * 2. The configured token file (and the directory it lives in) is excluded
 *    from `fixel scan` — raw hex is required there, never a violation.
 * 5. UTF-8 BOM is stripped before parsing configs and specs, and
 *    `fixel verify` without a config exits 2 (nothing to verify), not 1.
 * 6. Orphaned specs (spec present, component .tsx gone) produce a warning,
 *    and a malformed spec error names the offending file.
 *
 * These are CLI-level tests: they spawn dist/index.js in a temp project the
 * same way scan-local.test.ts does, so `npm run build` must run first
 * (prepublishOnly and CI both do).
 */

import * as os              from 'node:os';
import * as fs              from 'node:fs';
import * as path            from 'node:path';
import { spawnSync }        from 'node:child_process';

import { stripBom, loadConfig } from '../../core/config';
import { resolveTypographyToken } from '../../core/typography';

const DIST_INDEX = path.resolve(__dirname, '..', '..', '..', 'dist', 'index.js');

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string): CliResult {
  const result = spawnSync(
    process.execPath,
    [DIST_INDEX, ...args],
    { encoding: 'utf8', timeout: 30_000, cwd, env: { ...process.env, NO_COLOR: '1' } },
  );
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function distMissing(): boolean {
  if (!fs.existsSync(DIST_INDEX)) {
    console.warn('[skip] dist/index.js not found — run npm run build first');
    return true;
  }
  return false;
}

/** Minimal but fully valid fixel.config.json for a temp project. */
function configJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    figma:     { accessToken: '${FIGMA_ACCESS_TOKEN}' },
    framework: 'mui',
    tokens: {
      file:       './src/tokens/colors.ts',
      format:     'typescript-object',
      importPath: '@/tokens/colors',
    },
    typography: {
      importPath: '@/tokens/typography',
      scale: { '14/400': { token: 'bodySm', lineHeight: '20px' } },
    },
    output: { componentDir: './src/components', testSubdir: '__tests__' },
    ai:     { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    ...overrides,
  }, null, 2);
}

const DIRTY_TSX = `export const Bad = () => <div style={{ color: "#1a73e8" }}>x</div>;\n`;
const CLEAN_TSX = `export const Ok = () => <div>x</div>;\n`;

/** A spec + component pair that passes every offline drift check. */
const PASSING_SPEC = JSON.stringify({
  figmaFile: 'TESTFILE',
  figmaNode: '1:1',
  generatedAt: new Date().toISOString(),
  resolvedTextStyles: [{ fontSize: 14, fontWeight: 400, token: 'bodySm', lineHeight: '20px' }],
  resolvedSpacing: [],
  resolvedIconSizes: [],
  resolvedCornerRadii: [],
});
const PASSING_TSX = `import { Typography } from "@mui/material";\n` +
  `export function Badge() { return <Typography variant="bodySm">x</Typography>; }\n`;

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixel-p0-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Fix 1: init → scan works before the token file exists ────────────────────

describe('scan — config present, token file missing (P0-1)', () => {
  it('warns and scans anyway instead of hard-failing', () => {
    if (distMissing()) return;
    fs.writeFileSync(path.join(tmpDir, 'fixel.config.json'), configJson());
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'Bad.tsx'), DIRTY_TSX);

    const r = runCli(['scan', './src'], tmpDir);
    const out = r.stdout + r.stderr;
    expect(out).toContain('not found');            // the warning …
    expect(out).toContain('raw-hex');              // … but the scan still ran
    expect(r.status).toBe(1);                      // violations found, not a config error
  });

  it('exits 0 on a clean project with config but no token file', () => {
    if (distMissing()) return;
    fs.writeFileSync(path.join(tmpDir, 'fixel.config.json'), configJson());
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'Ok.tsx'), CLEAN_TSX);

    const r = runCli(['scan', './src'], tmpDir);
    expect(r.status).toBe(0);
  });
});

// ─── Fix 2: the token file is never flagged ───────────────────────────────────

describe('scan — token file exclusion (P0-2)', () => {
  it('skips exactly the token file; a sibling in the same directory IS scanned', () => {
    if (distMissing()) return;
    fs.writeFileSync(path.join(tmpDir, 'fixel.config.json'), configJson());
    fs.mkdirSync(path.join(tmpDir, 'src', 'tokens'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'tokens', 'colors.ts'),
      `export const semantic = { action: { primary: "#1a73e8" } } as const;\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'tokens', 'extra.ts'),
      `export const more = "#ff0000";\n`,        // sibling in the tokens dir — NOT excluded
    );
    fs.writeFileSync(path.join(tmpDir, 'src', 'Ok.tsx'), CLEAN_TSX);

    const r = runCli(['scan', './src'], tmpDir);
    const out = r.stdout + r.stderr;
    // (a) the token file itself is skipped: its hex never appears as a violation
    expect(out).not.toContain('#1a73e8');
    // (b) the sibling is still scanned and flagged
    expect(out).toContain('extra.ts');
    expect(out).toContain('#ff0000');
    expect(out).toContain('1 violation in 1 file');
    expect(r.status).toBe(1);
  });

  it('exits 0 when the only hex in the project lives in the token file', () => {
    if (distMissing()) return;
    fs.writeFileSync(path.join(tmpDir, 'fixel.config.json'), configJson());
    fs.mkdirSync(path.join(tmpDir, 'src', 'tokens'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'tokens', 'colors.ts'),
      `export const semantic = { action: { primary: "#1a73e8" } } as const;\n`,
    );
    fs.writeFileSync(path.join(tmpDir, 'src', 'Ok.tsx'), CLEAN_TSX);

    const r = runCli(['scan', './src'], tmpDir);
    expect(r.stdout + r.stderr).not.toContain('#1a73e8');
    expect(r.status).toBe(0);
  });

  it('still flags violations in non-token files alongside the exclusion', () => {
    if (distMissing()) return;
    fs.writeFileSync(path.join(tmpDir, 'fixel.config.json'), configJson());
    fs.mkdirSync(path.join(tmpDir, 'src', 'tokens'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'tokens', 'colors.ts'), `export const c = "#1a73e8";\n`);
    fs.writeFileSync(path.join(tmpDir, 'src', 'Bad.tsx'), DIRTY_TSX);

    const r = runCli(['scan', './src'], tmpDir);
    const out = r.stdout + r.stderr;
    expect(out).toContain('Bad.tsx');
    // Exactly ONE violating file: Bad.tsx.  The token file's hex must not
    // add a second one (the header naming the token file path is fine).
    expect(out).toContain('1 violation in 1 file');
    expect(r.status).toBe(1);
  });

  it('scanning the token file directly reports the exclusion and exits 0', () => {
    if (distMissing()) return;
    fs.writeFileSync(path.join(tmpDir, 'fixel.config.json'), configJson());
    fs.mkdirSync(path.join(tmpDir, 'src', 'tokens'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'tokens', 'colors.ts'), `export const c = "#1a73e8";\n`);

    const r = runCli(['scan', './src/tokens/colors.ts'], tmpDir);
    expect(r.stdout + r.stderr).toContain('excluded');
    expect(r.status).toBe(0);
  });
});

// ─── Fix 5: BOM tolerance + verify-without-config exit code ───────────────────

describe('stripBom (P1 fix 5)', () => {
  it('removes a leading UTF-8 BOM and leaves clean text alone', () => {
    expect(stripBom('﻿{"a":1}')).toBe('{"a":1}');
    expect(stripBom('{"a":1}')).toBe('{"a":1}');
    expect(stripBom('')).toBe('');
  });

  it('loadConfig parses a config file written with a BOM', () => {
    const cfgPath = path.join(tmpDir, 'fixel.config.json');
    fs.writeFileSync(cfgPath, '﻿' + configJson());
    const config = loadConfig(cfgPath);
    expect(config.framework).toBe('mui');
  });
});

describe('verify — exit codes and BOM specs (P1 fix 5)', () => {
  it('exits 2 with init guidance when no fixel.config.json exists', () => {
    if (distMissing()) return;
    const r = runCli(['verify'], tmpDir);
    expect(r.status).toBe(2);
    expect(r.stdout + r.stderr).toContain('fixel init');
  });

  it('parses a spec file that starts with a UTF-8 BOM', () => {
    if (distMissing()) return;
    fs.writeFileSync(path.join(tmpDir, 'fixel.config.json'), configJson());
    const compDir = path.join(tmpDir, 'src', 'components', 'Badge');
    fs.mkdirSync(compDir, { recursive: true });
    fs.writeFileSync(path.join(compDir, 'Badge.fixel.json'), '﻿' + PASSING_SPEC);
    fs.writeFileSync(path.join(compDir, 'Badge.tsx'), PASSING_TSX);

    const r = runCli(['verify'], tmpDir);
    expect(r.stdout + r.stderr).not.toContain('Unexpected token');
    expect(r.status).toBe(0);
  });
});

// ─── 0.2.8: missing-scale-entry error includes the remedy ─────────────────────

describe('resolveTypographyToken — missing entry error is actionable (0.2.8)', () => {
  it('includes the exact JSON to add, keyed by the fontSize/fontWeight it saw', () => {
    let message = '';
    try {
      resolveTypographyToken(11, 500, { '14/400': { token: 'bodySm', lineHeight: '20px' } }, 16);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('fontSize=11 fontWeight=500');
    expect(message).toContain('typography.scale');
    expect(message).toContain('fixel.config.json');
    // the copy-pasteable entry, with the real key and the node's line-height
    expect(message).toContain('"11/500": { "token": "YOUR_TOKEN", "lineHeight": "16px" }');
    expect(message).toContain('"11/any"');
    // the alternative route
    expect(message).toContain('publish this text style in Figma');
    expect(message).toContain('fixel import --file FILEKEY --write');
  });

  it('falls back to an estimated line-height when no hint is available', () => {
    let message = '';
    try {
      resolveTypographyToken(20, 700, {});
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('"20/700": { "token": "YOUR_TOKEN", "lineHeight": "28px" }');
  });
});

// ─── Fix 6: orphan specs + named malformed-spec errors ────────────────────────

describe('verify — orphan and malformed specs (P1 fix 6)', () => {
  it('warns when a spec exists but its component file is missing', () => {
    if (distMissing()) return;
    fs.writeFileSync(path.join(tmpDir, 'fixel.config.json'), configJson());
    const ghostDir = path.join(tmpDir, 'src', 'components', 'Ghost');
    fs.mkdirSync(ghostDir, { recursive: true });
    fs.writeFileSync(path.join(ghostDir, 'Ghost.fixel.json'), PASSING_SPEC);
    // no Ghost.tsx — the component was deleted

    const r = runCli(['verify'], tmpDir);
    const out = r.stdout + r.stderr;
    expect(out).toContain('orphaned spec');
    expect(out).toContain('Ghost.fixel.json');
    expect(r.status).toBe(2);   // still nothing verifiable — but no longer silent
  });

  it('names the file when a spec is malformed JSON', () => {
    if (distMissing()) return;
    fs.writeFileSync(path.join(tmpDir, 'fixel.config.json'), configJson());
    const compDir = path.join(tmpDir, 'src', 'components', 'Broken');
    fs.mkdirSync(compDir, { recursive: true });
    fs.writeFileSync(path.join(compDir, 'Broken.fixel.json'), '{ not json');
    fs.writeFileSync(path.join(compDir, 'Broken.tsx'), CLEAN_TSX);

    const r = runCli(['verify'], tmpDir);
    const out = r.stdout + r.stderr;
    expect(out).toContain('Broken.fixel.json');
    expect(out).toContain('not valid JSON');
    expect(r.status).toBe(1);
  });
});
