// Copyright (c) 2025 Amrutha Kollu. All rights reserved.
// Licensed under the MIT License — see LICENSE for details.

export interface Colors {
  reset:  string;
  bold:   string;
  dim:    string;
  green:  string;
  yellow: string;
  red:    string;
  cyan:   string;
}

const EMPTY: Colors = { reset: '', bold: '', dim: '', green: '', yellow: '', red: '', cyan: '' };
const FULL:  Colors = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  cyan:   '\x1b[36m',
};

/** Returns ANSI codes when tty is true, empty strings otherwise. */
export function makeC(tty: boolean): Colors {
  return tty ? FULL : EMPTY;
}

/**
 * Returns the ANSI color set appropriate for process.stdout.
 * Returns empty strings when stdout is not a TTY or when NO_COLOR is set.
 * Safe for pipes, CI, and MCP tool responses.
 */
export function stdoutC(): Colors {
  return makeC(!!process.stdout.isTTY && !process.env['NO_COLOR']);
}
