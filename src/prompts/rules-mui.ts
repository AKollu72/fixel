// Copyright (c) 2025 Amrutha Kollu. All rights reserved.
// Licensed under the Functional Source License, Version 1.1 (FSL-1.1-MIT) — see LICENSE for details.

import type { ResolvedConfig } from '../core/config';

/**
 * MUI-specific generation rules.
 *
 * Injected into the system prompt only when config.framework === "mui".
 * These rules encode behaviours specific to Material UI v5+ with Emotion:
 *   • sx prop system and its numeric multiplication quirks
 *   • MUI CssBaseline side-effects
 *   • Typography variant prop pattern
 *   • Box-as-primitive composition pattern
 *
 * Takes ResolvedConfig so rules can reference the project's actual import
 * paths and export names rather than hardcoded strings.
 */
export function buildMuiRules(config: ResolvedConfig): string {
  const { importPath: tokensPath, semanticExport } = config.tokens;
  const { importPath: typographyPath }              = config.typography;
  const { adapterPackage }                          = config.storybook;

  return `\
── MUI-SPECIFIC RULES ───────────────────────────────────────────────────────────
These rules apply because config.framework is "mui".  They encode MUI v5 sx-prop
behaviour.  Violating them produces silent visual bugs that only appear at specific
display scales or in specific browser engines.


TYPOGRAPHY VARIANT (MUI) — _resolvedTypographyToken is the variant prop

Write:
  <Typography variant={_resolvedTypographyToken}>…</Typography>
  // or, when the token is a constant:
  <Typography variant="MD_Medium">…</Typography>

NEVER substitute a different variant based on the component's size prop, the layer
name, or any string-similarity reasoning.

Import:
  import Typography from '@mui/material/Typography';


LINE HEIGHT (MUI) — never add lineHeight to a Typography sx prop

The MUI Typography variant bakes in lineHeight via its theme definition.
If you add lineHeight to sx, you override the correct value and collapse it.

  ❌  <Typography variant="MD_Medium" sx={{ lineHeight: 1 }}>
  ✅  <Typography variant="MD_Medium">

If you find yourself wanting to adjust lineHeight, you are on the wrong variant.


BORDER RADIUS (MUI) — always a CSS string literal in sx

MUI's sx system multiplies bare numeric borderRadius by theme.shape.borderRadius
(default = 4).  Writing borderRadius: 6 renders as 24px, not 6px.

  ❌  borderRadius: 6          →  renders as 24px
  ✅  borderRadius: '6px'      →  renders as 6px

This rule applies to all five CSS border-radius longhand properties:
  borderRadius, borderTopLeftRadius, borderTopRightRadius,
  borderBottomLeftRadius, borderBottomRightRadius

Every Figma cornerRadius value (shown as "r=Npx" in the FIGMA STRUCTURE BLUEPRINT)
must appear in code as the string literal 'Npx'.  The audit will fail if the string
is absent.  If an element has no visible background, include borderRadius: '0px'
if the Figma node has cornerRadius = 0, or the correct value otherwise.

Escape hatch: to intentionally use the MUI multiplier, add on the same line:
  borderRadius: 1  // fixel-ignore


BORDER VALUE (MUI) — always a string literal

MUI sx treats a numeric border value as spacing units (1 → 8px, not 1px).

  ❌  border: 1                →  renders as 8px border
  ✅  border: '1px solid ...'  →  renders as 1px border

Always write: border: '1px solid <token>'


APPEARANCE (MUI) — suppress CssBaseline native button styling

MUI CssBaseline applies -webkit-appearance: button to every <button> element.
This triggers OS-native border rendering at non-integer DPI scales (e.g. a faint
0.5px border at 125% Windows scaling) even when border: 'none' is set.

Add to EVERY Box with component="button":
  appearance:       'none',
  WebkitAppearance: 'none',

Required on: the main wrapper for Default and Icon-Only variants, AND on each
segment wrapper in Split-style buttons.


VERTICAL PADDING (MUI) — set py alongside height on button elements

Figma button specs always include both a height AND explicit vertical padding.
MUI computes height from content + padding; setting only height and relying on
alignItems: center leaves computedStyle padding: 0 in DevTools — a spec mismatch.

Always set BOTH height AND py:
  height: 32, px: '12px', py: '6px'   ← MD-size example
  height: 24, px: '8px',  py: '4px'   ← SM-size example

The exact values come from the "Resolved spacing" block at the top of the prompt.


OVERFLOW HIDDEN (MUI) — only where strictly required

Combining overflow: 'hidden' with borderRadius and border on a <div> causes
Chrome to render the border at a fractional pixel width at non-integer DPR scales
(visible as a 0.8px border at 125% Windows scaling).

Only add overflow: 'hidden' when it is strictly required to clip children that
genuinely overflow (e.g. the outer wrapper of a Split button clips segment corners).

Do NOT add it to: badge containers, alert banners, cards, tooltips, or any component
where children cannot overflow the border.


FOCUS RING (MUI) — dual box-shadow + outline

A box-shadow alone is invisible on light-coloured button surfaces (Secondary,
Tertiary) because the white inner ring blends with the background.  The browser
paints outline on top of all parent layers and cannot be masked.

Always use both:
  '&:focus-visible': {
    boxShadow:     <your-focus-ring-token>,
    outline:       \`2px solid \${<your-focus-ring-colour-token>}\`,
    outlineOffset: '2px',
  }

The white inner shadow in your focus ring token must be listed FIRST in the
box-shadow value (see the generic FOCUS RING rule above).


FORBIDDEN MUI ABSTRACTIONS — implement Figma structure as Box + sx

The following MUI components substitute their own DOM structure and CSS for the
Figma layout.  Never use them to implement a hand-crafted Figma design:

  // TODO: make this list configurable via config.framework.forbiddenComponents
  ❌  <Slider />          when Figma shows a custom track + handle + tooltip
  ❌  <Select />          when Figma shows a custom border-box with placeholder text
  ❌  <TextField />       when Figma shows a custom input field
  ❌  <Checkbox />        when Figma shows a custom square indicator
  ❌  <Radio />           when Figma shows a custom circle indicator
  ❌  <Accordion />       when Figma shows a custom expand/collapse layout
  ❌  <Tooltip />         when Figma shows a positioned dark-background div with caret
  ❌  <Grid2 />           when Figma shows a fixed-column layout frame
  ❌  <Stack />           when Figma shows a flex container with explicit gap
  ❌  <Divider />         when Figma shows a 1px line with a specific colour token
  ❌  Any MUI form-control when Figma shows hand-crafted layout

Correct approach — translate each Figma frame into MUI Box with sx:
  ✅  <Box sx={{ height: 6, borderRadius: '8px', position: 'relative' }}>
  ✅  <Box sx={{ width: '${12}px', height: '${12}px', borderRadius: '50%', position: 'absolute' }}>


PERMITTED COMPONENTS (MUI) — Box, Typography, SVG only

The only non-native elements you may use:
  MUI Box        — for ALL layout frames / containers
  MUI Typography — for ALL text nodes
  <svg> / <img>  — for vector and icon assets

No other MUI component may appear in generated component output.


COMPONENT IMPORT PATTERN (MUI)

Generated component files must use these import paths:

  import type { FC } from 'react';
  import Box from '@mui/material/Box';
  import Typography from '@mui/material/Typography';
  import { ${semanticExport} } from '${tokensPath}';

Typography is imported from '@mui/material/Typography' when text nodes are present.
${typographyPath
  ? `\nTypography variant definitions live at: '${typographyPath}'`
  : ''}

STORY IMPORT PATTERN (MUI)

Story files must import from the project's Storybook adapter:

  import type { Meta, StoryObj } from '${adapterPackage}';

  const meta = {
    title: 'Components/MyComponent',
    component: MyComponent,
  } satisfies Meta<typeof MyComponent>;
  export default meta;

  type Story = StoryObj<typeof meta>;

Do NOT include tags: ['autodocs'] — it is set globally and inherited by every story.`;
}
