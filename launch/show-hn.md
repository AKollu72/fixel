# Show HN: Fixel — a CI guard that catches design-token violations in AI-generated React

I've been building React components by pointing an LLM at a Figma node and
letting it generate. The output is usually close — but "close" is the
problem. Raw hex instead of a semantic token. A border radius that's 6
instead of `'6px'`, which in MUI sx renders as 24px. Nothing breaks at
runtime; it's just quietly wrong.

Prompting harder doesn't fix it. The model guesses when it should look things
up.

Fixel approaches this as a tooling problem:

**`fixel scan ./src`** — walks your `.tsx`/`.jsx` files and flags prohibited
patterns: raw hex literals, `rgba()` calls, bare numeric `borderRadius` in
MUI sx, hex inside Tailwind arbitrary-value brackets. No Figma call, no API
key. Exits 1 in CI.

**`fixel verify`** — reads the `.fixel.json` spec written at generation time
and checks whether the current source still matches. Offline drift detection.

**`fixel generate`** — the generation side: fetches the Figma node,
pre-resolves every color and spacing value to a semantic token before the LLM
sees anything, then audits the output before writing a single file.

New in 0.2.0: a Model Context Protocol server (`fixel-mcp`) so AI coding
agents can run verification themselves — `fixel_scan`, `fixel_verify`,
`fixel_annotate` as MCP tools.

Source: https://github.com/AKollu72/fixel  
npm: `npx fixel scan ./src`

Happy to answer questions about the audit patterns or the Figma extraction
approach.
