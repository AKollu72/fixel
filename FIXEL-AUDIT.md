# FIXEL — INTERNAL PRODUCT AUDIT
**Version:** 0.2.0 (published 2026-09-09)  
**Purpose:** Source of truth for interviews, launch posts, and positioning. Not for distribution.  
**Method:** Every claim below was verified against the source code, not the README.

---

## 1. WHAT FIXEL IS

Fixel is a Node.js CLI that catches design-token violations in React component code and detects drift between a component's source and the Figma node it was generated from. It has two independent value propositions: (1) a static pattern scanner (`fixel scan <path>`) that walks `.tsx`/`.jsx` files and flags hardcoded hex values, raw rgba() calls, and bare border-radius numbers — no network call, no AI; and (2) a spec-based drift detector (`fixel verify`) that compares component source against a JSON spec written by its companion code generator (`fixel generate`), which is an Anthropic-only AI pipeline that fetches a Figma node, resolves design values to tokens, generates the component via LLM, and writes the spec. The MCP server is a thin stdio wrapper that spawns child processes for each tool call and has not been tested against a real MCP host. Version 0.2.0 also ships a bug fix (`findApproximatedTokens`) that had been missing from the codebase since it was first referenced in generate.ts and an argv-parsing fix that was caught during smoke testing.

---

## 2. WHAT IT DOES — COMMAND BY COMMAND

### `fixel scan <path>` (local mode) — NEW in 0.2.0

**What it does, step by step:**
1. Calls `loadEnvFile()` — reads `.env.local` if present.
2. Calls `loadConfig()` — reads `fixel.config.json` from the current working directory. **Fails hard with a FixelConfigError if no config exists.** There is no fallback or graceful degradation.
3. Checks `config.tokens.file` exists on disk. If not, exits 1 with a pointer to `fixel import`.
4. Recursively walks `<path>`, collecting `.tsx` and `.jsx` files. Skips: `node_modules`, `.git`, `dist`, `build`, `.next`, `coverage`. Does NOT scan `.ts` or `.js` files.
5. For each file: reads the file as UTF-8, calls `auditCode(code, config)`, collects violations.
6. Prints violations by file with line:column, pattern name, snippet, and the first line of the suggestion.
7. Exits 1 if any `error`-severity violations found; exits 0 if clean.

**Requires:** `fixel.config.json` in cwd (not optional despite what README implies). Token file must exist at `config.tokens.file`.

**What it actually detects (from audit.ts BUILT_IN_PATTERNS):**

| Pattern | When it fires | Framework gate |
|---------|--------------|----------------|
| `raw-hex` | `'#xxxxxx'` or `"#xxxxxx"` inside single or double quotes | Always |
| `raw-rgba` | `rgba(` or `rgb(` anywhere in non-comment code | Always |
| `bare-border-radius` | `borderRadius: N` (bare number, not `'Npx'`) | MUI only |
| `tailwind-raw-hex-arbitrary` | `[#xxxxxx]` inside a className | Tailwind only |
| `tailwind-raw-rgb-arbitrary` | `[rgba(...)]` inside a className | Tailwind only |

**What it silently misses:**
- Hex in backtick template literals: `` color={`#1a73e8`} `` — NOT caught by `raw-hex` (regex only matches single/double quotes)
- Hex values in CSS-in-JS `css` tagged template literals or `styled.div` blocks
- `styled-components`, `emotion`, or any non-className/non-prop pattern
- `bare-border-radius` only fires for MUI (`frameworks: ['mui']`). Tailwind users get no border-radius check.
- `missing-imports` — NOT in the default `prohibitedPatterns` list; won't run unless explicitly configured
- `lineHeight-override` — same: not in default list
- Spacing values, typography token names, icon sizes — these are only checked by `fixel verify` (requires a spec)
- Files with `.ts` or `.js` extensions — not collected by `collectReactFiles`
- Violations in `.css`, `.scss`, or CSS Module files

**Exit behavior:** 0 = clean or no files found; 1 = violations found OR fatal error (config missing, path not found)

**Limitation — single-quote escape hatch inconsistency:** `// fixel-ignore` suppresses `bare-border-radius` and the two Tailwind patterns but NOT `raw-hex` or `raw-rgba`. Those two have no escape hatch.

---

