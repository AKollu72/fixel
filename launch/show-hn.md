# Show HN: Fixel — lock Figma design values in CI for AI-generated React

If you generate React from Figma with AI, Fixel locks the exact design values and fails CI when they drift.

I'm the sole frontend engineer at an AI startup. Over 35 days we generated 60+ React components from Figma specs, and built 3,077 spec tests at work to catch when AI output drifted from the design. Fixel is a from-scratch open-source tool I built on nights and weekends — same problem, independent implementation.

What it does:

**`npx fixel scan ./src`** — no config, no API key, no Figma account. Flags raw hex literals, bare numeric border-radius in MUI sx, and rgba() calls that bypass your token system. Exits 1 in CI.

**`fixel verify`** — reads the `.fixel.json` spec locked at generation time and checks whether the current source still matches. Runs offline.

**`fixel-mcp`** — an MCP server so AI coding agents can verify their own output. Three tools: `fixel_scan`, `fixel_verify`, `fixel_annotate`. Tested with Claude Code as the host.

Honest scope: generation support is Anthropic-only. Scan and verify work without any AI. React-only so far.

There's good work adjacent to this — ReWeaver's DriftDetector, for one. Fixel does one narrower thing: exact Figma-node value fidelity, enforced in CI.

Source: https://github.com/AKollu72/fixel

Two things I'd most like feedback on: whether the scan patterns miss things you actually hit in AI-generated code, and whether the MCP integration fits how you use coding agents.
