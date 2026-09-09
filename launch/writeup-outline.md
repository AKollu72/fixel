# Article outline: "Why your AI-generated components don't match your design system"

**Target:** dev.to / Hashnode / personal blog  
**Angle:** the gap between "it compiles" and "it's correct"; verification as the missing layer

---

## 1. The close-but-not-exact problem

- LLMs are trained on generic React patterns, not your token file
- A border radius that's 6 instead of `'6px'` in MUI sx renders as 24px — silent, visual-only
- Raw hex is the most common: `'#1a73e8'` instead of `semantic.action.primary`
- "Prompting harder" doesn't fix a lookup problem

## 2. Why this is an architecture problem

- The model doesn't have your token file in context at generation time (or it does, but isn't constrained to use it)
- Even with the file in context, the model can still guess — there's no enforcement layer
- The fix is to extract values deterministically before the model sees them, then verify after

## 3. What the verification layer looks like

- `fixel scan ./src` — walk components, check patterns, exit 1
- Patterns: raw-hex, raw-rgba, bare-border-radius (MUI), tailwind arbitrary-value hex/rgba
- How `auditCode()` works: comment stripping, per-pattern regex checks gated by framework
- One engine used twice: post-generation gate + CI scan

## 4. The full pipeline (for context)

- `fixel import` — deterministic extraction from Figma published styles
- `fixel generate` — constrained generation with pre-resolved values
- `fixel verify` — offline drift detection against the stored spec
- `fixel annotate` — close the loop back to the designer

## 5. MCP: letting the AI agent run its own verification

- The new `fixel-mcp` server exposes `fixel_scan`, `fixel_verify`, `fixel_annotate`
- Pattern: generate → immediately scan → fix → commit
- The agent doesn't need to know the patterns; it just calls the tool

## 6. Takeaway

- Verification is a first-class step, not an afterthought
- The check that matters is: does this component match the design system, not just "does it compile"
- Open source: github.com/AKollu72/fixel

---

**Approximate length:** 1,200 words  
**Code samples to include:**
- CI snippet (scan + verify)
- One `auditCode` violation output example
- MCP config block
