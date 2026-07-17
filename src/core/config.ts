// Copyright (c) 2025 Amrutha Kollu. All rights reserved.
// Licensed under the Functional Source License, Version 1.1 (FSL-1.1-MIT) — see LICENSE for details.

import * as fs   from 'node:fs';
import * as path from 'node:path';

// ─── Error ────────────────────────────────────────────────────────────────────

export class FixelConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FixelConfigError';
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * One entry in the typography scale.
 * Maps a (fontSize, fontWeight) combination to a design-token name and its
 * baked-in line-height, so the deterministic resolver never has to guess.
 */
export interface TypographyScaleEntry {
  /** Token name as it appears in generated component code.  e.g. "MD_Medium" */
  token:      string;
  /** CSS line-height value baked into this variant.         e.g. "16px"     */
  lineHeight: string;
}

/**
 * Full typography scale.
 *
 * Keys are "fontSize/fontWeight" pairs.  Use "any" for fontWeight to match
 * every weight at that font size (useful for heading tiers that are always bold).
 *
 * The resolver tries an exact key first, then falls back to the "any" wildcard.
 *
 * @example
 * {
 *   "34/any": { "token": "H1",        "lineHeight": "40px" },
 *   "14/700": { "token": "LG_Bold",   "lineHeight": "20px" },
 *   "14/500": { "token": "LG_Medium", "lineHeight": "20px" },
 *   "12/500": { "token": "MD_Medium", "lineHeight": "16px" }
 * }
 */
export type TypographyScale = Record<string, TypographyScaleEntry>;

// ── figma ─────────────────────────────────────────────────────────────────────

export interface FigmaConfig {
  /**
   * Figma personal access token.
   *
   * Always supply an env-var reference — never a literal token value:
   *   "accessToken": "${FIGMA_ACCESS_TOKEN}"
   *
   * The Figma file key is NOT stored here.  Pass it at runtime via
   * the --node flag: `fixel scan --node FILEKEY:NODEID`
   */
  accessToken: string;
}

// ── storybook ─────────────────────────────────────────────────────────────────

export interface StorybookConfig {
  /**
   * Storybook integration framework.  Fixel derives the npm package name
   * automatically by prepending "@storybook/":
   *   "nextjs-vite"    →  @storybook/nextjs-vite
   *   "react-vite"     →  @storybook/react-vite
   *   "react-webpack5" →  @storybook/react-webpack5
   *
   * @default "nextjs-vite"
   */
  framework: string;
}

// ── tokens ────────────────────────────────────────────────────────────────────

export type TokenFileFormat = 'typescript-object';

export interface TokensConfig {
  /** Path to the design-token file, relative to the project root. */
  file: string;
  /**
   * Format of the token file.
   * "typescript-object" — a TypeScript file that exports plain objects:
   *   export const semantic = { ... } as const;
   */
  format: TokenFileFormat;
  /**
   * Import path used in generated component and test code.
   * @example "@/lib/ui/theme/colors"
   */
  importPath: string;
  /**
   * Name of the semantic tokens export in the token file.
   * @default "semantic"
   */
  semanticExport?: string;
  /**
   * Name of the constants export (white, black, transparent…).
   * @default "constants"
   */
  constantsExport?: string;
  /**
   * Pattern for token name suggestions produced by `fixel scan`.
   * Placeholders: {group}, {role}, {state}
   * @default "semantic.{group}.{role}"
   */
  namingConvention?: string;
}

// ── typography ────────────────────────────────────────────────────────────────

