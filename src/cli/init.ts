#!/usr/bin/env node
// Copyright (c) 2025 Amrutha Kollu. All rights reserved.
// Licensed under the Functional Source License, Version 1.1 (FSL-1.1-MIT) — see LICENSE for details.

/**
 * fixel init — interactive project setup
 *
 * Asks five questions and writes fixel.config.json.
 * Safe to re-run: prompts before overwriting an existing config.
 *
 * Usage:
 *   fixel init
 *   fixel init --yes   (accept all defaults, skip prompts)
 */

import * as fs   from 'node:fs';
import * as path from 'node:path';

import { confirm, input, select } from '@inquirer/prompts';

import {
  CONFIG_FILENAME,
  FixelConfigError,
  configExists,
  createDefaultConfig,
  type AiProvider,
  type FixelConfig,
} from '../core/config';

// ─── ANSI helpers ─────────────────────────────────────────────────────────────

const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
};

// ─── CLI args ─────────────────────────────────────────────────────────────────

function parseInitArgs(argv: string[]): { yes: boolean } {
  return { yes: argv.includes('--yes') || argv.includes('-y') };
}

// ─── Storybook framework inference ───────────────────────────────────────────

/**
 * Infers a sensible default Storybook framework from the chosen UI framework.
 * Can be overridden manually in fixel.config.json after init.
 */
function defaultStorybookFramework(uiFramework: string): string {
  const map: Record<string, string> = {
    mui:         'nextjs-vite',
    tailwind:    'react-vite',
    'css-modules': 'react-vite',
  };
  return map[uiFramework] ?? 'react-vite';
}

// ─── Main ─────────────────────────────────────────────────────────────────────

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Reads package.json in cwd and returns the set of all dependency names
 * (dependencies + devDependencies).  Returns an empty Set on any read/parse error.
 */