### `fixel scan --node FILEKEY:NODEID` (Figma mode)

**What it does:**  
Fetches the Figma node (with 24-hour disk cache in `node_modules/.cache/fixel/`), extracts all SOLID fills, compares them against the project's token file, and prints a three-category report (reachable / primitive-only / new) with a suggested TypeScript patch. Always exits 0.

**Requires:** `fixel.config.json`, `FIGMA_ACCESS_TOKEN` env var, network.

**Limitations:**
- INSTANCE node colors are skipped (fills inside nested sub-components not collected)
- Only SOLID fills. Gradients, images, and pattern fills are silently ignored.
- Detects hex values in the token source file by regex (`/['"]#([0-9a-fA-F]{3,8})['"]/g`) — will miss tokens stored as CSS variables or computed values

---

### `fixel verify`

**What it does:**  
Walks `config.output.componentDir` looking for subdirectories with both `ComponentName.tsx` and `ComponentName.fixel.json`. Runs five check categories against each:

1. **Typography** — looks for `variant="TOKEN"` (MUI) or `typography-token-name` class (Tailwind). Regex: `(?:variant=|[=:]\s*)["'\`]TOKEN["'\`]`. Misses token in non-variant props, CSS-in-JS.
2. **Spacing** — checks whether each recorded px value appears in the source as `'Npx'`, `"Npx"`, bare `N`, or MUI grid shorthand (`px: N/8`). High false-positive rate: `N` as a bare number matches any digit in any context.
3. **Icon sizes** — same px search as spacing.
4. **Raw hex** — single regex check: `/['"]#[0-9a-fA-F]{3,8}['"]/` on the entire file. Only one match reported even if many exist.
5. **Border-radius** — MUI: checks for `'Npx'` string; Tailwind: checks for named utilities or `rounded-[Npx]`.

**Critical bug in live mode (`--node`):** When run as `fixel verify --node FILEKEY:NODEID` WITHOUT `--component`, ALL components in the directory get verified against the SAME single Figma node. This is almost certainly unintended behavior for any repo with more than one component — component B's spec gets compared to component A's live Figma data.

**Requires:** `fixel.config.json`. In offline mode: only `.fixel.json` spec files. In live mode: `FIGMA_ACCESS_TOKEN` and the correct node ID per component.

**Exit codes:** 0 = all pass (warnings OK); 1 = drift found; 2 = no spec files found (CI-safe for fresh repos)

**Discovers components by:** `.tsx` files only in `config.output.componentDir/ComponentName/`. Flat structures, `.jsx`, or differently-named source files are silently skipped.

---

### `fixel annotate`

**What it does:**  
Takes `--component` and `--node` (both required). Reads the stored spec, runs the identical `runDriftChecks` as verify, and posts a `[Fixel]` comment to the Figma node. Before posting, it fetches all existing comments for the file and skips if an open `[Fixel]` comment already targets the same node. Deduplication is by `node_id` + `message.startsWith('[Fixel]')` + `!resolved_at`.

**Limitations:**
- One component at a time only. No bulk annotation.
- Comment is flat text — no rich formatting, no line-level anchoring within Figma.
- Fetches ALL comments for the file to check for duplicates. On files with thousands of comments, this could be slow or hit pagination issues (the comment list is not paginated — it fetches the full list in one call).
- Requires a stored spec (`.fixel.json`) — cannot annotate without having previously run `fixel generate`.

**Requires:** `fixel.config.json`, `FIGMA_ACCESS_TOKEN` with comments-write scope.

---

### `fixel generate`

**What it does:**  
An 8-step pipeline:  
1. Fetch Figma node  
2. Extract typography, spacing, icon sizes, corner radii deterministically  
3. Build system prompt + token file as context  
4. Warn about approximated colors (new in 0.2.0 — was broken until now)  
5. Generate component via LLM  
6. Audit component with `auditCode()` — blocks write if errors found  
7. Generate Storybook stories via LLM  
8. Generate spec tests via LLM; write `.fixel.json` spec

**Critical limitation — OpenAI support is broken:** `config.ai.provider: "openai"` is recognized for API key resolution (reads `OPENAI_API_KEY`) but `callAI()` unconditionally uses `new Anthropic({ apiKey })`. The OpenAI key gets sent to Anthropic's API and fails with a 401. Anthropic is the only working provider.