export interface TypographyConfig {
  /**
   * Path to the typography definition file, relative to project root.
   * Optional — used by `fixel verify` to cross-check line-height values.
   */
  file?: string;
  /**
   * Import path used in generated test code.
   * @example "@/lib/ui/theme/typography"
   */
  importPath: string;
  /**
   * Full typography scale definition.
   * Keys: "fontSize/fontWeight" e.g. "12/500", "34/any"
   */
  scale: TypographyScale;
  /**
   * Class name template for typography tokens in Tailwind projects.
   * The `{token}` placeholder is replaced with the token name converted to
   * kebab-case by tokenToKebab() in rules-tailwind.ts.
   * Only used when config.framework === "tailwind".
   *
   * @default "typography-{token}"
   * @example
   *   "typography-{token}" + "bodySm" → "typography-body-sm"
   *   "font-{token}"       + "LG_Bold" → "font-lg-bold"
   */
  tailwindClass?: string;
}

// ── output ────────────────────────────────────────────────────────────────────

export interface OutputConfig {
  /**
   * Directory where generated components are written, relative to project root.
   * @example "./src/components"
   */
  componentDir: string;
  /**
   * Subdirectory inside each component folder for generated test files.
   * @default "__tests__"
   */
  testSubdir?: string;
}

// ── testing ───────────────────────────────────────────────────────────────────

export interface TestingConfig {
  /**
   * Test runner.
   * @default "jest"
   */
  framework?: 'jest' | 'vitest';
  /**
   * Component render library for generated test files.
   * @default "@testing-library/react"
   */
  renderLibrary?: string;
}

// ── ai ────────────────────────────────────────────────────────────────────────

export type AiProvider = 'anthropic' | 'openai';

export interface AiConfig {
  /**
   * AI provider.  The API key is read from the corresponding env var —
   * it is NEVER stored in config:
   *   "anthropic" → ANTHROPIC_API_KEY
   *   "openai"    → OPENAI_API_KEY
   */
  provider: AiProvider;
  /**
   * Model identifier passed to the provider's API.
   * @example "claude-sonnet-4-6", "gpt-4o"
   */
  model: string;
}

// ── prohibited patterns ───────────────────────────────────────────────────────

/**
 * Named pattern identifiers for the post-generation anti-pattern scanner.
 *
 * Built-in patterns:
 *   "raw-hex"            — rejects raw hex colour literals (#rrggbb)
 *   "raw-rgba"           — rejects raw rgba() / rgb() expressions
 *   "bare-border-radius" — rejects bare numeric borderRadius in MUI sx
 *   "missing-imports"    — rejects generated files that reference tokens
 *                          without importing them
 */
export type ProhibitedPattern =
  | 'raw-hex'
  | 'raw-rgba'
  | 'bare-border-radius'
  | 'missing-imports'
  | 'lineHeight-override'
  | 'tailwind-raw-hex-arbitrary'
  | 'tailwind-raw-rgb-arbitrary'
  | string;   // allow user-defined pattern names for future extensibility

// ── top-level config (raw from JSON) ─────────────────────────────────────────

/**
 * The shape of fixel.config.json before defaults are applied.
 *
 * All required fields must be present.  Optional fields carry defaults
 * that loadConfig() fills in before returning a ResolvedConfig.
 */
export interface FixelConfig {
  figma:      FigmaConfig;
  /**
   * UI framework used in generated code.
   * Controls which framework-specific rules are injected into the AI prompt.
   * @default "mui"
   */
  framework?: string;
  storybook?: StorybookConfig;
  tokens:     TokensConfig;
  typography: TypographyConfig;
  output:     OutputConfig;
  testing?:   TestingConfig;
  ai:         AiConfig;
  /** Anti-patterns to enforce after generation.  Defaults to the three core patterns. */
  prohibitedPatterns?: ProhibitedPattern[];
}

// ── resolved config (after defaults + env-var expansion) ─────────────────────

/**
 * Fully resolved config returned by loadConfig().
 *
 * All optional fields are filled with defaults.
 * figma.accessToken is stored as the raw config string (e.g. "${FIGMA_ACCESS_TOKEN}").
 * Call resolveFigmaToken(config) to get the actual token value — only at network call sites.
 */
