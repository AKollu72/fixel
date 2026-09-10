# v0.2.5 — launch-ready

This release completes a focused repair sprint (0.2.0 → 0.2.5) that shipped over a single day. The npm package is production-quality; the codebase has a real test suite and CI.

## What's in this release

### 0.2.5 — docs consistency pass
Canonical niche sentence across README, `package.json`, and launch materials. Two-door README top section (humans + MCP agents). New: `launch/show-hn.md`, `launch/linkedin-post.md`. Fixed stale `OPENAI_API_KEY` reference in `CONTRIBUTING.md` (OpenAI support was removed in 0.2.1).

### 0.2.4 — two Windows fixes
- **`fixel scan` dispatch regression** — the `require.main === module` guard added in 0.2.3 silenced scan when dispatched from `index.ts`. Fixed by exporting `runScanCli()`.
- **Annotate Windows crash** — `process.exit(1)` while undici was draining triggered a libuv assertion (`UV_HANDLE_CLOSING` in `src\win\async.c`). Fixed with `process.exitCode = 1` + `connection: 'close'` header.

### 0.2.3 — scan quality + MCP hardening
Template literal hex detection (`` css`color: #1a73e8` ``). `.ts`/`.js` file scanning. MCP 60-second timeout with `FIXEL_MCP_TIMEOUT_MS` override. Automated test suite added (`npm test` now actually runs tests).

### 0.2.1 — config optional
`fixel scan` no longer hard-fails without a config file — detects framework from `package.json`, falls back to built-in defaults. OpenAI provider removed (was silently broken; only Anthropic was ever called). `fixel verify --node` without `--component` now errors explicitly instead of silently applying one node's data to every component.

### 0.2.0 — local scan + MCP server
`fixel scan <path>`: audit React files for prohibited design patterns, no Figma call, no API key required. `fixel-mcp`: MCP server exposing `fixel_scan`, `fixel_verify`, `fixel_annotate` as tools. Compatible with Claude Code and any Model Context Protocol host.

## Install

```sh
npx fixel scan ./src
```

npm: [fixel@0.2.5](https://www.npmjs.com/package/fixel/v/0.2.5)
