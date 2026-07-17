// Copyright (c) 2025 Amrutha Kollu. All rights reserved.
// Licensed under the Functional Source License, Version 1.1 (FSL-1.1-MIT) — see LICENSE for details.

import type { ResolvedConfig } from '../core/config';
import { buildTypographyTable } from '../core/typography';
import { buildGenericRules }    from './rules-generic';
import { buildMuiRules }        from './rules-mui';
import { buildTailwindRules }   from './rules-tailwind';

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Builds the complete system prompt for `fixel generate`.
 *
 * This is a pure function — no file I/O, no API calls, no side effects.
 * The caller is responsible for reading any external files (token source,
 * Figma data) and passing them in as arguments.
 *
 * The assembled prompt contains five sections in this order:
 *   1. Role description
 *   2. Token definitions (from the project's token file)
 *   3. Typography scale lookup table (from config.typography.scale)
 *   4. Code pattern templates (component + stories, framework-aware)
 *   5. Non-negotiable rules (generic + framework-specific)
 *
 * @param config       Fully resolved fixel config.
 * @param tokenSource  Optional raw source of the project's token file.
 *                     When provided, the semantic and constants exports are
 *                     extracted and injected so the AI sees all available tokens.
 *                     When absent, the prompt notes that token definitions were
 *                     not loaded and instructs the AI to use only tokens given
 *                     in the per-request user message.
 */
export function buildSystemPrompt(
  config:       ResolvedConfig,
  tokenSource?: string,
): string {
  const tokenSection       = buildTokenSection(tokenSource, config);
  const typographySection  = buildTypographyTable(config.typography.scale);
  const patternSection     = buildPatternSection(config);
  const genericRules   = buildGenericRules();
  const frameworkRules = getFrameworkRules(config);

  const rulesDivider =
    '═══════════════════════════════════════════════════════════════════════════════\n' +
    'NON-NEGOTIABLE RULES — violating any of these will produce incorrect output\n' +
    '═══════════════════════════════════════════════════════════════════════════════';

  const sections = [
    buildRoleSection(config),
    tokenSection,
    typographySection,
    patternSection,
    rulesDivider,
    genericRules,
    frameworkRules,
  ].filter((s) => s.trim() !== '');

  return sections.join('\n\n');
}

// ─── Framework dispatch ───────────────────────────────────────────────────────

/**
 * Returns the framework-specific rule block appended after the generic rules.
 * Returns an empty string for frameworks without dedicated rules (css-modules, other).
 */
function getFrameworkRules(config: ResolvedConfig): string {
  switch (config.framework) {
    case 'mui':      return buildMuiRules(config);
    case 'tailwind': return buildTailwindRules(config);
    default:         return '';
  }
}

/**
 * Returns the framework-specific component pattern example shown to the AI.
 * The pattern is structural scaffolding — the AI replaces placeholder values
 * with real tokens and Figma data from the user message.
 */
function buildComponentPattern(config: ResolvedConfig): string {
  switch (config.framework) {
    case 'mui':      return buildMuiComponentPattern(config);
    case 'tailwind': return buildTailwindComponentPattern(config);
    default:         return buildGenericComponentPattern(
                              config.tokens.importPath,
                              config.tokens.semanticExport,
                            );
  }
}

// ─── Section builders ─────────────────────────────────────────────────────────

/**
 * Opening role description.  Identifies the AI's task and the design contract
 * it must honour.  No company names, no project names.
 */
function buildRoleSection(config: ResolvedConfig): string {
  return `\
You are an expert React and TypeScript developer implementing a design system from
Figma specifications.

Your task is to generate production-ready component files that are pixel-accurate
to the Figma design and conform to the code conventions described in this prompt.

Framework: ${config.framework}
Storybook:  ${config.storybook.adapterPackage}
Token file: ${config.tokens.file}

Every value you write must come from one of three sources:
  1. A semantic token from the project's token file (listed below)
  2. An exact pixel value extracted from Figma and provided in the user message
  3. A structural value (flex, block, relative) that has no Figma analogue

Nothing else.  No hex values, no magic numbers, no rgba() calls.`;
}

/**
 * Injects the project's semantic token definitions.
 *
 * When tokenSource is provided, the semantic and constants exports are
 * extracted using a brace-depth scanner and embedded verbatim so the AI
 * has a complete, accurate view of every available token.
 *
 * When tokenSource is absent (e.g. in tests or dry-run mode), a placeholder
 * note is emitted so the AI degrades gracefully rather than hallucinating tokens.
 */
function buildTokenSection(
  tokenSource: string | undefined,
  config:      ResolvedConfig,
): string {
  if (!tokenSource?.trim()) {
    return (
      `TOKEN DEFINITIONS\n` +
      `(Token file not loaded — use only tokens explicitly provided in the user message.)`
    );
  }

  const { semanticExport, constantsExport, importPath, file } = config.tokens;

  const semanticBody  = extractExportBody(tokenSource, semanticExport);
  const constantsBody = extractExportBody(tokenSource, constantsExport);

  const lines: string[] = [
    `TOKEN DEFINITIONS  (source: ${file})`,
    `Import path: '${importPath}'`,
    '',
    `— Use ONLY these tokens.  Never use raw hex, rgba(), or private primitives.`,
    `— Match tokens to Figma fills by hex value using the resolved fill data in the`,
    `  user message.  Do not guess token names from Figma layer names.`,
  ];

  if (constantsBody) {
    lines.push('', constantsBody);
  }
  if (semanticBody) {
    lines.push('', semanticBody);
  }
  if (!semanticBody && !constantsBody) {
    lines.push(
      '',
      `(Could not extract named exports — read ${file} directly if needed.)`,
    );
  }

  return lines.join('\n');
}

/**
 * Builds the code pattern templates shown to the AI.
 *
 * These patterns establish the expected file structure for components and
 * stories.  All import paths and export names come from config so the
 * generated code is immediately valid in the user's project.
 *
 * A generic fallback pattern is emitted for non-MUI frameworks — enough to
 * show correct file structure without prescribing a specific styling API.
 */
function buildPatternSection(config: ResolvedConfig): string {
  const componentPattern = buildComponentPattern(config);
  const storyPattern     = buildStoryPattern(config);
  return [componentPattern, storyPattern].join('\n\n');
}

function buildMuiComponentPattern(config: ResolvedConfig): string {
  const { importPath: tokensPath, semanticExport } = config.tokens;

  return `\
COMPONENT PATTERN  (MUI + TypeScript — follow this structure exactly)

'use client';
import type { FC } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { ${semanticExport} } from '${tokensPath}';

export interface ExampleProps {
  variant?:  'primary' | 'secondary';
  disabled?: boolean;
}

export const Example: FC<ExampleProps> = ({ variant = 'primary', disabled = false }) => (
  <Box
    component="button"
    disabled={disabled}
    sx={{
      appearance:       'none',
      WebkitAppearance: 'none',
      backgroundColor: variant === 'primary'
        ? ${semanticExport}.component.primary.bg.default
        : ${semanticExport}.component.secondary.bg.default,
      '&:hover':         { backgroundColor: ${semanticExport}.component.primary.bg.hover },
      '&:focus-visible': {
        boxShadow:     ${semanticExport}.effects.focusRing,
        outline:       \`2px solid \${${semanticExport}.effects.focusRingColour}\`,
        outlineOffset: '2px',
      },
    }}
  >
    <Typography variant="MD_Regular">Label</Typography>
  </Box>
);
export default Example;`;
}

function buildTailwindComponentPattern(config: ResolvedConfig): string {
  const { importPath: tokensPath, semanticExport } = config.tokens;
  // Use a pre-kebab-cased example token so the pattern shows realistic class names.
  const exampleTypo = config.typography.tailwindClass.replace('{token}', 'body-md');

  return `\
COMPONENT PATTERN  (Tailwind CSS + TypeScript — follow this structure exactly)

import type { FC } from 'react';
import { ${semanticExport} } from '${tokensPath}';

export interface ExampleProps {
  disabled?: boolean;
}

export const Example: FC<ExampleProps> = ({ disabled = false }) => (
  <button
    type="button"
    disabled={disabled}
    className={\`
      flex items-center gap-[8px] px-[12px] py-[6px]
      rounded-lg
      bg-[\${${semanticExport}.button.bg}]
      hover:bg-[\${${semanticExport}.button.hoverBg}]
      focus-visible:outline focus-visible:outline-2
      focus-visible:outline-offset-2
      focus-visible:outline-[\${${semanticExport}.focus.ring}]
      disabled:bg-[\${${semanticExport}.button.disabledBg}]
      disabled:cursor-not-allowed
    \`}
  >
    <p className={\`${exampleTypo} text-[\${${semanticExport}.button.text}]\`}>
      Label
    </p>
  </button>
);
export default Example;`;
}

function buildGenericComponentPattern(
  tokensPath:    string,
  semanticExport: string,
): string {
  return `\
COMPONENT PATTERN  (React + TypeScript)

import type { FC } from 'react';
import { ${semanticExport} } from '${tokensPath}';

export interface ExampleProps {
  variant?:  'primary' | 'secondary';
  disabled?: boolean;
}

export const Example: FC<ExampleProps> = ({ variant = 'primary', disabled = false }) => {
  // Apply your project's styling system (CSS Modules, Tailwind, styled-components, etc.)
  // using tokens from ${semanticExport}.*
  return <div />;
};
export default Example;`;
}

function buildStoryPattern(config: ResolvedConfig): string {
  const { adapterPackage } = config.storybook;

  return `\
STORY PATTERN  (CSF3 format)

import type { Meta, StoryObj } from '${adapterPackage}';
import { Example } from './Example';

const meta = {
  title:     'Components/Example',
  component: Example,
} satisfies Meta<typeof Example>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Default:  Story = {};
export const Disabled: Story = { args: { disabled: true } };

Rules:
  • Do NOT add tags: ['autodocs'] — set globally, inherited by all stories
  • Args must use only props from the component's Props interface
  • One story per Figma variant (see FIGMA VARIANT STORIES in the user message)
  • Story export names must match the checklist exactly — wrong names are errors`;
}

// ─── Private: token body extractor ───────────────────────────────────────────

/**
 * Extracts the body of a named `export const <name> = { ... }` declaration
 * from TypeScript source using a brace-depth counter.
 *
 * This is a best-effort extraction for system prompt injection — the goal is
 * to give the AI a complete view of available tokens, not to parse the file
 * for programmatic use.  For programmatic token indexing, use
 * buildTokenIndex() from tokens.ts, which uses the full string-aware scanner.
 *
 * Returns an empty string when the named export is not found.
 */
function extractExportBody(source: string, exportName: string): string {
  const headRe = new RegExp(
    `export\\s+const\\s+${exportName}\\s*(?::[^=]+)?=\\s*\\{`,
    'g',
  );

  const match = headRe.exec(source);
  if (!match) return '';

  const openIdx = match.index + match[0].length - 1;   // position of opening `{`
  let depth = 1;
  let i     = openIdx + 1;

  while (i < source.length && depth > 0) {
    const ch = source[i];
    // Minimal handling: skip string literals to avoid being misled by braces inside them.
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipString(source, i, ch);
    } else {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
  }

  // Re-attach the `export const <name> = ` prefix so the AI sees the full declaration.
  return source.slice(match.index, i) + ' as const;';
}

/**
 * Advances past a quoted string (single, double, or backtick), handling
 * backslash escapes.  For template literals, does NOT recurse into ${}
 * expressions — shallow skip is sufficient for the token-injection use case.
 */
function skipString(source: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if      (ch === '\\') { i += 2; }
    else if (ch === quote) { return i + 1; }
    else                   { i++; }
  }
  return source.length;
}