export interface ResolvedConfig {
  figma: {
    /** Raw token string from config — may be "${ENV_VAR}". Call resolveFigmaToken() to resolve. */
    accessToken: string;
  };
  framework: string;
  storybook: {
    framework:      string;
    /** Derived from storybook.framework: "@storybook/" + framework. */
    adapterPackage: string;
  };
  tokens: Required<TokensConfig>;
  typography: {
    /**
     * Path to the typography definition file, relative to the project root.
     *
     * When absent, `fixel verify` skips line-height cross-checking against
     * the typography source file and relies solely on the lineHeight values
     * declared in the typography.scale config entries.  All other drift checks
     * (token names, spacing, icon sizes, border-radius) run regardless.
     */
    file?:        string;
    importPath:   string;
    scale:        TypographyScale;
    /**
     * Resolved class name template for Tailwind typography.
     * Always set — defaults to "typography-{token}" when not in config.
     * See TypographyConfig.tailwindClass for the expansion rules.
     */
    tailwindClass: string;
  };
  output: Required<OutputConfig>;
  testing: Required<TestingConfig>;
  ai:                 AiConfig;
  prohibitedPatterns: ProhibitedPattern[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const CONFIG_FILENAME = 'fixel.config.json';

const SUPPORTED_FORMATS:   ReadonlySet<string> = new Set(['typescript-object']);
const SUPPORTED_PROVIDERS: ReadonlySet<string> = new Set(['anthropic', 'openai']);

const DEFAULT_FRAMEWORK         = 'mui';
const DEFAULT_STORYBOOK_FW      = 'nextjs-vite';
const DEFAULT_SEMANTIC_EXPORT   = 'semantic';
const DEFAULT_CONSTANTS_EXPORT  = 'constants';
const DEFAULT_NAMING_CONVENTION = 'semantic.{group}.{role}';
const DEFAULT_TEST_SUBDIR       = '__tests__';
const DEFAULT_TEST_FRAMEWORK    = 'jest';
const DEFAULT_RENDER_LIBRARY    = '@testing-library/react';
const DEFAULT_AI_MODEL          = 'claude-sonnet-4-6';
const DEFAULT_TAILWIND_CLASS    = 'typography-{token}';

const DEFAULT_PROHIBITED_PATTERNS: ProhibitedPattern[] = [
  'raw-hex',
  'raw-rgba',
  'bare-border-radius',
  // Tailwind-specific: only fire when config.framework === 'tailwind' (Gate 2).
  // Listed here so Tailwind users get them without any extra config.
  'tailwind-raw-hex-arbitrary',
  'tailwind-raw-rgb-arbitrary',
];

// ─── Helpers: env loading ─────────────────────────────────────────────────────

/**
 * Reads a .env.local file from dir and populates process.env with any
 * KEY=VALUE pairs found, without overwriting variables already set.
 * Silent no-op when the file does not exist.
 */
export function loadEnvFile(dir: string = process.cwd()): void {
  const envPath = path.join(dir, '.env.local');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !(key in process.env)) process.env[key] = val;
  }
}

/**
 * Expands "${ENV_VAR_NAME}" references in a string value.
 * Returns the raw string unchanged when it is not an env-var reference.
 * Throws FixelConfigError when the referenced variable is not set.
 */
function resolveEnvRef(value: string, fieldPath: string): string {
  const match = /^\$\{([^}]+)\}$/.exec(value);
  if (!match) return value;                // not a reference — use as-is

  const envVar = match[1].trim();
  const resolved = process.env[envVar];
  if (!resolved) {
    throw new FixelConfigError(
      `"${fieldPath}" references env var ${envVar}, which is not set.\n` +
      `  Export it before running fixel:\n` +
      `    export ${envVar}=<your-value>\n` +
      `  Or add it to .env.local in your project root.`,
    );
  }
  return resolved;
}

// ─── Helpers: validation ──────────────────────────────────────────────────────

/**
 * Asserts that cfg[key] exists and is a non-null object (not an array).
 * Used to verify required top-level sections such as "tokens" or "ai".
 */
