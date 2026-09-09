# MCP Smoke Test — fixel-mcp

Manual test script for verifying the fixel MCP server works end-to-end.
Run this against the `fixel-journey-test` fixture repo that already has
`fixel.config.json` and `src/tokens/colors.ts` in place.

**Prerequisite:** fixel 0.2.3 installed globally.

```sh
npm install -g fixel@0.2.3
```

---

## Step 1 — Register the MCP server

```sh
claude mcp add fixel -- fixel-mcp
```

Verify:

```sh
claude mcp list
```

Expected: `fixel` appears in the list with stdio transport.

---

## Step 2 — Verify CJS compatibility

Before opening Claude Code, confirm the SDK loads under CommonJS:

```sh
node -e "require('@modelcontextprotocol/sdk/server/index.js'); console.log('CJS OK')"
```

Expected output: `CJS OK` (no error).

---

## Step 3 — Tool: `fixel_scan`

Open Claude Code with `cwd` set to `fixel-journey-test`. Call:

```
Use fixel_scan on path "./src"
```

**Expected output shape:**

```
  fixel scan  local
  Path:      ./src
  Framework: tailwind   ← or mui, depending on your config
  Tokens:    src/tokens/colors.ts
  Files:     N

  ✓ No prohibited patterns found across N file(s).
```

OR if violations exist, each file prints its relative path with line:col, pattern, and snippet.

**Expected MCP behavior:**
- `content[0].text` = the scan output above
- `isError: false` if clean, `isError: true` if violations found

---

## Step 4 — Tool: `fixel_scan` with no config

In a directory with NO `fixel.config.json`, call `fixel_scan` with a path.

**Expected output** (new in 0.2.1):

```
  fixel scan  local
  Path:      ./src
  ⚠  No fixel.config.json — using built-in defaults
  Framework: tailwind (auto-detected)
  Files:     N
```

The scan should run without error. No hard exit.

---

## Step 5 — Tool: `fixel_verify` (offline)

```
Use fixel_verify with no arguments
```

**Expected:**
- If no `.fixel.json` spec files exist: exit code 2, message about `fixel generate`
- If specs exist: per-component drift report, `isError: false` if all pass

---

## Step 6 — Tool: `fixel_verify` with `--node` (requires `--component`)

```
Use fixel_verify with component "Badge" and node "FILEKEY:NODEID"
```

**Expected:** drift report for Badge only.

Without `--component`:
```
Use fixel_verify with node "FILEKEY:NODEID" (no component specified)
```

**Expected:** error — `--node requires --component` (guard added in 0.2.2). `isError: true`.

---

## Step 7 — Timeout behavior

Verify the timeout returns a clear error instead of hanging:

```sh
FIXEL_MCP_TIMEOUT_MS=1 fixel-mcp
```

Then from Claude Code, call `fixel_verify` with a `--node` argument (which triggers a Figma fetch).

**Expected output:**

```
[fixel-mcp] Command timed out after 1ms.
  Set FIXEL_MCP_TIMEOUT_MS env var to increase the limit.
  Args: fixel verify --component ... --node ...
```

`isError: true`.

---

## Step 8 — Tool: `fixel_annotate`

```
Use fixel_annotate with component "Badge" and node "FILEKEY:NODEID"
```

Requires `FIGMA_ACCESS_TOKEN` set in the MCP server env (add to `claude_desktop_config.json`).

**Expected:** Either posts a `[Fixel]` comment to the Figma frame, or prints a deduplication skip message if an open comment already exists.

---

## Checklist

- [ ] `fixel_scan` returns output for a valid path
- [ ] `fixel_scan` returns `isError: false` when clean, `isError: true` when violations found
- [ ] `fixel_scan` with no `fixel.config.json` falls back gracefully (no hard exit)
- [ ] `fixel_verify` with no args returns exit-2 message when no specs
- [ ] `fixel_verify --node` without `--component` returns clear error (`isError: true`)
- [ ] Timeout error message names `FIXEL_MCP_TIMEOUT_MS` and the timed-out command
- [ ] `fixel_annotate` either posts or skips — does not crash
- [ ] CJS compatibility check passes (`node -e "require(...)"`)
