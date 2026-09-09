# Changelog

All notable changes to Fixel are documented here.

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