function requireSection(
  cfg:      Record<string, unknown>,
  key:      string,
  filename: string,
): asserts cfg is Record<string, unknown> & Record<typeof key, Record<string, unknown>> {
  const val = cfg[key];
  if (val === undefined || val === null) {
    throw new FixelConfigError(
      `Missing required section "${key}" in ${filename}.\n` +
      `  Run "fixel init" to generate a valid config.`,
    );
  }
  if (typeof val !== 'object' || Array.isArray(val)) {
    throw new FixelConfigError(
      `"${key}" in ${filename} must be a JSON object, not ${Array.isArray(val) ? 'an array' : typeof val}.`,
    );
  }
}

/**
 * Asserts that obj[key] is a non-empty string.
 * fieldPath is the dotted path shown in error messages ("tokens.importPath").
 */
function requireString(
  obj:       Record<string, unknown>,
  key:       string,
  fieldPath: string,
  filename:  string,
): void {
  const val = obj[key];
  if (typeof val !== 'string' || !val.trim()) {
    throw new FixelConfigError(
      `"${fieldPath}" is required and must be a non-empty string in ${filename}.`,
    );
  }
}

/**
 * Validates every entry in the typography scale object.
 * Throws FixelConfigError on the first invalid key or value found.
 */
function validateTypographyScale(
  scale:    Record<string, unknown>,
  filename: string,
): void {
  const entries = Object.entries(scale);
  if (entries.length === 0) {
    throw new FixelConfigError(
      `typography.scale must have at least one entry in ${filename}.\n` +
      `  Example: { "12/500": { "token": "MD_Medium", "lineHeight": "16px" } }`,
    );
  }

  for (const [key, value] of entries) {
    // Key must be "fontSize/fontWeight" or "fontSize/any"
    if (!/^\d+\/(any|\d+)$/.test(key)) {
      throw new FixelConfigError(
        `typography.scale key "${key}" in ${filename} is invalid.\n` +
        `  Expected "fontSize/fontWeight" or "fontSize/any".\n` +
        `  Examples: "12/500", "14/700", "34/any"`,
      );
    }

    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new FixelConfigError(
        `typography.scale["${key}"] in ${filename} must be an object.`,
      );
    }

    const entry = value as Record<string, unknown>;
    if (typeof entry['token'] !== 'string' || !entry['token']) {
      throw new FixelConfigError(
        `typography.scale["${key}"].token in ${filename} must be a non-empty string.\n` +
        `  Example: "MD_Medium"`,
      );
    }
    if (typeof entry['lineHeight'] !== 'string' || !entry['lineHeight']) {
      throw new FixelConfigError(
        `typography.scale["${key}"].lineHeight in ${filename} must be a non-empty string.\n` +
        `  Example: "16px"`,
      );
    }
  }
}

// ─── Helpers: optional string with default ───────────────────────────────────

/**
 * Returns val.trim() when val is a non-empty string, otherwise returns
 * defaultValue.  Centralises the pattern used throughout loadConfig() so
 * TypeScript always sees a boolean condition (val.trim() !== '') rather than
 * a string-as-boolean, which the compiler cannot narrow reliably.
 */
function optStr(val: unknown, defaultValue: string): string {
  return typeof val === 'string' && val.trim() !== '' ? val.trim() : defaultValue;
}

// ─── Storybook adapter derivation ────────────────────────────────────────────

/**
 * Maps the short framework identifier to its full npm package name.
 * Falls back to "@storybook/<framework>" for unlisted values so that
 * new Storybook packages work without a fixel update.
 */
function storybookAdapterPackage(framework: string): string {
  const known: Record<string, string> = {
    'nextjs-vite':    '@storybook/nextjs-vite',
    'react-vite':     '@storybook/react-vite',
    'react-webpack5': '@storybook/react-webpack5',
    'vue3-vite':      '@storybook/vue3-vite',
    'svelte-vite':    '@storybook/svelte-vite',
  };
  return known[framework] ?? `@storybook/${framework}`;
}