**Requires:** `fixel.config.json`, `FIGMA_ACCESS_TOKEN`, `ANTHROPIC_API_KEY` (OpenAI config will fail), network.

**Limitations:**
- AI model is hardcoded to the configured model string — no validation that the model supports the feature set used (cache_control, 16K output)
- `selectRepresentativeVariants` picks up to ~3 variants for the prompt — complex components with many variants may have coverage gaps
- Stories and tests are generated with `auditCode()` but only the component blocks write on audit failure; stories failure prints a warning and continues

---

### `fixel import`

**What it does:** Fetches published FILL and TEXT styles from a Figma file (not a node), generates a `tokens.ts` TypeScript export object and merges typography scale entries into `fixel.config.json`.

**Critical limitation:** Only reads **published** Figma styles. Styles must be explicitly published from within Figma — this requires a paid Figma plan. Free-plan files do not publish styles. Users on free plans will get empty output with no error.

**Figma Variables not supported** — the README says this, but it's worth stating plainly: the Figma Variables API (the modern token system) is Enterprise-only and not implemented.

---

### `fixel init`

Interactive setup using `@inquirer/prompts`. Auto-detects framework from `package.json`. Safe to re-run. No limitations beyond what's documented.

---

### MCP tools: `fixel_scan`, `fixel_verify`, `fixel_annotate`

**How they work:** The MCP server (`fixel-mcp-bin.js → dist/mcp/server.js`) uses `require('@modelcontextprotocol/sdk/...')` via CommonJS and exposes three tools. Each tool call uses `spawnSync()` to invoke `node fixel-bin.js <command> [args]` synchronously, captures stdout+stderr, and returns the output as a text block.

**What this means in practice:**
- `spawnSync` blocks the Node event loop for the duration of the child process. Long-running commands (network calls in `fixel_verify --node` or `fixel_annotate`) will block all other MCP operations.
- No timeout is set on `spawnSync`. A hung Figma API call will hang the MCP server indefinitely.
- `fixel_scan(path)` is the only tool that can realistically work offline.
- The CJS `require` of the MCP SDK at `.js` paths may fail if the SDK ships only ESM in newer versions. This was not tested against the installed 1.30.0 — run `node -e "require('@modelcontextprotocol/sdk/server/index.js')"` to verify.
- **Never tested against a real MCP host.** The implementation looks correct but is untested end-to-end.

---

## 3. HOW IT'S PORTRAYED vs WHAT'S TRUE

| Claim | Reality | Verdict |
|-------|---------|---------|
| "No config needed for local scan" (README quickstart) | Requires `fixel.config.json` in cwd. Missing config → hard exit with FixelConfigError | **Overstated** |
| "Supported AI providers: anthropic, openai" (README, config) | `callAI()` unconditionally uses `new Anthropic(...)`. OpenAI config reads the env var then sends it to Anthropic's API → 401 | **Inaccurate** |
| "`fixel generate` uses cache_control: ephemeral for prompt caching" | True, Anthropic SDK only | **Accurate** |
| "fixel verify runs offline by default — no Figma token needed in CI" | True for offline mode | **Accurate** |
| "fixel annotate deduplicates via resolved_at" | True — checks `!resolved_at` on existing `[Fixel]` comments | **Accurate** |
| "Exits 1 on violations" (fixel scan local) | True | **Accurate** |
| "Exit 2 when no spec files exist" (verify) | True | **Accurate** |
| "Continuous drift detection" | Not continuous — runs on demand. "Continuous" is marketing for "every PR" | **Overstated** |
| "MCP server exposes fixel_scan, fixel_verify, fixel_annotate" | True, via spawnSync | **Accurate** |
| "MCP compatible with Claude Desktop and any MCP host" | Implementation is spec-correct (stdio, ListTools, CallTool) but untested | **Unverified** |
| "No raw hex / rgba patterns in generated code" (audit gate) | True — audit blocks writes on error-severity findings | **Accurate** |
| Show HN post: "you can run fixel generate pointing LLM at a Figma node" | True but implies OpenAI works; it doesn't | **Overstated** |
| CHANGELOG: "findApproximatedTokens: fix missing export" | Accurate — it was entirely missing, not just unexported | **Understated** |
| `"fix missing export in tokens.ts"` in commit message | Same — it was missing entirely, not just unexported | **Understated** |

