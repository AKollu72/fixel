# Fixel

CI guard for AI-generated React — token-level drift detection against Figma,
prohibited-pattern enforcement, and findings posted back to the design canvas.

[![npm](https://img.shields.io/npm/v/fixel)](https://www.npmjs.com/package/fixel)
[![npm downloads](https://img.shields.io/npm/dw/fixel)](https://www.npmjs.com/package/fixel)

## The problem

LLMs generate design values that are close-but-not-exact. A border radius
one step off the scale. A raw hex instead of the semantic token. An import
path that almost matches. Nothing crashes — it's quietly wrong, which is
worse. Prompting harder doesn't fix it: the model guesses when it should
look things up.

## How it works

Fixel's core bet: hallucination in code generation is an architecture
problem, not a prompting problem. Constrain what the model is allowed to
guess about, then verify the rest continuously.

**1. Prohibited-pattern enforcement.**
`fixel scan ./src` walks your React components and flags raw hex literals,
bare numeric border-radius in MUI sx, and rgb/rgba calls — anything that
bypasses your token system. No Figma call, no API key. Exits 1 in CI.

**2. Continuous drift detection.**
`fixel verify` reads the spec locked at generation time and checks whether the
current source still matches the Figma values. It exits 1 on drift. Add it to
your CI check and it runs offline — no Figma token needed.

**3. Findings back to the canvas.**
`fixel annotate` posts drift findings as anchored comments on the Figma frame,
deduplicating via `resolved_at` so a resolved comment does not repost until
drift recurs.

**4. Deterministic extraction + constrained generation.**
`fixel generate` fetches the Figma node, resolves every colour and spacing
value to a semantic token before the LLM sees it, and audits the output before
writing any file. The model handles structure; Fixel handles the values.

## Quickstart

```sh
npx fixel scan ./src
```

No config needed for local scan — if `fixel.config.json` is present, fixel
reads your framework and token settings from it. For the full pipeline
(import → generate → verify → annotate), start with:

```sh
npx fixel init
```

**Windows (PowerShell):** If you see "running scripts is disabled on this
system", run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once in an
elevated prompt, or use `npx fixel <command>` throughout.

| Command | What it does |
|---------|-------------|
| `fixel scan <path>` | Audit React files for prohibited patterns — no Figma call |
| `fixel verify` | Drift detection — offline, fast, exits 1 on mismatch |
| `fixel annotate` | Post drift findings as anchored comments on the Figma frame |
| `fixel import` | Read Figma published styles → write token file + typography config |
| `fixel init` | Interactive project setup → write `fixel.config.json` |
| `fixel scan --node FILEKEY:NODEID` | Token gap analysis for a Figma node before generating |
| `fixel generate` | Generate a component, stories, and spec tests from a Figma node |

## MCP server

Fixel ships a Model Context Protocol server so AI coding agents can run
verification directly.

Add to your MCP host config (e.g. Claude Desktop's `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "fixel": {
      "command": "fixel-mcp",
      "env": {
        "FIGMA_ACCESS_TOKEN": "your_figma_pat"
      }
    }
  }
}
```

Tools exposed:

| Tool | Description |
|------|-------------|
| `fixel_scan(path)` | Audit local React files — same as `fixel scan <path>` |
| `fixel_verify(component?, node?)` | Drift detection against stored spec |
| `fixel_annotate(component, node)` | Post findings to Figma canvas |

## Prerequisites

**Node.js ≥ 18.**

**Figma personal access token** — create at figma.com → Account → Settings
→ Security → Personal access tokens. Required scopes:

| Scope | Required for |
|-------|-------------|
| Read file contents | All commands except `fixel scan <path>` and `fixel verify` |
| Read metadata | All commands except `fixel scan <path>` and `fixel verify` |
| Create, modify, delete comments | `fixel annotate` only |

**AI API key** — for `fixel generate` only; all other commands work without
one.

> A Claude.ai or Claude Code subscription does not include Anthropic API
> access. `fixel generate` requires a separate pay-as-you-go key from
> [console.anthropic.com](https://console.anthropic.com).

Add credentials to `.env.local` in your project root — fixel loads this
automatically:

```sh
FIGMA_ACCESS_TOKEN=your_figma_pat
ANTHROPIC_API_KEY=your_anthropic_key   # or OPENAI_API_KEY
```

## Commands

### `fixel scan`

Two modes:

**Local mode** — `fixel scan <path>`

Walks all `.tsx` and `.jsx` files under `<path>` and checks each one for
prohibited design patterns. Reads framework and token settings from
`fixel.config.json`; if no config is found, falls back to built-in defaults.

Checks run:

| Pattern | What it catches |
|---------|----------------|
| `raw-hex` | `'#1a73e8'` or any hex literal inside a string |
| `raw-rgba` | `rgba(...)` or `rgb(...)` calls in component code |
| `bare-border-radius` | `borderRadius: 6` in MUI sx (renders as 24px, not 6px) |
| `tailwind-raw-hex-arbitrary` | `className="bg-[#1a73e8]"` — hex inside Tailwind brackets |
| `tailwind-raw-rgb-arbitrary` | `className="bg-[rgba(0,0,0,0.5)]"` — rgb inside Tailwind brackets |

```sh
fixel scan ./src
fixel scan ./src/components/Badge
```

Exit codes: `0` clean · `1` violations found or fatal error

**Figma mode** — `fixel scan --node FILEKEY:NODEID`

Token gap analysis. Fetches a Figma node, classifies each unique fill as
reachable, primitive-only, or new, and prints a ready-to-paste token patch
for anything not yet covered. Always exits 0 — missing tokens are a report,
not a failure.

```sh
fixel scan --node FILEKEY:NODEID
fixel scan --node FILEKEY:NODEID --group badge
fixel scan --node FILEKEY:NODEID --group badge --write
```

The `FILEKEY` and `NODEID` come from the Figma URL:
`https://www.figma.com/file/FILEKEY/...?node-id=NODEID`

Exit codes: `0` always (run before `fixel generate`) · `1` fatal error only

### `fixel import`

Reads published FILL and TEXT styles from a Figma file and generates:

- **Token file** (`tokens.ts`) — `export const semantic = {...} as const`
  with every color token, named from the style path.
- **Typography scale** — `(fontSize, fontWeight)` pairs merged into
  `fixel.config.json` as `typography.scale` entries.

If `tokens.ts` already exists, prints a merge patch instead of overwriting.
Typography config is always merged without touching existing keys.

```sh
fixel import --file FILEKEY            # preview — write nothing
fixel import --file FILEKEY --write    # write tokens.ts + merge config
fixel import --file FILEKEY --no-cache # bypass 24-hour cache
```

### `fixel init`

Interactive project setup. Auto-detects framework from `package.json`
dependencies. Safe to re-run.

```sh
fixel init
fixel init --yes   # accept all defaults
```

### `fixel generate`

Runs an eight-step pipeline: fetch → extract design values → build prompts →
generate component (LLM) → audit for prohibited patterns → generate stories
(LLM) → generate spec tests (LLM) → write `.fixel.json` spec.

Generation aborts before writing if the audit finds any error-severity
violations.

```sh
fixel generate --name Badge --node FILEKEY:NODEID
fixel generate --name Badge --node FILEKEY:NODEID --dry-run
fixel generate --name Badge --node FILEKEY:NODEID --force
fixel generate --name Badge --node FILEKEY:NODEID --skip-tests
fixel generate --name Badge --node FILEKEY:NODEID --figma-depth 8
```

Output:

```
src/components/Badge/
  Badge.tsx
  Badge.stories.tsx
  __tests__/Badge.fixel.test.tsx
  Badge.fixel.json        ← spec used by fixel verify
```

### `fixel verify`

Drift detection. Reads each `.fixel.json` spec and checks that the current
source still matches the Figma values recorded at generation time. Runs
offline by default — no Figma token needed in CI.

Checks: typography tokens present, spacing values, icon sizes, raw hex
values, border radii.

```sh
fixel verify                                           # all components
fixel verify --component Badge                         # one component
fixel verify --component Badge --node FILEKEY:NODEID   # live re-fetch
```

Exit codes: `0` all pass · `1` drift detected · `2` no spec files found

> Components without a `.fixel.json` spec are silently skipped. Run
> `fixel generate` to create the spec.

### `fixel annotate`

Posts drift findings as a comment anchored to the component's Figma frame.
Checks for an existing open `[Fixel]` comment before posting; skips if one
exists, and posts fresh after a designer resolves it.

```sh
fixel annotate --component Badge --node FILEKEY:NODEID
fixel annotate --component Badge --node FILEKEY:NODEID --dry-run
```

> `fixel annotate` is not automatic. It must be triggered manually or wired
> into CI as an opt-in step requiring a stored Figma token.

## CI setup

```yaml
name: Fixel spec check

on:
  pull_request:

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 18
          cache: npm
      - run: npm ci
      - run: npx fixel scan ./src      # prohibited patterns — no token needed
      - run: npx fixel verify          # drift detection — no token needed
```

Exit codes propagate correctly — `1` fails the check, `2` exits cleanly
when no specs exist yet. No Figma token needed for either step.

To post findings to the Figma canvas on drift:

```yaml
      - name: Annotate Figma on drift
        if: failure()
        run: npx fixel annotate --component MyComponent --node FILEKEY:NODEID
        env:
          FIGMA_ACCESS_TOKEN: ${{ secrets.FIGMA_ACCESS_TOKEN }}
```

## Configuration

`fixel.config.json` — see `fixel.config.example.json` for the full schema.

```json
{
  "figma": { "accessToken": "${FIGMA_ACCESS_TOKEN}" },
  "framework": "tailwind",
  "tokens": {
    "file": "src/tokens/colors.ts",
    "importPath": "@/tokens/colors",
    "semanticExport": "semantic"
  },
  "typography": {
    "importPath": "@/tokens/typography",
    "scale": {
      "14/400": { "token": "bodySm", "lineHeight": "20px" },
      "14/500": { "token": "bodySmMedium", "lineHeight": "20px" }
    }
  },
  "ai": { "provider": "anthropic", "model": "claude-sonnet-4-6" }
}
```

`figma.accessToken` must be an environment variable reference — never a
literal value.

Supported frameworks: `tailwind`, `mui`. Supported AI providers: `anthropic`
(reads `ANTHROPIC_API_KEY`), `openai` (reads `OPENAI_API_KEY`).

## Known limitations

**Figma Variables not supported** — `fixel import` reads published styles
(Styles panel) only. Figma Variables require an Enterprise-plan REST endpoint
not publicly available. Publishing a style library requires a paid Figma plan
— free-plan users can manually edit `tokens.ts` with their color values as a
workaround.

**Instance node colors not collected** — `fixel scan --node` and `fixel import`
do not traverse Figma component instances (INSTANCE nodes). Colors defined
inside nested sub-components are not collected. Add these tokens manually to
`tokens.ts`, then re-run `fixel scan --node` to confirm coverage.

**MUI and Tailwind only** — other frameworks receive generic rules with
limited accuracy.

**`fixel annotate` is not automatic** — manual or opt-in CI step only.

## License

FSL-1.1 licensed (converts to MIT after two years). See [LICENSE](LICENSE).