// ─── CLI argument helper ──────────────────────────────────────────────────────

export interface ParsedNodeArg {
  fileKey: string;
  nodeId:  string;
}

/**
 * Parses the --node CLI argument in FILEKEY:NODEID format.
 *
 * Figma file keys are base58 strings that never contain colons.
 * Node IDs always contain exactly one colon ("397:23320").
 * Splitting on the first colon gives the correct result for both.
 *
 * @example
 *   parseNodeArg("AbCdEfGhIjKlMnOpQrStUv:397:23320")
 *   // → { fileKey: "AbCdEfGhIjKlMnOpQrStUv", nodeId: "397:23320" }
 *
 * @throws {FixelConfigError} when the argument is missing, empty, or has no colon.
 */
export function parseNodeArg(raw: string): ParsedNodeArg {
  if (!raw || !raw.trim()) {
    throw new FixelConfigError(
      `--node requires a value in FILEKEY:NODEID format.\n` +
      `  Example: --node AbCdEfGhIjKlMnOpQrStUv:397:23320`,
    );
  }

  const colonIdx = raw.indexOf(':');
  if (colonIdx === -1) {
    throw new FixelConfigError(
      `--node value "${raw}" is missing the colon separator.\n` +
      `  Expected format: FILEKEY:NODEID\n` +
      `  Example: --node AbCdEfGhIjKlMnOpQrStUv:397:23320`,
    );
  }

  const fileKey = raw.slice(0, colonIdx).trim();
  const nodeId  = raw.slice(colonIdx + 1).trim();

  if (!fileKey) {
    throw new FixelConfigError(
      `--node value "${raw}" has an empty file key.\n` +
      `  The file key is the part before the first colon.\n` +
      `  Find it in the Figma file URL: figma.com/file/FILEKEY/...`,
    );
  }
  if (!nodeId) {
    throw new FixelConfigError(
      `--node value "${raw}" has an empty node ID.\n` +
      `  The node ID is the part after the first colon, e.g. "397:23320".\n` +
      `  Right-click any frame in Figma → Copy link → the node ID is in the URL.`,
    );
  }

  return { fileKey, nodeId };
}

// ─── AI key resolver ──────────────────────────────────────────────────────────

/**
 * Returns the AI API key for the configured provider, read from process.env.
 * The key is never stored in fixel.config.json.
 *
 * @throws {FixelConfigError} when the expected env var is not set.
 */
export function resolveAiApiKey(config: ResolvedConfig): string {
  const envVarName =
    config.ai.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
  const key = process.env[envVarName];
  if (!key) {
    throw new FixelConfigError(
      `AI provider "${config.ai.provider}" requires the ${envVarName} env var, which is not set.\n` +
      `  Export it before running fixel:\n` +
      `    export ${envVarName}=<your-api-key>\n` +
      `  Or add it to .env.local in your project root.\n` +
      `  The API key is NEVER stored in fixel.config.json.`,
    );
  }
  return key;
}

/**
 * Resolves the Figma personal access token from the environment.
 * Call this only at network call sites (scan, generate, verify --node, annotate).
 * Never call it in offline verify — CI runners have no FIGMA_ACCESS_TOKEN.
 *
 * @throws {FixelConfigError} when the env var is not set.
 */
export function resolveFigmaToken(config: ResolvedConfig): string {
  return resolveEnvRef(config.figma.accessToken, 'figma.accessToken');
}

// ─── Config file helpers ──────────────────────────────────────────────────────

/**
 * Returns true when fixel.config.json exists in the given directory.
 * Used by `fixel init` to offer an overwrite prompt.
 */
export function configExists(dir: string = process.cwd()): boolean {
  return fs.existsSync(path.join(dir, CONFIG_FILENAME));
}

// ─── loadConfig ───────────────────────────────────────────────────────────────