---

## 4. WHO IT'S USEFUL FOR — HONESTLY

### Persona A: Team already using fixel generate (the core user)
**Setup required:** Anthropic API key, Figma PAT, `fixel.config.json`, published token file, components generated by fixel with `.fixel.json` specs.  
**What fixel does for them:** verify and annotate give genuine CI enforcement — spec-based drift detection that catches actual post-generation edits that broke token fidelity.  
**What would make them churn:** OpenAI preference (broken), Figma Variables usage (not supported), anything but `.tsx` component files, anything but `tailwind` or `mui` frameworks.

### Persona B: Solo dev who wants a lint-style raw-hex check (new user for 0.2.0)
**Setup required:** `fixel.config.json` with `framework` and `tokens.file` set. Token file must exist.  
**What fixel does:** Catches raw hex, rgba, and framework-specific patterns in React files. Useful drop-in for a lint step.  
**What would make them churn:** Discovering config is required ("no config needed" in README is wrong); discovering that `.ts` files and template-literal hex are missed; discovering that `bare-border-radius` only works for MUI.

### Persona C: AI coding agent developer who wants MCP verification tools
**Setup required:** fixel installed, fixel.config.json in project, `FIGMA_ACCESS_TOKEN`.  
**What fixel does:** Gives the agent a `fixel_scan` tool that can audit React code offline.  
**What would make them churn:** Discovering `spawnSync` blocks the server; discovering the MCP server is untested; discovering `fixel_verify` and `fixel_annotate` are useless without a pre-existing `.fixel.json` spec.

### Who fixel is NOT for:
- Teams using Figma Variables (not supported — the relevant endpoint is Enterprise-only)
- Developers who want to verify non-Figma generated code with no existing spec
- OpenAI API users (broken — Anthropic-only despite config claiming otherwise)
- Vue, Svelte, Angular, or non-React projects
- Teams generating components into flat directories (verify looks for `ComponentDir/ComponentName.tsx`)
- Free-plan Figma users who need `fixel import` (published styles require paid plan)
- Anyone wanting to scan `.ts` or `.js` files for token violations

---

## 5. OLD vs NEW (v0.1.6 → v0.2.0)

### What v0.1.6 was:
- Six commands: `import`, `init`, `scan --node`, `generate`, `verify`, `annotate`
- All scan/generate/verify required a Figma node ID — no local-only mode
- Description: "The complete Figma-to-React pipeline — generate components from Figma, enforce design parity in CI, and close the loop back to designers."
- `findApproximatedTokens` referenced in generate.ts but not exported from tokens.ts → build was broken (this was not caught before publishing because the dist/ directory was presumably committed or the build was not tested pre-publish)

Wait — on reflection: 0.1.6 published successfully to npm via `prepublishOnly: npm run build`. That means the build succeeded in 0.1.6. The `findApproximatedTokens` error must have either not existed in the 0.1.6 source or the generate.ts was different. The error was present in the local working copy when this 0.2.0 session began, but may have been introduced between the npm publish and this session. This is not resolvable without the git log for the commits between 0.1.6 and now.

### What changed in 0.2.0:
| Change | Real delta |
|--------|-----------|
| `fixel scan <path>` local mode | New code path in scan.ts; reuses existing `auditCode()` engine. Genuine new capability for existing token file users. |
| MCP server (`fixel-mcp`) | New file, new bin entry. Thin wrapper using spawnSync. No new capability beyond what the CLI already does. |
| `findApproximatedTokens` export | Bug fix — function was referenced in generate.ts but did not exist in tokens.ts. Fixed by adding the implementation. |
| argv slice(3) fix | Bug found during smoke testing — scan.ts was reading the command word "scan" as the path argument. Fixed same session. |
| README repositioned | Verify+scan lead; generate moves down. No code change. |
| CHANGELOG.md | New file. |
| launch/ artifacts | Two draft documents. No product change. |
| Keywords, description | Metadata only. |

### What did NOT change:
- The audit engine (`auditCode`, all six patterns) — identical to 0.1.6
- The drift check logic (`runDriftChecks`, `auditAgainstSpec`) — identical
- The Figma client, cache, retry logic — identical
- The generate pipeline — identical (minus the now-fixed missing function)
- The verify, annotate, import, init commands — identical
- The broken OpenAI provider path — still broken in 0.2.0

