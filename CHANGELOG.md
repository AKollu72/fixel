# Changelog

All notable changes to Fixel are documented here.

> **Acknowledgments** — thanks to [Stéphane LaFlèche](https://github.com/slafleche)
> for early testing and detailed feedback in June 2026 that shaped several of
> the fixes below.

## [0.2.8] — 2026-09-30

### Fixed

- **Missing-typography-scale error now includes the remedy** — when `generate`
  (or live `verify --node`) hits a text size/weight with no `typography.scale`
  entry, the error prints the exact copy-pasteable JSON entry (keyed by the
  `fontSize/fontWeight` it saw, with the node's real line-height when
  available), plus the alternative: publish the text style in Figma and re-run
  `fixel import --write`. Found in the first live 0.2.7 pipeline pass — the
  documented import → generate flow dead-ends on unpublished text styles.

### Changed

- **README documents the published-styles-only limitation of `import`** — a
  callout in the import section states that unpublished text used by a node
  must be added to `typography.scale` manually.
- **Compiled tests no longer ship in the npm package** — `!dist/cli/__tests__`
  added to the `files` whitelist (~37KB smaller unpacked).
- **Node 18 support dropped** — EOL since April 2025, and `@inquirer/prompts`
  requires ≥ 20.17 (its top-level import made even `fixel init --help` exit 1
  on Node 18). Engines now `>=20.17.0`; CI matrix is 20 / 22 / 24.

### Tests

- 2 new tests asserting the missing-scale-entry error contains the remedy
  JSON and the publish-and-reimport alternative. Suite: 58 tests.

---

## [0.2.7] — 2026-09-29

### Fixed

- **`fixel init` no longer breaks `fixel scan`** — when `fixel.config.json`
  exists but the configured token file hasn't been generated yet, `scan` warns
  ("not found — run fixel import") and scans anyway instead of hard-failing.
  The documented quickstart sequence (init → scan) now works.
- **The token file is never flagged** — `fixel scan` excludes exactly
  `config.tokens.file` from the audit. Raw hex is required there; with the
  default config layout (`./src/tokens/colors.ts` under the scanned `./src`)
  every project previously got a permanent false positive. Sibling files in
  the same directory are still scanned (`src/components/tokens.ts` layouts).
  Scanning the token file directly reports the exclusion and exits 0.
- **Windows no longer crashes on Figma API errors** — `import`,
  `scan --node`, `generate`, and `verify --node` error paths previously died
  with a libuv assertion (`src\win\async.c:76`, exit 0xC0000409) because
  `process.exit()` raced undici's socket teardown. Figma requests now send
  `Connection: close` and the CLI error handlers set `process.exitCode` and
  drain instead of hard-exiting.
- **UTF-8 BOM tolerated in JSON inputs** — `fixel.config.json` and
  `*.fixel.json` specs written by BOM-emitting tools (PowerShell `Out-File`)
  now parse. Previously: `Unexpected token '﻿'`.
- **`fixel verify` without a config exits 2, not 1** — matching the "nothing
  to verify yet" semantics the CI recipe documents, with guidance pointing at
  `fixel init`. Previously a config-less repo failed the build.
- **Orphaned specs are reported** — a `<Name>.fixel.json` whose `<Name>.tsx`
  was deleted now produces a warning naming the spec. Previously the component
  silently vanished from verification.
- **Malformed spec errors name the file** — `verify` and `annotate` now report
  which `.fixel.json` failed to parse (and `verify` continues with the other
  components) instead of printing a bare JSON error.

### Changed

- **License: MIT** — switched from FSL-1.1-MIT to plain MIT, effective this
  release. LICENSE, package metadata, README, and source headers updated.
- **Generic placeholder typography scale** — `fixel init` no longer ships a
  specific design system's scale (H1/LG_Bold/…) as the default. The template
  scale is now clearly generic (`heading-1`, `body`, `caption`, …) and init
  prints a warning that the names must be replaced. Example token names in
  prompts and docs were genericised the same way.
- **Help text scoped env-var requirements** — `FIGMA_ACCESS_TOKEN` is marked
  required only for `import` / `generate` / `annotate`, and the help screen
  states that `scan` and `verify` run offline with no token.

### Tests

- 11 new CLI regression tests (`src/cli/__tests__/p0-fixes.test.ts`) covering
  the init→scan path, token-file exclusion, BOM handling, verify exit codes,
  orphaned specs, and named malformed-spec errors. Suite: 55 tests.

---

## [0.2.6] — 2026-09-28

### Fixed

- **ANSI codes stripped in non-TTY and `NO_COLOR` contexts** — terminal colour
  codes are now gated on `process.stdout.isTTY` and the `NO_COLOR` environment
  variable. Output piped to a file, CI log, or an MCP tool response is always
  plain text. (`src/core/color.ts` centralises the gate; all CLI commands use
  it.)
- **`--help` on subcommands exits 0** — `fixel scan --help`, `fixel verify
  --help`, and `fixel init --help` now print per-command usage and exit 0.
  Previously `--help` was either ignored (ran the command instead) or exited 1.
- **Single-file scan paths work** — `fixel scan ./src/Button.tsx` now scans
  that file directly. Previously, passing a file path silently reported "No
  .tsx files found" and exited 0. Unsupported extensions (e.g. `.png`) exit 1
  with a clear message listing the accepted types.
- **Stale `OPENAI_API_KEY` references removed** — the env-var entry was removed
  from `fixel --help` output and the `fixel init` setup flow. Anthropic has
  been the only supported AI provider since 0.2.1; the references were
  misleading.

### Changed

- **Scan summary includes next-step guidance** — a single dim line now appears
  after every local scan summary. Clean run: points at `fixel verify` and
  notes the Figma token prerequisite. Violations: prompts the user to fix and
  re-run, with the same Figma-gated note for the next step.

---

## [0.2.5] — 2026-09-09

### Changed

- **README** — replaced tagline with canonical niche sentence; added "Try it in
  10 seconds" and "Give it to your coding agent" entry doors at the top;
  merged the former standalone MCP section into the top entry door (no
  content removed, no duplication).
- **`package.json` description** — updated to match the canonical niche
  sentence.
- **`CONTRIBUTING.md`** — removed stale `# or OPENAI_API_KEY` comment;
  OpenAI support was dropped in 0.2.1.
- **Launch materials** — rewrote `launch/show-hn.md`; added
  `launch/linkedin-post.md`.

---

## [0.2.4] — 2026-09-09

### Fixed

- **`fixel scan` regression (0.2.3)** — the `require.main === module` guard
  introduced in 0.2.3 to allow test imports of `collectReactFiles` silenced
  the entire scan command when dispatched from `index.ts` via
  `require('./cli/scan')`.  The fix: export `runScanCli()` from `scan.ts`
  and have `index.ts` call it explicitly.  The `require.main` guard is kept
  only for direct invocation (`node dist/cli/scan.js`).

- **Annotate Windows exit crash** — `process.exit(1)` called while undici's
  background thread was still draining the HTTP connection pool triggered a
  libuv assertion failure (`UV_HANDLE_CLOSING` in `src\win\async.c`) on
  Windows.  Fix: switch to `process.exitCode = 1` (natural event-loop drain)
  in the annotate entry-point catch block.  Added `connection: 'close'` header
  to both `postComment` and `listComments` in `figma-writer.ts` so undici
  destroys the socket after the response, keeping the drain fast (~308ms).

### Added

- **CLI dispatch regression test** — two-tier test in `scan-local.test.ts`:
  (1) unit test verifying `runScanCli` export shape; (2) integration test
  that spawns `dist/index.js scan <tmpdir>` and asserts non-empty output,
  catching any future `require.main`-class dispatch failure automatically.

---

## [0.2.3] — 2026-09-09

### Fixed

- **raw-hex catches backtick template literals** — `src/core/audit.ts` now
  uses a two-pass approach: pass 1 catches hex adjacent to any string delimiter
  (`'`, `"`, `` ` ``); pass 2 scans the content of backtick-delimited template
  literals for hex not adjacent to the opener, catching
  `` css`color: #1a73e8;` `` and similar CSS-in-JS patterns.

- **`fixel scan` now collects `.ts` and `.js` files** — theme files, style
  constants, and utility modules stored in `.ts`/`.js` are now scanned.
  Excluded: `*.test.*`, `*.spec.*`, `*.d.ts`, `*.config.ts`, `*.config.js`.

- **MCP server timeout** — `runFixel` in `src/mcp/server.ts` now passes a
  60-second timeout to `spawnSync`. Configurable via `FIXEL_MCP_TIMEOUT_MS`
  env var. Hung Figma calls no longer block the server indefinitely; a clear
  error message is returned on timeout.

### Added

- **`collectReactFiles` exported** — now importable for testing without
  triggering the CLI entry point (`require.main === module` guard added).
- **MCP smoke test** — `test/mcp-smoke.md` documents the manual test
  procedure: `claude mcp add` command, per-tool call shapes, and a
  timeout-verification step against the fixel-journey-test fixture repo.
- **Automated tests for file collection** — 6 new tests for `collectReactFiles`
  covering .ts/.js inclusion and .test.ts/.d.ts/.config.ts exclusion.
- **Backtick template literal tests** — the former known-limitation test now
  asserts the fix works; 2 new tests added (CSS tagged template, comment
  non-flag).

---

## [0.2.1] — 2026-09-09

### Fixed

- **`fixel scan` config now genuinely optional** — local scan no longer
  hard-fails when `fixel.config.json` is absent. Detects framework from
  `package.json` and falls back to built-in defaults, printing a visible
  warning. Token-file check is skipped when no config is on disk.

- **OpenAI provider removed** — `ai.provider: "openai"` was silently broken
  since `callAI()` always called Anthropic's API regardless. The option is
  removed from the type, the validator, and the docs. Only `"anthropic"` is
  supported; set `ANTHROPIC_API_KEY`.

- **`fixel verify --node` without `--component` now errors explicitly** —
  previously applied one Figma node's live data to every component in the
  directory, silently producing wrong results. Now exits 1 with a clear
  message requiring `--component`.

### Added

- **Automated test suite** — `src/cli/__tests__/scan-local.test.ts` covers
  the six audit patterns (raw-hex, raw-rgba, bare-border-radius, both Tailwind
  arbitrary-value patterns, and the template-literal known limitation). Adds
  `jest`, `ts-jest`, and `@types/jest` to dev dependencies. `npm test` now
  actually runs tests.

---

## [0.2.0] — 2026-09-09

### Added

- **Local scan mode** — `fixel scan <path>` audits React component files on
  disk for prohibited design patterns (raw hex literals, raw rgba() calls,
  bare numeric border-radius in MUI sx, Tailwind arbitrary-value hex/rgba).
  No Figma API call, no AI key required. Exits 1 on any error-severity
  violation. Reads framework and token settings from `fixel.config.json`;
  fails gracefully with a pointer to `fixel import` if no token file is
  configured.

- **MCP server** — `fixel-mcp` exposes three tools over stdio transport for
  AI coding agents: `fixel_scan(path)`, `fixel_verify(component?, node?)`,
  `fixel_annotate(component, node)`. Compatible with Claude Desktop and any
  Model Context Protocol host.

### Changed

- Repositioned as verification-first: `fixel scan <path>` is now the
  quickstart. `fixel generate` remains available for the full pipeline.
- README rewritten to lead with `fixel scan` and `fixel verify`; CI example
  now shows both steps.
- Added keywords: `verification`, `ai-codegen`, `drift-detection`, `mcp`, `ci`.

### Internal

- `auditCode()` in `src/core/audit.ts` is now exercised by both the
  post-generation gate (existing) and local scan (new) — same engine, two
  entry points.

---

## [0.1.6] — 2026-06-21

### Fixed

- `normalizeNodeArg`: dash-separated node IDs from Figma URLs now convert
  correctly to colon-separated API format.
- `specIsEmpty` guard in `fixel verify`: specs with all arrays empty now exit
  1 with a clear message instead of silently passing.
- Tailwind prompt rules: COLOUR TOKENS section now uses
  `style={{ backgroundColor }}` instead of `className` arbitrary values.
- `formatTokenKey`: token keys that are not valid JS identifiers are now
  quoted in the suggested patch output.
- CSS Modules: `fixel generate` now creates a `.module.css` stub when
  `framework` is `css-modules`.
- Approximation warnings: `fixel generate` now prints a warning when a color
  is approximated to the nearest token by RGB distance rather than matched
  exactly.
- `tailwind-raw-hex-arbitrary` audit pattern: suggestion now shows
  `style={{ backgroundColor }}` instead of a template literal class.

## [0.1.5] — 2026-06-21

Initial public release.