/**
 * Reads fixel.config.json from the project root, validates every required
 * field, applies defaults to optional fields, and expands env-var references.
 *
 * Call this once at the start of each CLI command.  The returned ResolvedConfig
 * is immutable — callers should not mutate it.
 *
 * @param configPath  Override the config file path (primarily for tests).
 * @throws {FixelConfigError}  Config missing, invalid JSON, missing fields, or unset env vars.
 */
export function loadConfig(configPath?: string): ResolvedConfig {
  const filePath = configPath ?? path.resolve(process.cwd(), CONFIG_FILENAME);
  const filename  = path.basename(filePath);

  // ── 0. Load .env.local so env-var references resolve during development ───
  loadEnvFile(path.dirname(filePath));

  // ── 1. Read file ───────────────────────────────────────────────────────────
  if (!fs.existsSync(filePath)) {
    throw new FixelConfigError(
      `${CONFIG_FILENAME} not found at:\n` +
      `  ${filePath}\n\n` +
      `  Run "fixel init" to create one.`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    throw new FixelConfigError(
      `${filename} is not valid JSON.\n` +
      `  Check for trailing commas, unquoted keys, or mismatched brackets.`,
    );
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new FixelConfigError(
      `${filename} must contain a JSON object at the top level.`,
    );
  }

  const cfg = raw as Record<string, unknown>;

  // ── 2. Required top-level sections ────────────────────────────────────────
  requireSection(cfg, 'figma',      filename);
  requireSection(cfg, 'tokens',     filename);
  requireSection(cfg, 'typography', filename);
  requireSection(cfg, 'output',     filename);
  requireSection(cfg, 'ai',         filename);

  // ── 3. figma ───────────────────────────────────────────────────────────────
  const figmaRaw = cfg['figma'] as Record<string, unknown>;
  requireString(figmaRaw, 'accessToken', 'figma.accessToken', filename);
  const accessToken = figmaRaw['accessToken'] as string; // kept raw — resolved lazily by resolveFigmaToken()

  // ── 4. framework (optional, default "mui") ────────────────────────────────
  const framework = optStr(cfg['framework'], DEFAULT_FRAMEWORK);

  // ── 5. storybook (optional) ───────────────────────────────────────────────
  const storybookRaw = typeof cfg['storybook'] === 'object' && cfg['storybook'] !== null
    ? cfg['storybook'] as Record<string, unknown>
    : {};
  const storybookFramework = optStr(storybookRaw['framework'], DEFAULT_STORYBOOK_FW);

  // ── 6. tokens ─────────────────────────────────────────────────────────────
  const tokensRaw = cfg['tokens'] as Record<string, unknown>;
  requireString(tokensRaw, 'file',       'tokens.file',       filename);
  requireString(tokensRaw, 'format',     'tokens.format',     filename);
  requireString(tokensRaw, 'importPath', 'tokens.importPath', filename);

  const tokensFormat = (tokensRaw['format'] as string).trim();
  if (!SUPPORTED_FORMATS.has(tokensFormat)) {
    throw new FixelConfigError(
      `tokens.format "${tokensFormat}" is not supported in ${filename}.\n` +
      `  Supported formats: ${[...SUPPORTED_FORMATS].map((f) => `"${f}"`).join(', ')}`,
    );
  }

  const tokens: Required<TokensConfig> = {
    file:             (tokensRaw['file']       as string).trim(),
    format:           tokensFormat as TokenFileFormat,
    importPath:       (tokensRaw['importPath'] as string).trim(),
    semanticExport:   optStr(tokensRaw['semanticExport'],   DEFAULT_SEMANTIC_EXPORT),
    constantsExport:  optStr(tokensRaw['constantsExport'],  DEFAULT_CONSTANTS_EXPORT),
    namingConvention: optStr(tokensRaw['namingConvention'], DEFAULT_NAMING_CONVENTION),
  };

  // ── 7. typography ─────────────────────────────────────────────────────────
  const typographyRaw = cfg['typography'] as Record<string, unknown>;
  requireString(typographyRaw, 'importPath', 'typography.importPath', filename);

  if (
    typographyRaw['scale'] === undefined ||
    typographyRaw['scale'] === null ||
    typeof typographyRaw['scale'] !== 'object' ||
    Array.isArray(typographyRaw['scale'])
  ) {
    throw new FixelConfigError(
      `typography.scale is required in ${filename}.\n` +
      `  It maps "fontSize/fontWeight" keys to { token, lineHeight } entries.\n\n` +
      `  Minimal example:\n` +
      `  "scale": {\n` +
      `    "14/700": { "token": "LG_Bold",   "lineHeight": "20px" },\n` +
      `    "12/500": { "token": "MD_Medium",  "lineHeight": "16px" },\n` +
      `    "12/400": { "token": "MD_Regular", "lineHeight": "16px" }\n` +
      `  }`,
    );
  }

  const scale = typographyRaw['scale'] as Record<string, unknown>;
  validateTypographyScale(scale, filename);

  const typographyFile = optStr(typographyRaw['file'], '');
  const typography = {
    file:         typographyFile !== '' ? typographyFile : undefined,
    importPath:   (typographyRaw['importPath'] as string).trim(),
    scale:        scale as TypographyScale,
    tailwindClass: optStr(typographyRaw['tailwindClass'], DEFAULT_TAILWIND_CLASS),
  };

  // ── 8. output ─────────────────────────────────────────────────────────────
  const outputRaw = cfg['output'] as Record<string, unknown>;
  requireString(outputRaw, 'componentDir', 'output.componentDir', filename);

  const output: Required<OutputConfig> = {
    componentDir: (outputRaw['componentDir'] as string).trim(),
    testSubdir:   optStr(outputRaw['testSubdir'], DEFAULT_TEST_SUBDIR),
  };

  // ── 9. testing (optional) ─────────────────────────────────────────────────
  const testingRaw = typeof cfg['testing'] === 'object' && cfg['testing'] !== null
    ? cfg['testing'] as Record<string, unknown>
    : {};

  const testFramework = typeof testingRaw['framework'] === 'string'
    ? testingRaw['framework'] as 'jest' | 'vitest'
    : DEFAULT_TEST_FRAMEWORK as 'jest';

  if (testFramework !== 'jest' && testFramework !== 'vitest') {
    throw new FixelConfigError(
      `testing.framework "${testFramework}" is not supported in ${filename}.\n` +
      `  Supported values: "jest", "vitest"`,
    );
  }

  const testing: Required<TestingConfig> = {
    framework:     testFramework,
    renderLibrary: optStr(testingRaw['renderLibrary'], DEFAULT_RENDER_LIBRARY),
  };

  // ── 10. ai ────────────────────────────────────────────────────────────────
  const aiRaw = cfg['ai'] as Record<string, unknown>;
  requireString(aiRaw, 'provider', 'ai.provider', filename);
  requireString(aiRaw, 'model',    'ai.model',    filename);

  const provider = (aiRaw['provider'] as string).trim();
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    throw new FixelConfigError(
      `ai.provider "${provider}" is not supported in ${filename}.\n` +
      `  Supported providers: ${[...SUPPORTED_PROVIDERS].map((p) => `"${p}"`).join(', ')}\n` +
      `  The API key is read from the corresponding env var — never stored in config.`,
    );
  }

  const ai: AiConfig = {
    provider: provider as AiProvider,
    model:    (aiRaw['model'] as string).trim(),
  };

  // ── 11. prohibitedPatterns (optional) ─────────────────────────────────────
  let prohibitedPatterns: ProhibitedPattern[];

  if (cfg['prohibitedPatterns'] !== undefined) {
    if (!Array.isArray(cfg['prohibitedPatterns'])) {
      throw new FixelConfigError(
        `prohibitedPatterns in ${filename} must be a JSON array of strings.`,
      );
    }
    const rawPatterns = cfg['prohibitedPatterns'] as unknown[];
    for (let i = 0; i < rawPatterns.length; i++) {
      if (typeof rawPatterns[i] !== 'string' || !(rawPatterns[i] as string).trim()) {
        throw new FixelConfigError(
          `prohibitedPatterns[${i}] in ${filename} must be a non-empty string.`,
        );
      }
    }
    prohibitedPatterns = rawPatterns as ProhibitedPattern[];
  } else {
    prohibitedPatterns = [...DEFAULT_PROHIBITED_PATTERNS];
  }

  // ── Assemble ───────────────────────────────────────────────────────────────
  return {
    figma:    { accessToken },
    framework,
    storybook: {
      framework:      storybookFramework,
      adapterPackage: storybookAdapterPackage(storybookFramework),
    },
    tokens,
    typography,
    output,
    testing,
    ai,
    prohibitedPatterns,
  };
}

