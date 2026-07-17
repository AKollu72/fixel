// Copyright (c) 2025 Amrutha Kollu. All rights reserved.
// Licensed under the Functional Source License, Version 1.1 (FSL-1.1-MIT) — see LICENSE for details.

/**
 * Overrides registry — intentional code↔Figma deviations.
 *
 * When a component intentionally diverges from its Figma specification
 * (approved by the design team, density reduction, accessibility requirement, etc.)
 * the deviation can be registered here so fixel verify suppresses the drift
 * error and prints "OVERRIDE" instead.
 *
 * Storage: fixel.overrides.json in the project root.
 * Commit this file — it is the audit trail of approved deviations.
 *
 * Format:
 *   {
 *     "Badge": {
 *       "borderRadius.8": {
 *         "figmaValue": "'8px'",
 *         "codeValue":  "'6px'",
 *         "reason":     "Design team approved reduction for density",
 *         "date":       "2026-06-09"
 *       }
 *     }
 *   }
 *
 * Check key catalogue:
 *   typography.<token>            e.g. "typography.bodySm"
 *   spacing.<container>.<prop>    e.g. "spacing.Container.itemSpacing"
 *                                      "spacing.Container.paddingTop"
 *                                      "spacing.Container.paddingBottom"
 *                                      "spacing.Container.paddingLeft"
 *                                      "spacing.Container.paddingRight"
 *   iconSize.<nodeName>           e.g. "iconSize.SearchIcon"
 *   colors.rawHex                 (single check per component)
 *   borderRadius.<value>          e.g. "borderRadius.8"
 */

import * as fs   from 'node:fs';
import * as path from 'node:path';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Override {
  /** The value the Figma spec expects (e.g. "'8px'"). */
  figmaValue: string;
  /** The value actually used in the code (e.g. "'6px'"). */
  codeValue:  string;
  /** Why this deviation was approved. Required — use "Intentional deviation" if unknown. */
  reason:     string;
  /** ISO 8601 date the override was registered (e.g. "2026-06-09"). */
  date:       string;
}

/**
 * The shape of fixel.overrides.json.
 * Outer key: component name (e.g. "Badge").
 * Inner key: check key (see catalogue above).
 */
export type OverridesFile = Record<string, Record<string, Override>>;

// ─── Constants ────────────────────────────────────────────────────────────────

export const OVERRIDES_FILENAME = 'fixel.overrides.json';

// ─── I/O ──────────────────────────────────────────────────────────────────────

/**
 * Reads fixel.overrides.json from the project root.
 * Returns an empty registry if the file does not exist.
 * Throws with a clear message on JSON parse errors — corruption must be surfaced
 * immediately rather than silently losing override data.
 */
export function loadOverrides(root: string): OverridesFile {
  const overridesPath = path.join(root, OVERRIDES_FILENAME);
  if (!fs.existsSync(overridesPath)) return {};
  const raw = fs.readFileSync(overridesPath, 'utf8');
  try {
    return JSON.parse(raw) as OverridesFile;
  } catch {
    throw new Error(
      `fixel.overrides.json is not valid JSON.\n` +
      `Path: ${overridesPath}\n` +
      `Fix or delete the file to continue.`,
    );
  }
}

/**
 * Writes the overrides registry to fixel.overrides.json with 2-space indentation.
 * Writes UTF-8 without BOM (Node default) so the file is safe for JSON.parse().
 */
export function saveOverrides(root: string, data: OverridesFile): void {
  const overridesPath = path.join(root, OVERRIDES_FILENAME);
  fs.writeFileSync(overridesPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// ─── Registry operations ──────────────────────────────────────────────────────

/**
 * Returns the Override entry if component/checkKey is registered,
 * or null if it is not overridden.
 *
 * @example
 *   const ov = getOverride(overrides, 'Badge', 'borderRadius.8');
 *   if (ov) console.log('Override reason:', ov.reason);
 */
export function getOverride(
  data:      OverridesFile,
  component: string,
  key:       string,
): Override | null {
  return data[component]?.[key] ?? null;
}

/**
 * Registers or updates an override entry in the in-memory registry.
 * Call saveOverrides() after all setOverride() calls to persist to disk.
 */
export function setOverride(
  data:      OverridesFile,
  component: string,
  key:       string,
  override:  Override,
): void {
  if (!data[component]) {
    data[component] = {};
  }
  data[component][key] = override;
}

/**
 * Removes a single override entry from the in-memory registry.
 * Returns true if the entry existed and was removed, false if it was absent.
 * Call saveOverrides() afterwards to persist.
 */
export function removeOverride(
  data:      OverridesFile,
  component: string,
  key:       string,
): boolean {
  const componentOverrides = data[component];
  if (!componentOverrides || !(key in componentOverrides)) return false;
  delete componentOverrides[key];
  if (Object.keys(componentOverrides).length === 0) {
    delete data[component];
  }
  return true;
}

/**
 * Removes override entries for a component whose checks are now passing
 * (the code was fixed to match Figma, making the override redundant).
 * Returns the number of stale entries removed.
 *
 * Intended for future use by `fixel verify --prune-overrides`.
 *
 * @param passingCheckKeys - Set of check keys that currently pass without
 *   needing the override.  Build this by collecting check keys whose
 *   underlying condition is now true before consulting the overrides registry.
 */
export function pruneStaleOverrides(
  data:             OverridesFile,
  component:        string,
  passingCheckKeys: ReadonlySet<string>,
): number {
  const componentOverrides = data[component];
  if (!componentOverrides) return 0;
  let removed = 0;
  for (const key of Object.keys(componentOverrides)) {
    if (passingCheckKeys.has(key)) {
      delete componentOverrides[key];
      removed++;
    }
  }
  if (Object.keys(componentOverrides).length === 0) {
    delete data[component];
  }
  return removed;
}
