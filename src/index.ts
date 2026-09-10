#!/usr/bin/env node
// Copyright (c) 2025 Amrutha Kollu. All rights reserved.
// Licensed under the Functional Source License, Version 1.1 (FSL-1.1-MIT) — see LICENSE for details.

/**
 * fixel — Figma-to-React design system pipeline
 *
 * Parses the first positional argument and delegates to the matching command
 * module.  Each module registers its own flags via process.argv and calls
 * process.exit() when finished, so no additional plumbing is needed here.
 *
 * Commands:
 *   fixel import --file FILEKEY  — Generate token files from Figma styles
 *   fixel init                   — Interactive project setup
 *   fixel scan --node FILEKEY:ID — Token reconnaissance
 *   fixel generate --name ...    — AI-powered component generation
 *   fixel verify                 — Drift detection
 *   fixel annotate               — Post drift findings as a Figma comment
 */

const [,, command] = process.argv;

switch (command) {
  case 'import':
    require('./cli/import');
    break;

  case 'init':
    require('./cli/init');
    break;

  case 'scan':
    // Explicit call — do NOT rely on side-effectful require here.
    // scan.ts exports runScanCli() so tests can also import collectReactFiles
    // without triggering the CLI.  See 0.2.4 fix notes.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    (require('./cli/scan') as { runScanCli: () => void }).runScanCli();
    break;

  case 'generate':
    require('./cli/generate');
    break;

  case 'verify':
    require('./cli/verify');
    break;

  case 'annotate':
    require('./cli/annotate');
    break;

  case 'version':
  case '--version':
  case '-v': {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require('../package.json') as { version: string };
    console.log(`fixel v${pkg.version}`);
    process.exit(0);
  }

  case undefined:
  case 'help':
  case '--help':
  case '-h':
    printHelp();
    process.exit(0);

  default:
    console.error(`\n  Unknown command: ${JSON.stringify(command)}\n`);
    printHelp();
    process.exit(1);
}

// ─── Help ─────────────────────────────────────────────────────────────────────

function printHelp(): void {
  const b = '\x1b[1m';
  const d = '\x1b[2m';
  const c = '\x1b[36m';
  const r = '\x1b[0m';

  console.log(`
${b}  fixel${r} — Figma-to-React design system pipeline

  ${b}Usage:${r}
    fixel <command> [flags]

  ${b}Commands:${r}
    ${b}import${r}      Generate token files from Figma styles (start here)
    ${b}init${r}        Interactive setup — writes fixel.config.json
    ${b}scan${r}        Token reconnaissance for a Figma component
    ${b}generate${r}    AI-powered component generation from Figma
    ${b}verify${r}      Drift detection between Figma and component source
    ${b}annotate${r}    Post drift findings as a Figma comment

  ${b}Quick start:${r}
    ${c}fixel init${r}
    ${c}fixel import   --file FILEKEY --write${r}
    ${c}fixel scan     --node FILEKEY:NODEID --group mycomponent${r}
    ${c}fixel generate --name MyComponent --node FILEKEY:NODEID${r}
    ${c}fixel verify${r}
    ${c}fixel annotate --component MyComponent --node FILEKEY:NODEID${r}

  ${b}Common flags:${r}
    ${c}--file <FILEKEY>${r}          Figma file key                       (import)
    ${c}--node <FILEKEY:NODEID>${r}   Figma file key + node ID  (scan / generate / annotate)
    ${c}--no-cache${r}                Bypass the 24-hour Figma API cache
    ${c}--write${r}                   Write output to disk                 (import)
    ${c}--dry-run${r}                 Print output without writing files   (generate / annotate)
    ${c}--force${r}                   Overwrite existing files             (generate)

  ${b}Environment variables:${r}
    ${c}FIGMA_ACCESS_TOKEN${r}        Figma personal access token  (required)
    ${c}ANTHROPIC_API_KEY${r}         Anthropic API key            (if using Claude)
    ${c}OPENAI_API_KEY${r}            OpenAI API key               (if using GPT)

  ${d}Set env vars in .env.local — fixel loads it automatically.${r}

  ${b}Version:${r}  fixel --version
`);
}