// ─── createDefaultConfig ─────────────────────────────────────────────────────

/**
 * Returns a template FixelConfig populated with sensible defaults and
 * placeholder values.  Used by `fixel init` to write the initial config file.
 *
 * The typography scale is pre-filled with a complete MUI-style scale covering
 * headings (H1–H5), body text (LG/MD/SM variants), and overline.
 * Users replace or extend these entries to match their own design system.
 *
 * No real API keys, file keys, or access tokens appear here — all sensitive
 * values are environment-variable references.
 */
export function createDefaultConfig(): FixelConfig {
  return {
    figma: {
      accessToken: '${FIGMA_ACCESS_TOKEN}',
    },
    framework: 'mui',
    storybook: {
      framework: 'nextjs-vite',
    },
    tokens: {
      file:             './src/tokens/colors.ts',
      format:           'typescript-object',
      importPath:       '@/tokens/colors',
      semanticExport:   'semantic',
      constantsExport:  'constants',
      namingConvention: 'semantic.{group}.{role}',
    },
    typography: {
      importPath: '@/tokens/typography',
      scale: {
        // Headings — weight is always 700 in most design systems; "any" matches all
        '34/any': { token: 'H1', lineHeight: '40px' },
        '28/any': { token: 'H2', lineHeight: '34px' },
        '22/any': { token: 'H3', lineHeight: '28px' },
        '18/any': { token: 'H4', lineHeight: '24px' },
        '16/any': { token: 'H5', lineHeight: '22px' },
        // Large body (14px)
        '14/700': { token: 'LG_Bold',     lineHeight: '20px' },
        '14/500': { token: 'LG_Medium',   lineHeight: '20px' },
        '14/400': { token: 'LG_Regular',  lineHeight: '20px' },
        // Medium body (12px)
        '12/700': { token: 'MD_Bold',     lineHeight: '16px' },
        '12/600': { token: 'MD_SemiBold', lineHeight: '16px' },
        '12/500': { token: 'MD_Medium',   lineHeight: '16px' },
        '12/400': { token: 'MD_Regular',  lineHeight: '16px' },
        // Small body (11px)
        '11/700': { token: 'SM_Bold',     lineHeight: '16px' },
        '11/500': { token: 'SM_Medium',   lineHeight: '16px' },
        '11/400': { token: 'SM_Regular',  lineHeight: '16px' },
        // Overline (10px)
        '10/any': { token: 'Overline_Bold', lineHeight: '16px' },
      },
    },
    output: {
      componentDir: './src/components',
      testSubdir:   '__tests__',
    },
    testing: {
      framework:     'jest',
      renderLibrary: '@testing-library/react',
    },
    ai: {
      provider: 'anthropic',
      model:    DEFAULT_AI_MODEL,
    },
    prohibitedPatterns: [
      'raw-hex',
      'raw-rgba',
      'bare-border-radius',
    ],
  };
}
