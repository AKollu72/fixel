// Copyright (c) 2025 Amrutha Kollu. All rights reserved.
// Licensed under the Functional Source License, Version 1.1 (FSL-1.1-MIT) — see LICENSE for details.

/**
 * Framework-agnostic generation rules.
 *
 * These rules apply regardless of config.framework.  They encode invariants
 * about how Figma data must be translated to code — things that are true for
 * React + MUI, React + Tailwind, Vue, Svelte, or any other target.
 *
 * Every rule here should be phrased in terms that make sense without knowing
 * which styling system or component library the project uses.
 */
export function buildGenericRules(): string {
  return `\
TYPOGRAPHY — resolve from Figma data, do not infer

Every TEXT node in <figma_data> has a _resolvedTypographyToken field pre-computed
before you received this message.  Read that field directly and use it as the
typography variant in your output.

If _resolvedTypographyToken is absent (non-TEXT node), use the TYPOGRAPHY SCALE table
above to look up the correct token by exact fontSize + fontWeight.

NEVER match typography by:
  • The component's size prop (MD button ≠ MD_Medium — coincidence of names)
  • The layer name in Figma
  • Similarity to another token name
  • Any inference beyond the table lookup

The resolved token is a fact.  Treat it as one.


TYPOGRAPHY LINE-HEIGHT — do not add it in generated style overrides

The correct lineHeight is baked into each typography variant definition.
Do NOT add lineHeight to any per-element style overrides.
Do NOT write lineHeight: 1 — this collapses the line-height to the raw font-size
and breaks vertical rhythm across the entire component.
If you need to adjust line-height, you are using the wrong typography variant.
Fix the variant instead.


COLOUR TOKENS — all colours via semantic tokens, zero exceptions

Never write a raw hex value, rgba() call, rgb() call, or any colour literal
anywhere in generated output — including:
  • Style objects and sx props
  • JSX attribute values
  • SVG element attributes (stroke, fill, color, stop-color)
  • Inline style strings

Every colour must reference a token from your project's token file.  The complete
list of available tokens is in the TOKEN DEFINITIONS section above.

SHADOW EFFECTS → TOKEN MAPPING
Figma effect arrays contain raw rgba() values.  Never copy them.
Map DROP_SHADOW effects to your project's semantic shadow tokens by radius:
  radius ≤ 2px   →  shadowSm (or your project's small-shadow token)
  radius 4–6px   →  shadowMd
  radius 8–16px  →  shadowLg
  radius 17–30px →  shadowXl
  surface/card   →  shadowCard
If the Figma node has no effects, omit box-shadow entirely — do not add a default.


DISABLED STATES — match icon/indicator token to text token by variant

When a component variant has a custom disabled text colour (not the generic
disabled-text token), its icon, chevron, and indicator elements must use the
same token — not the generic disabled token.  A grey icon next to a coloured
disabled label is a designer-visible mismatch.

General rule: if a variant has a custom disabled text token, every visual
indicator in that variant must match it.


FOCUS RING — inner gap shadow must be listed first

When applying a focus ring effect, the white/transparent inner shadow that
creates the visible gap between the element and the ring must be the first
item in the shadow list.  CSS renders the first-listed shadow on top.
If the dark outer ring is listed first, it covers the inner gap entirely.

Always use the dual-mechanism focus approach — shadow alone is invisible on
light-coloured backgrounds.  An outline painted by the browser appears on top
of all parent layers and cannot be masked.


EXPORT ALL CONSTANT TABLES

Export every lookup table (TYPE_TOKENS, TEXT_VARIANT, SIZE_MAP, etc.) from
the component file.  Spec-lock tests import these tables directly to assert
token choices at the data level — without DOM rendering.

Example:
  export const TEXT_VARIANT = { MD: 'MD_Medium', SM: 'SM_Regular' } as const;
  export const TYPE_TOKENS  = { Primary: { bg: tokens.button.primary.bg } } as const;


EXPORT BOTH NAMED AND DEFAULT

Every component file must export the component both ways:
  export const MyComponent: FC<MyComponentProps> = ...
  export default MyComponent;

Story files and test files use both import styles.  Missing either causes
import failures in some build toolchains.


NO @manual / DO NOT REVERT COMMENTS

Do not write @manual, "DO NOT REVERT", "KEEP THIS", or similar directives in
generated code.  They are untrackable and ignored by the pipeline.

If a value required a deliberate choice that deviates from the raw Figma data,
explain it with a plain comment:
  // Figma specifies 12px; resolved to MD_Medium (closest defined token)
Intentional deviations are tracked in fixel.overrides.json, not in source.


ICON AND SVG SIZES — use Figma's exact dimensions

Every icon/vector/SVG in this component has its exact rendered size listed in
the "Icon/vector sizes from Figma" block earlier in this message.  Use those
pixel values as the CSS width and height of the SVG element.

Never default to 20, 24, or any other guess.  If a size is not listed, ask
rather than guessing.


STORY COUNT — match Figma components, not prop combinations

Generate one story per meaningful Figma component variant shown in the design.
Do NOT generate stories for every permutation of boolean props.

If Figma shows 2 variants (Type=Single, Type=Multi), generate exactly 2 stories.
Use the FIGMA VARIANT STORIES checklist from the generation prompt — it is the
authoritative list of required stories.  Missing or renamed stories are
validation errors.


FIGMA NODE TREE IS THE SPECIFICATION

Every Figma FRAME or GROUP maps to one container element.
Every Figma TEXT node maps to one text element.
Every Figma VECTOR / BOOLEAN_OPERATION maps to one SVG or image element.

NEVER collapse multiple Figma layers into one element.
NEVER replace a hand-crafted Figma layout with an abstracted library component.

The layer names in <figma_data> (e.g. "Track", "Handle", "Tooltip container")
become code comments so the generated output is traceable back to the Figma file.


JSDoc AT TOP OF EVERY COMPONENT FILE

Begin every generated component file with a JSDoc comment listing:
  • Available variants (e.g. @param type - 'primary' | 'secondary' | 'danger')
  • Figma node reference
  • Brief usage example

This is required for IDE hover documentation.`;
}