**Honest assessment:** 0.2.0 is roughly 60% repackaging (repositioned description, README restructure, launch assets) and 40% new capability (local scan mode, MCP server). The local scan mode is real and useful. The MCP server is real but untested.

---

## 6. COMPETITIVE POSITION

**Ecosystem context:**
- **Figma's native AI QA** (as of 2026): Figma has its own dev mode, variable inspection, and some AI-assisted annotation, but no code-side token enforcement — it's design-side only.
- **figma-map / Tokens Studio plugins**: Handle the Figma Variables → CSS variables → code side of the pipeline. Don't enforce code correctness; produce token files.
- **ESLint plugins (eslint-plugin-no-color-literals, etc.)**: Catch hardcoded values but framework-unaware, no Figma connection, no spec comparison.
- **Applitools / Percy (screenshot diffing)**: Visual regression at the rendered-pixel level. Complementary, not competing — they catch rendering differences after the fact; fixel catches token violations in the source before rendering.
- **Chromatic**: Visual testing, story-driven. Same as above.

**Where fixel has genuine daylight:**
- Spec-based drift detection: the `.fixel.json` lock-file approach — checking that the SPECIFIC values from the Figma node (not just any token usage) are present — is not replicated by ESLint or visual diff tools.
- Pre-write audit gate in generate: the LLM output is rejected before any file is written, which is architecturally different from post-hoc linting.
- The Figma-to-code loop (annotate posting back) has no obvious open-source equivalent.

**Where fixel is behind:**
- Figma Variables support: the modern Figma token system (variables) is entirely unsupported. Any team using Variables over styles gets zero value from `fixel import`.
- Test coverage and production hardening: zero automated tests means regressions are silent.
- Framework support: only `tailwind` and `mui`. No `styled-components`, no CSS Modules enforcement (stub only), no Emotion.
- The quickstart is blocked by config requirements that aren't disclosed upfront.

**The one true differentiator:**  
Fixel enforces token fidelity at the source level — not by comparing screenshots, not by linting generic patterns, but by verifying that the exact Figma values recorded at generation time are still present in the component source code.

---

## 7. QUALITY REALITY CHECK

### Test coverage
**Automated tests: zero.** There are no test files in `src/`. `npm test` runs `jest --passWithNoTests` and exits 0. The only tests that exist are the `.fixel.test.tsx` files generated for user projects.

### What's tested in practice:
- Regression tests from the earlier session (Tests 1–8) were manual CLI invocations against a test repo, not automated. They are not repeatable or CI-tracked.
- The smoke test in the 0.2.0 session was one run of `fixel scan ./src` against `fixel-journey-test`. Not a regression suite.

### Riskiest untested paths:

| Path | Risk | Why |
|------|------|-----|
| MCP server end-to-end | High | Never tested against a real host. spawnSync + CJS SDK import untested. |
| `fixel verify --node` with multiple components | High | Bug: all components get the same node's data. Silently wrong results. |
| `fixel import` on a real Figma file with published styles | Medium | Works in theory; last manual test was against a specific known file. |
| `fixel generate` on complex components (deep nesting, many variants) | Medium | Representative variant selection is heuristic; untested at scale. |
| Windows path handling in `collectReactFiles` | Medium | Smoke test was Windows, but path.relative and path.join were used correctly; no known bugs, but not exhaustively tested. |
| `findApproximatedTokens` correctness | Medium | Implementation written this session, never validated against real token files. The RGB threshold of 30 is a guess. |
| Local scan on repos with `.ts`+`.tsx` split | Low-Medium | `.ts` files silently skipped — users expecting them to be scanned won't get an error. |

### Known bugs:
1. **OpenAI provider broken**: `callAI()` always uses Anthropic client. Setting `provider: "openai"` in config sends the OpenAI API key to Anthropic's endpoint → 401.
2. **`fixel verify --node` without `--component`**: applies one node's live data to all components. Unambiguous bug.
3. **`raw-hex` doesn't catch backtick template literals**: `color={`#1a73e8`}` is not caught.
4. **Comment pagination in annotate**: `listComments` fetches all file comments in one call. No pagination handling — large Figma files with thousands of comments may truncate results or time out.
5. **README "No config needed" claim**: false. Local scan requires `fixel.config.json`.