function readPackageDeps(): Set<string> {
  try {
    const pkgPath = path.resolve(process.cwd(), 'package.json');
    if (!fs.existsSync(pkgPath)) return new Set();
    const raw = fs.readFileSync(pkgPath, 'utf8').replace(/^﻿/, ''); // strip UTF-8 BOM
    const pkg = JSON.parse(raw) as {
      dependencies?:    Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return new Set([
      ...Object.keys(pkg.dependencies    ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]);
  } catch {
    return new Set();
  }
}

/**
 * Derives a default import alias from a token file path.
 * ./src/styles/tokens.ts  →  @/styles/tokens
 * ./tokens/colors.ts       →  @/tokens/colors
 */
function deriveImportAlias(tokenFilePath: string): string {
  let p = tokenFilePath.replace(/\\/g, '/');
  p = p.replace(/^\.\//, '');
  p = p.replace(/^src\//, '');
  p = p.replace(/\.(ts|tsx|js|mjs|cjs)$/, '');
  return `@/${p}`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { yes } = parseInitArgs(process.argv.slice(2));
  const defaults = createDefaultConfig();
  const configPath = path.resolve(process.cwd(), CONFIG_FILENAME);

  console.log(`\n${C.bold}  fixel init${C.reset}\n`);

  // ── Overwrite guard ────────────────────────────────────────────────────────
  if (configExists()) {
    if (yes) {
      console.log(`  ${C.yellow}⚠${C.reset}  ${CONFIG_FILENAME} already exists — overwriting (--yes)\n`);
    } else {
      const overwrite = await confirm({
        message: `${CONFIG_FILENAME} already exists in this directory. Overwrite it?`,
        default: false,
      });
      if (!overwrite) {
        console.log(`\n  ${C.dim}Cancelled — existing config preserved.${C.reset}\n`);
        process.exit(0);
      }
      console.log('');
    }
  }

  // ── D6: Framework auto-detect from package.json ───────────────────────────
  const deps = readPackageDeps();
  const detectedFramework: string =
    deps.has('tailwindcss')    ? 'tailwind' :
    deps.has('@mui/material')  ? 'mui'      :
    defaults.framework ?? 'mui';

  // ── Question 1: UI framework ───────────────────────────────────────────────
  const framework = yes
    ? detectedFramework
    : await select({
        message: 'Which UI framework does your project use?',
        default: detectedFramework as 'mui' | 'tailwind' | 'css-modules' | 'other',
        choices: [
          {
            name:  'Material UI (MUI v5+)',
            value: 'mui',
            description: 'MUI sx props, Box + Typography pattern',
          },
          {
            name:  'Tailwind CSS',
            value: 'tailwind',
            description: 'className-based styling',
          },
          {
            name:  'CSS Modules',
            value: 'css-modules',
            description: 'scoped CSS class names',
          },
          {
            name:  'Other',
            value: 'other',
            description: 'Edit fixel.config.json manually after init',
          },
        ],
      });

  // ── Question 2: Token file path (D3: validate existence, re-prompt on miss) ─
  let tokenFile: string = defaults.tokens.file;
  if (!yes) {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      tokenFile = await input({
        message: 'Path to your design token file (relative to project root):',
        default: tokenFile,
        validate: (v) => v.trim() !== '' || 'Token file path cannot be empty.',
      });
      const resolved = path.resolve(process.cwd(), tokenFile.trim());
      if (fs.existsSync(resolved)) break;
      console.log(`  ${C.yellow}⚠${C.reset}  File not found at ${resolved}`);
      const proceed = await confirm({
        message: `Proceed anyway? (You can create the file after init.)`,
        default: false,
      });
      if (proceed) break;
    }
  }

  // ── Question 3: Token import alias (D4: derive default; D5: add hint) ─────
  const derivedAlias    = deriveImportAlias(tokenFile.trim());
  const tokenImportPath = yes
    ? derivedAlias
    : await input({
        message: 'Import alias for the token file in generated component code:\n' +
                 `  ${C.dim}(use a relative path, e.g. ../../tokens, if no path alias is configured)${C.reset}`,
        default: derivedAlias,
        validate: (v) => v.trim() !== '' || 'Token import path cannot be empty.',
      });

  // ── Question 4: Typography import alias ───────────────────────────────────
  const typographyImportPath = yes
    ? defaults.typography.importPath
    : await input({
        message: 'Import alias for typography definitions in generated test code:',
        default: defaults.typography.importPath,
        validate: (v) => v.trim() !== '' || 'Typography import path cannot be empty.',
      });

  // ── Question 5: AI provider ────────────────────────────────────────────────
  const aiProvider: AiProvider = yes
    ? (defaults.ai.provider as AiProvider)
    : await select({
        message: 'Which AI provider will you use for fixel generate?',
        choices: [
          {
            name:  'Anthropic (Claude)',
            value: 'anthropic' as AiProvider,
            description: 'Reads ANTHROPIC_API_KEY from environment',
          },
          {
            name:  'OpenAI (GPT)',
            value: 'openai' as AiProvider,
            description: 'Reads OPENAI_API_KEY from environment',
          },
        ],
      });

  // ── Assemble config ────────────────────────────────────────────────────────
  const config: FixelConfig = {
    ...defaults,
    framework,
    storybook: {
      framework: defaultStorybookFramework(framework),
    },
    tokens: {
      ...defaults.tokens,
      file:       tokenFile.trim(),
      importPath: tokenImportPath.trim(),
    },
    typography: {
      ...defaults.typography,
      importPath: typographyImportPath.trim(),
    },
    ai: {
      ...defaults.ai,
      provider: aiProvider,
    },
  };

  // ── Write config ───────────────────────────────────────────────────────────
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');

  console.log(`\n  ${C.green}✓${C.reset}  ${C.bold}${CONFIG_FILENAME} written${C.reset}`);
  console.log(`     ${C.dim}${configPath}${C.reset}\n`);

  // ── Update .gitignore ──────────────────────────────────────────────────────
  // Add .fixel-scan.json (and node_modules/.cache/fixel/) if not already present.
  // We append only the missing lines so existing .gitignore content is preserved.
  const gitignorePath = path.resolve(process.cwd(), '.gitignore');
  const gitignoreEntries = ['.env.local', '.fixel-scan.json', 'node_modules/.cache/fixel/'];

  const existing = fs.existsSync(gitignorePath)
    ? fs.readFileSync(gitignorePath, 'utf8')
    : '';

  const missing = gitignoreEntries.filter((e) => !existing.split('\n').includes(e));

  if (missing.length > 0) {
    const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    const block     = '\n# Fixel runtime artifacts\n' + missing.join('\n') + '\n';
    fs.appendFileSync(gitignorePath, separator + block, 'utf8');
    console.log(
      `  ${C.green}✓${C.reset}  Added to .gitignore: ${missing.join(', ')}\n`,
    );
  }

  // ── Next steps ─────────────────────────────────────────────────────────────
  const apiKeyVar = aiProvider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';

  console.log(`  ${C.bold}Next steps:${C.reset}\n`);
  console.log(`  1. Create a Figma personal access token:\n`);
  console.log(`     ${C.dim}figma.com → Account → Settings → Security → Personal access tokens${C.reset}`);
  console.log(`     Required scopes:`);
  console.log(`       • ${C.cyan}Read the contents of files${C.reset}`);
  console.log(`       • ${C.cyan}Read metadata of files${C.reset}`);
  if (framework !== 'other') {
    console.log(`       • ${C.cyan}Create, modify and delete comments${C.reset} — only needed for ${C.bold}fixel annotate${C.reset}`);
  }
  console.log('');
  console.log(`  2. Set your environment variables (add to .env.local or export in your shell):\n`);
  console.log(`     ${C.cyan}FIGMA_ACCESS_TOKEN${C.reset}=<your-figma-personal-access-token>`);
  console.log(`     ${C.cyan}${apiKeyVar}${C.reset}=<your-api-key>\n`);
  console.log(`  3. Open ${C.bold}${CONFIG_FILENAME}${C.reset} and update ${C.cyan}typography.scale${C.reset} to match`);
  console.log(`     your design system's font sizes and token names.`);
  console.log(`     The defaults are a starting point — replace token names with yours.\n`);
  console.log(`  4. Verify token coverage for a Figma component:\n`);
  console.log(`     ${C.cyan}fixel scan --node FILEKEY:NODEID --group mycomponent${C.reset}\n`);
  console.log(`  5. Generate your first component:\n`);
  console.log(`     ${C.cyan}fixel generate --name MyComponent --node FILEKEY:NODEID${C.reset}\n`);

  if (framework === 'other') {
    console.log(`  ${C.yellow}Note:${C.reset} You selected "Other" as your framework.`);
    console.log(`  MUI-specific rules will not be injected into the AI prompt.`);
    console.log(`  Edit ${C.bold}${CONFIG_FILENAME}${C.reset} to set ${C.cyan}framework${C.reset} once you know the correct value.\n`);
  }
}

// ─── Entry ────────────────────────────────────────────────────────────────────

main().catch((err: unknown) => {
  // @inquirer/prompts throws ExitPromptError when the user presses Ctrl+C.
  if (
    typeof err === 'object' && err !== null &&
    'name' in err && (err as { name: string }).name === 'ExitPromptError'
  ) {
    console.log('\n  Cancelled.\n');
    process.exit(0);
  }
  if (err instanceof FixelConfigError) {
    console.error(`\n  ${C.yellow}Config error:${C.reset} ${err.message}\n`);
    process.exit(1);
  }
  console.error(`\n  Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
