# Fixel

The complete Figma-to-React pipeline — generate components from Figma, enforce design parity in CI, and close the loop back to designers.

[![npm](https://img.shields.io/npm/v/fixel)](https://www.npmjs.com/package/fixel)

> Shipped a 60-component design system with 3,077 spec-lock tests in 35 business days with zero raw hex values across all components.

The pipeline has six commands:

| Command | What it does |
|---|---|
| `fixel init` | Interactive project setup (writes `fixel.config.json`) |
| `fixel import` | Read published Figma styles → write your token file + typography scale |
| `fixel scan` | Token gap analysis before generating a component |
| `fixel generate` | AI-powered component generation from a Figma node |
| `fixel verify` | Drift detection — offline, fast, exits non-zero on mismatch |
| `fixel annotate` | Post drift findings as an anchored comment on the Figma frame |

---

## Why Fixel

|  | Screenshot-based tools | Figma MCP | Fixel |
|---|:---:|:---:|:---:|
| Exact token values | ❌ | ✅ | ✅ |
| Prohibited pattern enforcement | ❌ | ❌ | ✅ |
| CI drift detection on every PR | ❌ | ❌ | ✅ |
| Posts back to Figma canvas | ❌ | ❌ | ✅ |
| Works without AI for verification | ❌ | ❌ | ✅ |

Figma MCP gives an AI agent read access to Figma at generation time. Fixel adds enforcement: prohibited-pattern auditing before any file is written, and continuous drift detection in CI so the spec stays true after the component is merged.

![Fixel annotation on Figma canvas](https://gist.github.com/user-attachments/assets/3becbc8f-0333-443e-b2a3-a3698ab3e1c3)

---

## Prerequisites

### Node.js

Node.js ≥ 18.

### Figma personal access token

Create a PAT at figma.com → Account → Settings → Security → Personal access tokens.

Check these scopes — missing either Read scope is the most common cold-start failure:

| Scope | Required for |
|---|---|
| Read the contents of files | All commands (import, scan, generate, verify --node, annotate) |
| Read metadata of files | All commands |
| Create, modify and delete comments | `fixel annotate` only |

You can use a single token with all three scopes, or create two tokens — one read-only for CI and one with comments write for local use.

### AI API key

An Anthropic or OpenAI API key (for `fixel generate` only — all other commands work without one).

> **Note:** A Claude.ai or Claude Code subscription does not include Anthropic API access. `fixel generate` requires a separate pay-as-you-go API key from [console.anthropic.com](https://console.anthropic.com).

Anthropic free tier ($5 credit on signup) gives approximately 60–80 individual component generations (each `fixel generate` call produces one component). Note: free tier rate limits (5 RPM) can cause the third AI call in `fixel generate` to fail intermittently. A $5 deposit at console.anthropic.com immediately unlocks Tier 1 (50 RPM) and resolves this.

Estimated cost per component: ~$0.05–0.40 depending on component complexity with Claude Sonnet 4.6. Claude Haiku 4.5 is ~3× cheaper and works well for most design systems.

---

## Installation

```sh
npm install -g fixel
# or run without installing:
npx fixel init
```

**Windows (PowerShell):** If you see "running scripts is disabled on this system", run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once in an elevated PowerShell prompt. Alternatively, use `npx fixel <command>` which bypasses the restriction.

---

## Quick start

```sh
# 1. Create fixel.config.json
fixel init

# 2. Add credentials to .env.local (fixel loads this automatically)
echo "FIGMA_ACCESS_TOKEN=<your-figma-token>"  >> .env.local
echo "ANTHROPIC_API_KEY=<your-anthropic-key>" >> .env.local

# 3. Bootstrap your token file from Figma styles
fixel import --file FILEKEY --write

# 4. Token gap analysis before generating a component
fixel scan --node FILEKEY:NODEID --group badge

# 5. Generate the component
fixel generate --name Badge --node FILEKEY:NODEID

# 6. Verify it hasn't drifted
fixel verify --component Badge
```

The `FILEKEY` and `NODEID` are in the Figma URL: `https://www.figma.com/file/FILEKEY/...?node-id=NODEID`

URL-decode `%3A` → `:` to get the node ID (e.g., `397%3A23320` → `397:23320`).

---

## Commands

### fixel import

Reads published FILL and TEXT styles from a Figma file and generates the two files your project needs before `fixel scan` or `fixel generate` can run:

- **Token file** (`tokens.ts`) — an `export const semantic = {...} as const` object with every colour token derived from the file's FILL styles. Style names are split on `/` to form a nested path: `"Brand/Primary/Background"` → `semantic.brand.primaryBackground`.
- **Typography scale** — `(fontSize, fontWeight)` pairs from TEXT styles are merged into `fixel.config.json` as `typography.scale` entries. `"Label/Small"` at 11px/500 → `"11/500": { "token": "labelSm", "lineHeight": "16px" }`.

If `tokens.ts` already exists, fixel prints a paste-ready merge patch instead of overwriting. Typography config is always merged automatically (existing keys are never touched).

```sh
fixel import --file FILEKEY            # dry-run: preview output, write nothing
fixel import --file FILEKEY --write    # write tokens.ts + merge typography config
fixel import --file FILEKEY --no-cache # bypass 24-hour cache and re-fetch
```

> **Note:** This reads Figma styles (the Styles panel). Figma Variables use an Enterprise-gated REST endpoint and are not supported in v1 — see Known Limitations.

### fixel init

Interactive project setup. Asks for your framework, token file path, import paths, and AI provider. Auto-detects framework from `package.json` dependencies (`tailwindcss` → Tailwind, `@mui/material` → MUI). Safe to re-run — prompts before overwriting.

```sh
fixel init
fixel init --yes   # accept all defaults, no prompts
```

Also appends `.env.local`, `.fixel-scan.json`, and `node_modules/.cache/fixel/` to `.gitignore`.

### fixel scan

Token reconnaissance. Fetches a Figma node, extracts every unique SOLID fill, and classifies each colour as:

- **reachable** — already covered by a semantic token in your token file
- **primitive-only** — hex exists in a private ramp but has no semantic alias
- **new** — not present in the token file at all

Prints a ready-to-paste token patch for anything that isn't reachable. Always exits 0 — missing tokens are a report, not an error.

```sh
fixel scan --node FILEKEY:NODEID
fixel scan --node FILEKEY:NODEID --group badge
fixel scan --node FILEKEY:NODEID --group badge --write   # also writes .fixel-scan.json
fixel scan --node FILEKEY:NODEID --no-cache
```

### fixel generate

AI-powered component generation. Runs an 8-step pipeline:

1. Fetch Figma node
2. Deterministic extraction (typography, spacing, icon sizes, corner radii)
3. Build system prompt from config + token file
4. Build user message with trimmed Figma data
5. Generate component (AI)
6. Audit component for anti-patterns — aborts before writing if errors found
7. Generate Storybook stories (AI)
8. Generate spec-lock tests (AI) + write `.fixel.json` spec

```sh
fixel generate --name Badge --node FILEKEY:NODEID
fixel generate --name Badge --node FILEKEY:NODEID --dry-run
fixel generate --name Badge --node FILEKEY:NODEID --force
fixel generate --name Badge --node FILEKEY:NODEID --skip-tests
fixel generate --name Badge --node FILEKEY:NODEID --figma-depth 8
fixel generate --name Badge --node FILEKEY:NODEID --no-cache
```

Output:

```
src/components/
  Badge/
    Badge.tsx
    Badge.stories.tsx
    __tests__/
      Badge.fixel.test.tsx
    Badge.fixel.json    ← spec file used by fixel verify
```

### fixel verify

> ⚠️ Components without a `.fixel.json` spec are silently skipped. Run `fixel generate` to create the spec.

Drift detection. Reads each component's `.fixel.json` spec and checks that the current source still matches the Figma values recorded at generation time. Runs offline by default — no Figma token needed in CI.

| Check | Severity | Framework |
|---|---|---|
| Typography token present | error | MUI: `variant="TOKEN"`; Tailwind: `typography-{token}` kebab class |
| Spacing values (gap, padding) | warning | All |
| Icon sizes | warning | All |
| Raw hex values | error | All |
| Border-radius | error | MUI: `'Npx'` string; Tailwind: `rounded-[Npx]`, `rounded-full` for pill ≥100px |

```sh
fixel verify                                           # all components with specs
fixel verify --component Badge                         # one component
fixel verify --component Badge --node FILEKEY:NODEID   # live Figma re-fetch
fixel verify --no-cache
```

Exit codes: `0` = all pass · `1` = drift errors · `2` = no spec files found

### fixel annotate

> **Note:** `fixel annotate` does not run automatically — it must be triggered manually or wired into CI as an opt-in step.

Posts drift findings as a comment anchored to the component's Figma node.

```sh
fixel annotate --component Badge --node FILEKEY:NODEID
fixel annotate --component Badge --node FILEKEY:NODEID --dry-run
```

Duplicate prevention — before posting, fixel annotate checks for an existing open `[Fixel]` comment on the same node. If one exists, it skips. When a designer resolves the comment in Figma, the next run posts a fresh one.

Comment format:

```
[Fixel] Drift detected on Badge
• Border-radius 100px: rounded-[100px] or rounded-full (pill) not found
• Typography 11px / weight 500: typography-label-xs not found
Detected 2026-06-15 · automated spec check.
```

---

## CI setup

Add `fixel verify` as a required check on your main branch. No Figma token is needed in CI.

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
      - run: npx fixel verify
```

Exit codes: `0` = all specs match · `1` = drift detected · `2` = no spec files found

### Optional: Figma annotations

```yaml
      - name: Annotate Figma on drift
        if: failure()
        run: npx fixel annotate --component MyComponent --node FILEKEY:NODEID
        env:
          FIGMA_ACCESS_TOKEN: ${{ secrets.FIGMA_ACCESS_TOKEN }}
```

---

## Configuration

```json
{
  "framework": "mui",
  "figma": {
    "accessToken": "${FIGMA_ACCESS_TOKEN}"
  },
  "tokens": {
    "file": "src/styles/tokens.ts",
    "importPath": "@/styles/tokens",
    "semanticExport": "semantic",
    "constantsExport": "palette",
    "namingConvention": "semantic.{group}.{role}"
  },
  "typography": {
    "importPath": "@/styles/typography",
    "scale": {
      "14/400": { "token": "bodySm",       "lineHeight": "20px" },
      "14/500": { "token": "bodySmMedium", "lineHeight": "20px" }
    }
  },
  "ai": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-6"
  }
}
```

`figma.accessToken` must be an environment variable reference — never a literal value.

Supported frameworks: `tailwind`, `mui`.
Supported AI providers: `anthropic` (reads `ANTHROPIC_API_KEY`), `openai` (reads `OPENAI_API_KEY`).

---

## Anti-pattern detection

Default patterns (always active):

| Pattern | Severity | Frameworks |
|---|---|---|
| Raw hex string (`'#abc123'`) | error | All |
| Raw `rgba(...)` call | error | All |
| Bare `borderRadius: 8` (number in MUI sx) | error | MUI only |
| Hex inside Tailwind arbitrary value (`bg-[#1a73e8]`) | error | Tailwind only |

Add `// fixel-ignore` on any line to suppress a single violation.

---

## Known limitations

**Unspecced components** — `fixel verify` silently skips components without a `.fixel.json` spec. A batch `fixel bootstrap` command is planned for v2.

**Figma Variables not supported** — `fixel import` reads published styles (Styles panel) only. Figma Variables require an Enterprise-plan REST endpoint not publicly available. Publishing a style library requires a paid Figma plan — free-plan users can manually edit `tokens.ts` with their color values as a workaround.

**Figma API rate limits** — the free Figma Starter plan has significantly lower REST API rate limits. For teams running across 20+ components, a paid Figma plan is strongly recommended.

**MUI and Tailwind only** — other frameworks (`"css-modules"`, `"other"`) receive generic rules with limited accuracy.

**`fixel annotate` is not automatic** — it runs manually or as an opt-in CI step requiring a stored Figma token.

**Instance node colors not collected** — `fixel scan` and `fixel import` do not traverse Figma component instances (INSTANCE nodes). Colors defined inside nested sub-components are not collected. Add these tokens manually to `tokens.ts`, then re-run `fixel scan` to confirm coverage.

---

## Results

> Shipped 60+ React components with 3,077 spec-lock tests in 35 days. Zero raw hex values. Zero token hallucinations.

---

## Further reading

- [How I Shipped 60 Design System Components in 5 Weeks](https://dev.to/akollu72/how-we-shipped-60-design-system-components-in-5-weeks-using-figma-as-the-single-source-of-truth-1lkc)
- [Why AI Keeps Generating the Wrong Design Tokens](https://dev.to/akollu72/why-ai-keeps-generating-the-wrong-design-tokens-and-how-i-fixed-it-with-figmas-api-17o4)
- [Check Designs validates your Figma. What validates your code?](https://dev.to/akollu72/check-designs-validates-your-figma-what-validates-your-code-38c2)

---

## License

Functional Source License, Version 1.1 (FSL-1.1-MIT) — © 2026 Amrutha Kollu.

- Free to use, including commercially
- No competing products
- Converts to MIT two years after each release date