### Tech debt:
- `normalizeNodeArg` is copy-pasted identically in `scan.ts`, `verify.ts`, `annotate.ts`, and `generate.ts`. Should be a shared util in config.ts or a new core file.
- Error handling in generate.ts's AI call is Anthropic-specific (`instanceof Anthropic.RateLimitError`) — the openai path, if ever fixed, would need separate rate-limit handling.
- The `APPROX_THRESHOLD = 30` in the new `findApproximatedTokens` is unjustified. No data or documentation for why 30 is the right cutoff.

---

## 8. IF SOMEONE TRIES IT COLD (the 10-minute stranger test)

### Scenario A: Repo with a `fixel.config.json` and a populated token file

```sh
npx fixel scan ./src
```

**What happens:** Works. Finds React files, runs audit, prints violations (if any) with line numbers and patterns. Good first impression. Output is readable.

**Likely confusion:** They'll probably expect `.ts` files to be scanned too. If they see a `.ts` utility file with hardcoded hex, nothing gets flagged. They won't know why.

---

### Scenario B: Typical React repo, NO `fixel.config.json`

```sh
npx fixel scan ./src
```

**What happens:**
```
  Config error: fixel.config.json not found at:
  /Users/them/my-app/fixel.config.json
  Run "fixel init" to create one.
```

**Reality check vs README:** README says "No config needed for local scan." This is false. The stranger reads the README, runs the command, gets a config error on the first try. This is the highest-risk friction point for new users. They'll either run `fixel init` (reasonable) or bounce.

---

### Scenario C: Empty directory or non-React project

```sh
npx fixel scan ./src   # after fixel init creates a config
```

**What happens:**
```
  fixel scan  local
  Path:      ./src
  Framework: mui
  Tokens:    src/tokens/colors.ts

  Token file not found: src/tokens/colors.ts
  Run "fixel import --file FILEKEY --write" to generate it.
```

Or, if token file exists but no `.tsx`/`.jsx` files:
```
  No .tsx / .jsx files found under ./src
```

**Assessment:** Graceful. Exit 0. Message is clear. The `fixel import` pointer is correct but requires a Figma file key that the user may not have handy.

---

### The 10-minute verdict

A developer who reads the README, runs `npx fixel scan ./src`, and has no config will fail on the first attempt with a confusing error given the documented promise. If they push through and run `fixel init`, they then need a token file, which means either manually editing `tokens.ts` or running `fixel import` with a Figma file key. The genuine quick path is: "I already use Figma, I have a PAT, I have a design token file" — that stranger will get value in under 10 minutes. Everyone else needs more setup than advertised.

---

## 9. THE HONEST ONE-PAGER

**What Fixel is:**  
Fixel is a CLI that enforces design-token fidelity in React components — catching hardcoded hex values and rgba calls with a local scan, and detecting drift between component source code and the Figma spec it was generated from. The token-gap analysis and AI-powered generation features require Figma credentials and an Anthropic API key.

**Strengths:**
- The spec-based drift check (`fixel verify`) is architecturally sound and has no direct open-source equivalent — it locks the exact Figma values at generation time and fails CI on divergence
- The pre-write audit gate in `fixel generate` is genuinely useful: the LLM output is rejected before any file is written, not caught later
- The local scan (`fixel scan ./src`) is a zero-API-key entry point that does real work in projects that already have a token file configured

**Weaknesses:**
- The README claim "No config needed for local scan" is false — `fixel.config.json` is required and its absence causes an error, not a fallback
- OpenAI provider support is completely broken; the code always calls Anthropic regardless of config
- Zero automated tests; every correctness claim rests on one manual smoke test

**The one-line differentiator:**  
Fixel is the only open-source tool that enforces Figma-specific design values — not just "use tokens", but "use the exact token values from this specific Figma node" — in CI without a browser or a screenshot.

**Single highest-impact improvement:**  
Fix the config-required failure mode for `fixel scan <path>`: either make `fixel.config.json` genuinely optional (fall back to `framework: "tailwind"`, skip the token file check with a warning) or correct the README. This is the first thing a new user hits and it directly contradicts the documented quick start. Five lines of code in `runLocalScan`, ten minutes of work, would close the gap between the promise and the reality.
