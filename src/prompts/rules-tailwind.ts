// Copyright (c) 2025 Amrutha Kollu. All rights reserved.
// Licensed under the Functional Source License, Version 1.1 (FSL-1.1-MIT) — see LICENSE for details.

import type { ResolvedConfig } from '../core/config';
import { tokenToKebab } from '../core/typography';

export { tokenToKebab };

// ─── Rules builder ────────────────────────────────────────────────────────────

/**
 * Tailwind CSS-specific generation rules.
 *
 * Injected into the system prompt only when config.framework === "tailwind".
 * These rules encode how Figma data maps to Tailwind class-based components:
 *   • className prop system (not sx or style)
 *   • Typography tokens as custom CSS utility classes
 *   • Design tokens as Tailwind arbitrary values using the JS import pattern
 *   • Native HTML elements instead of MUI Box / Typography
 *   • Tailwind spacing utilities with arbitrary-value fallback
 *   • State modifiers (hover:, disabled:, focus-visible:)
 *
 * Takes ResolvedConfig so rules can reference the project's actual import
 * paths and export names rather than hardcoded strings.
 *
 * Note: config.typography.tailwindClass is accessed via an intersection cast
 * until TypographyConfig gains the field in Phase 2 step 3.
 */
export function buildTailwindRules(config: ResolvedConfig): string {
  const { importPath: tokensPath, semanticExport } = config.tokens;
  const { adapterPackage }                         = config.storybook;

  const tailwindClassTmpl = config.typography.tailwindClass;
  // exampleClass uses kebab conversion so the AI sees realistic output class names
  const exampleClass      = tailwindClassTmpl.replace('{token}', tokenToKebab('bodySm'));
  const exampleLGBold     = tailwindClassTmpl.replace('{token}', tokenToKebab('LG_Bold'));
  const exampleMDMedium   = tailwindClassTmpl.replace('{token}', tokenToKebab('MD_Medium'));

  return `\
── TAILWIND-SPECIFIC RULES ──────────────────────────────────────────────────────
These rules apply because config.framework is "tailwind".  They replace or extend
the generic rules where they conflict.  Tailwind uses className, not sx or style.


COMPONENT STRUCTURE (Tailwind) — native HTML elements only

NEVER use MUI Box, MUI Typography, or any MUI component.
NEVER use styled-components, @emotion/styled, or css-in-js style objects.
NEVER use the sx prop — it does not exist outside MUI.

Use native HTML elements with Tailwind className for every layout and text node:

  ✅  <div className="flex items-center gap-2">
  ✅  <button type="button" className="… disabled:cursor-not-allowed" disabled={isDisabled}>
  ✅  <p className="${exampleClass}">…</p>
  ✅  <span className="sr-only">accessible label</span>
  ✅  <svg width="24" height="24" aria-hidden="true">…</svg>

  ❌  <Box sx={{ display: 'flex' }}>           — no MUI
  ❌  <Typography variant="bodySm">            — no MUI
  ❌  <div style={{ padding: 12 }}>            — no inline style for layout
  ❌  const Wrapper = styled.div\`…\`           — no styled-components

The only external-library elements you may use:
  <svg> / <img>   — for vector and icon assets
  React fragments — <> … </>

Map every Figma FRAME or GROUP to a native <div>.
Map every Figma TEXT node to the semantically correct element: <p>, <span>,
<label>, <h1>–<h6>, or <button> depending on context.


TYPOGRAPHY (Tailwind) — _resolvedTypographyToken as a utility class

Every TEXT node in <figma_data> has a _resolvedTypographyToken field pre-computed
before you received this message.  For Tailwind, this token becomes a CSS utility
class via the project's class template:

  Template:  ${tailwindClassTmpl}

  The {token} placeholder is expanded by converting the token name to kebab-case:
    "bodySm"    → "body-sm"    →  class "${exampleClass}"
    "LG_Bold"   → "lg-bold"    →  class "${exampleLGBold}"
    "MD_Medium" → "md-medium"  →  class "${exampleMDMedium}"

Apply the resulting class to the element that renders the text.

NEVER add individual fontSize, fontWeight, or lineHeight arbitrary values for
typography — the utility class definition already encodes all three.

NEVER select a typography class based on the component's size prop or the layer
name in Figma.  The _resolvedTypographyToken field is a pre-resolved fact; treat
it as ground truth.

Combine the typography class with layout classes in className; apply text colour via style:
  className="${exampleClass}"
  style={{ color: ${semanticExport}.text.primary }}


COLOUR TOKENS (Tailwind) — inline style with token import

Import the project's semantic token object at the top of every component file:
  import { ${semanticExport} } from '${tokensPath}';

Apply colours using inline style props — NOT Tailwind arbitrary value classes.
Template literal interpolation inside Tailwind className strings does NOT compile
in most build setups because Tailwind cannot statically analyse dynamic class names.

  Background:     style={{ backgroundColor: ${semanticExport}.button.bg }}
  Text colour:    style={{ color: ${semanticExport}.button.text }}
  Border colour:  style={{ borderColor: ${semanticExport}.button.border }}
  Outline:        style={{ outlineColor: ${semanticExport}.focus.ring }}

Combine multiple colour properties in a single style object:
  style={{
    backgroundColor: ${semanticExport}.button.bg,
    color:           ${semanticExport}.button.text,
    borderColor:     ${semanticExport}.button.border,
  }}

For box shadows use style as well:
  style={{ boxShadow: \`0 2px 6px \${${semanticExport}.effects.elevation}\` }}

Use Tailwind utility classes ONLY for:
  • Layout:       flex, grid, items-center, justify-between, overflow-hidden, …
  • Spacing:      gap-2, px-4, py-2, p-3, m-0, …
  • Border-radius: rounded, rounded-lg, rounded-full, rounded-[7px], …
  • Typography:   the project's custom typography utility classes (see TYPOGRAPHY section)
  • State modifiers on non-colour properties: disabled:cursor-not-allowed, focus-visible:outline-2, …

NEVER write a raw hex value, rgba() call, or named CSS colour:
  ❌  className="bg-[#1a73e8]"                        — raw hex in Tailwind class
  ❌  className="bg-blue-500"                         — hardcoded palette colour
  ❌  style={{ color: '#ffffff' }}                    — raw hex in style
  ❌  className={\`bg-[\${${semanticExport}.x}]\`}    — template literal in className
  ❌  className={\`text-[\${rgba(0,0,0,0.5)}]\`}      — raw rgba in className

Every colour must come from the ${semanticExport} import and be applied via style={{}}.


SPACING AND SIZING (Tailwind) — utilities for 4px-grid values, arbitrary for others

Tailwind's default scale is 4px per unit: gap-1=4px, gap-2=8px, gap-3=12px, gap-4=16px.

When the Figma spacing value is a multiple of 4, prefer the named utility:
  4px   →  gap-1   px-1   py-1   p-1
  8px   →  gap-2   px-2   py-2   p-2
  12px  →  gap-3   px-3
  16px  →  gap-4   px-4
  24px  →  gap-6   px-6
  32px  →  gap-8   p-8

When the value is NOT on the 4px grid, use an arbitrary value:
  6px   →  gap-[6px]   px-[6px]
  10px  →  px-[10px]
  14px  →  py-[14px]

For fixed element dimensions from Figma, use exact px arbitrary values:
  ✅  className="w-[120px] h-[32px]"
  ❌  className="w-full h-full"   — only when Figma explicitly shows a fluid layout

NEVER use a dimension lookup map with inline style — even via a variable or
constant.  Tailwind JIT requires the full class string to be statically present
in the source.  For variant-conditional sizing, write all class strings inline:

  ❌  const SIZE_MAP = { Large: { width: '16px' }, Small: { width: '6px' } }
     style={{ width: sizeConfig.width, height: sizeConfig.height }}

  ✅  className={size === 'Large' ? 'w-[16px] h-[16px] px-[4px] py-0'
                                  : 'w-[6px] h-[6px] p-[2px]'}

The same applies to padding, margin, gap, and any other spacing property —
never put a variable's CSS value into style={{}} when Tailwind classes exist.
Use style={{}} for colours (backgroundColor, color, borderColor, outlineColor,
boxShadow) and never for layout, spacing, or sizing — those must use Tailwind classes.

The "Resolved spacing" block at the top of this prompt contains exact px values
extracted from Figma.  Use those values — do not guess from layer names or
visual estimation.

For flex containers, always include the Figma gap value explicitly:
  className="flex items-center gap-[8px]"  — even when gap matches a named utility


BORDER-RADIUS (Tailwind) — rounded utilities or arbitrary values

Map Figma cornerRadius values to Tailwind's rounded scale where they match exactly:
  2px    →  rounded-sm
  4px    →  rounded
  6px    →  rounded-md
  8px    →  rounded-lg
  12px   →  rounded-xl
  16px   →  rounded-2xl
  24px   →  rounded-3xl
  9999px →  rounded-full

For any other cornerRadius value, use an arbitrary value:
  ✅  rounded-[7px]    rounded-[10px]    rounded-[3px]

Never omit border-radius when the Figma node specifies one — even rounded-none
(0px) must appear to make intent explicit.

When different corners have different radii, use the longhand classes:
  rounded-tl-[8px] rounded-tr-[8px] rounded-bl-none rounded-br-none


FOCUS AND HOVER STATES (Tailwind) — style + className combination

For interactive colour states (hover, active, focus), use React state or CSS
variables — Tailwind's modifier prefixes cannot reference dynamic token values.

Pattern using onMouseEnter/onMouseLeave or a CSS custom property approach:

  const [hovered, setHovered] = React.useState(false);
  <button
    style={{
      backgroundColor: hovered ? ${semanticExport}.button.hoverBg : ${semanticExport}.button.bg,
      color:           ${semanticExport}.button.text,
    }}
    onMouseEnter={() => setHovered(true)}
    onMouseLeave={() => setHovered(false)}
    className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
  >

For focus rings, use className for the structural outline classes and style for
the outline colour:
  className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
  style={{ outlineColor: ${semanticExport}.focus.ring }}

Always use focus-visible: (not focus:) — focus-visible only applies when the user
navigates via keyboard, preserving mouse-click behaviour.


DISABLED STATES (Tailwind) — disabled prop + conditional style

Apply disabled colours via conditional style, not Tailwind disabled: modifier
(which cannot reference dynamic token values):

  <button
    disabled={isDisabled}
    style={{
      backgroundColor: isDisabled ? ${semanticExport}.button.disabledBg  : ${semanticExport}.button.bg,
      color:           isDisabled ? ${semanticExport}.button.disabledText : ${semanticExport}.button.text,
    }}
    className="disabled:cursor-not-allowed"
  >

For <div> or <span> that act as buttons (no native disabled attribute), add:
  pointer-events-none  opacity-50

Follow the generic DISABLED STATES rule: when a variant has a custom disabled
text colour token, every icon and indicator in that variant must use the same
token — not the generic disabled token.


ICON AND SVG SIZES (Tailwind) — exact Figma px values

Use the exact pixel dimensions from the "Icon/vector sizes from Figma" block.
Express them as Tailwind arbitrary values:
  <svg className="w-[24px] h-[24px]" aria-hidden="true">…</svg>

NEVER default to w-5 h-5 (20px) or w-6 h-6 (24px) as guesses.
If a size is not in the icon/vector block, use the parent frame dimensions.


IMPORT PATTERN (Tailwind)

Generated component files must use these imports:

  import type { FC } from 'react';
  import { ${semanticExport} } from '${tokensPath}';

No MUI imports.  No @emotion imports.  No styled-components.
SVG icons may be imported as React components if the project already uses that
pattern — check existing components in the output directory for the convention.


STORY IMPORT PATTERN (Tailwind)

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
