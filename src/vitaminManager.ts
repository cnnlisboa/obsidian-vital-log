// ============================================================
// Vital Log — Vitamin Manager
// Business logic for logging vitamins, packs, and stacks.
// Zero UI, zero direct file I/O — delegates to yamlManager.
// ============================================================

import { App, Notice, TFile } from 'obsidian';
import type {
  Vitamin,
  Pack,
  Stack,
  VitalLogSettings,
  VitaminEntry,
  SubstanceEntry,
  PackEntry,
  StackEntry,
  StackItemType,
} from './types';
import * as yaml from './yamlManager';
import { applyTemplate, noteContentHeading } from './template';
import { packUse, reportStockUse, returnStockUse, stackUse, vitaminUse } from './stock';

const DEFAULT_SUPPLEMENT_TEMPLATE = '- {time} {name} {amount}{unit}';

/** One frontmatter list entry, staged in memory before anything is written. */
export interface StagedEntry {
  propertyKey: string;
  entry: unknown;
}

// ── Public API ───────────────────────────────────────────────

/**
 * Log a single vitamin manually.
 * Pass `appendToNote: true` to also write a line to the note body using the template from settings.
 */
export async function logVitamin(
  app: App,
  file: TFile,
  vitamin: Vitamin,
  opts: { time: string; amount: number; note?: string; source?: string; appendToNote?: boolean },
  settings: VitalLogSettings
): Promise<void> {
  const staged = stageVitamin(vitamin, opts, settings);
  await yaml.appendEntry(app, file, staged.propertyKey, staged.entry);
  await reportStockUse(vitaminUse(vitamin, opts.amount));

  if (opts.appendToNote) {
    const template = settings.noteContentTemplate_supplements || DEFAULT_SUPPLEMENT_TEMPLATE;
    const line = applyTemplate(template, {
      time: opts.time,
      name: vitamin.displayName,
      amount: String(opts.amount),
      unit: vitamin.unit,
      note: opts.note ?? '',
    });
    await yaml.appendLineToBody(app, file, line, noteContentHeading(settings));
  }
}

/**
 * Log a pack (and all its vitamins).
 * @param source - "manual" or a stack displayName
 * Pass `appendToNote: true` to also write a line to the note body using the template from settings.
 * Note: only the pack name is written to note content — not the individual vitamins.
 */
export async function logPack(
  app: App,
  file: TFile,
  pack: Pack,
  settings: VitalLogSettings,
  opts: { time: string; source?: string; appendToNote?: boolean }
): Promise<void> {
  const skipped: string[] = [];
  const staged = stagePack(pack, settings, opts, skipped);

  // Commit the pack entry and every vitamin entry in one pass, so a failure
  // can't leave the note holding a pack with only some of its contents.
  await yaml.mutateFrontmatter(app, file, (_fm, appendTo) => {
    for (const { propertyKey, entry } of staged) appendTo(propertyKey, entry);
  });
  await reportStockUse(packUse(pack, settings));

  if (skipped.length > 0) {
    new Notice(
      `Vital Log: Pack "${pack.displayName}" references unknown vitamin IDs: ${skipped.join(', ')}. ` +
      `Those items were skipped.`
    );
  }

  if (opts.appendToNote) {
    const template = settings.noteContentTemplate_supplements || DEFAULT_SUPPLEMENT_TEMPLATE;
    const line = applyTemplate(template, {
      time: opts.time,
      name: pack.displayName,
      amount: '',
      unit: '',
      note: '',
    });
    await yaml.appendLineToBody(app, file, line, noteContentHeading(settings));
  }
}

/**
 * Log a stack (and all its packs and standalone vitamins).
 * Pass `appendToNote: true` to write a single line listing all stack items to the note body.
 * The {name} token is replaced with a comma-joined list of items (e.g. "Vitamin C 500mg, Morning Pack").
 */
export async function logStack(
  app: App,
  file: TFile,
  stack: Stack,
  settings: VitalLogSettings,
  opts: { time: string; appendToNote?: boolean }
): Promise<void> {
  const skipped: string[] = [];
  const staged: StagedEntry[] = [];

  // 1. Stack entry (optional)
  if (settings.logStackEntries !== false) {
    const stackEntry: StackEntry = { time: opts.time, name: stack.displayName };
    staged.push({ propertyKey: 'stacks', entry: stackEntry });
  }

  // 2. Every item, including the contents of nested packs
  //    (no per-item note content — the stack handles that below)
  for (const item of stack.items) {
    staged.push(...stageStackItem(item, stack, settings, opts, skipped));
  }

  // Commit the whole stack — entry, packs, and vitamins — in one write.
  await yaml.mutateFrontmatter(app, file, (_fm, appendTo) => {
    for (const { propertyKey, entry } of staged) appendTo(propertyKey, entry);
  });
  await reportStockUse(stackUse(stack, settings));

  if (skipped.length > 0) {
    new Notice(
      `Vital Log: Stack "${stack.displayName}" had unknown references: ${skipped.join(', ')}. ` +
      `Those items were skipped.`
    );
  }

  if (opts.appendToNote) {
    // Build a comma-joined list of all included items
    const itemNames: string[] = [];
    for (const item of stack.items) {
      if (item.type === 'vitamin') {
        const vitamin = settings.vitamins.find((v) => v.id === item.vitaminId);
        if (!vitamin) continue;
        const amount = item.amount ?? vitamin.defaultAmount;
        itemNames.push(`${vitamin.displayName} ${amount}${vitamin.unit}`);
      } else {
        const pack = settings.packs.find((p) => p.id === item.packId);
        if (!pack) continue;
        itemNames.push(pack.displayName);
      }
    }

    const template = settings.noteContentTemplate_supplements || DEFAULT_SUPPLEMENT_TEMPLATE;
    const line = applyTemplate(template, {
      time: opts.time,
      name: itemNames.join(', '),
      amount: '',
      unit: '',
      note: '',
    });
    await yaml.appendLineToBody(app, file, line, noteContentHeading(settings));
  }
}

export type LoggedSupplement =
  | { kind: 'vitamin'; vitamin: Vitamin; amount: number; source?: string }
  | { kind: 'pack'; pack: Pack; source?: string }
  | { kind: 'stack'; stack: Stack };

/** Every frontmatter entry logging `what` at `time` writes. Pure. */
export function stageSupplement(what: LoggedSupplement, time: string, settings: VitalLogSettings): StagedEntry[] {
  const skipped: string[] = [];
  switch (what.kind) {
    case 'vitamin':
      return [stageVitamin(what.vitamin, { time, amount: what.amount, source: what.source }, settings)];
    case 'pack':
      return stagePack(what.pack, settings, { time, source: what.source }, skipped);
    case 'stack': {
      const staged: StagedEntry[] = [];
      if (settings.logStackEntries !== false) staged.push({ propertyKey: 'stacks', entry: { time, name: what.stack.displayName } });
      for (const item of what.stack.items) staged.push(...stageStackItem(item, what.stack, settings, { time }, skipped));
      return staged;
    }
  }
}

/**
 * Take back a log of `what` at `time`: remove one matching entry for each
 * entry such a log writes, in one write, and put the stock back. Returns
 * how many entries were found and removed.
 */
export async function unlogSupplement(
  app: App,
  file: TFile,
  what: LoggedSupplement,
  time: string,
  settings: VitalLogSettings
): Promise<number> {
  const staged = stageSupplement(what, time, settings);
  let removed = 0;
  await yaml.mutateFrontmatter(app, file, (fm) => {
    removed = removeStaged(fm, staged);
  });
  if (removed > 0) {
    await returnStockUse(
      what.kind === 'vitamin' ? vitaminUse(what.vitamin, what.amount)
        : what.kind === 'pack' ? packUse(what.pack, settings)
          : stackUse(what.stack, settings)
    );
  }
  return removed;
}

/** Remove from `fm` one entry equal to each staged entry. Returns how many went. */
export function removeStaged(fm: Record<string, unknown>, staged: StagedEntry[]): number {
  let removed = 0;
  for (const { propertyKey, entry } of staged) {
    const list = fm[propertyKey];
    if (!Array.isArray(list)) continue;
    const at = list.findIndex((e) => sameEntry(e, entry));
    if (at < 0) continue;
    list.splice(at, 1);
    removed++;
  }
  return removed;
}

/** Same keys and values, in any order; times compared as written. */
function sameEntry(a: unknown, b: unknown): boolean {
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false;
  const ka = Object.keys(a as object).sort();
  const kb = Object.keys(b as object).sort();
  if (ka.join('\u0000') !== kb.join('\u0000')) return false;
  return ka.every((k) => String((a as Record<string, unknown>)[k]) === String((b as Record<string, unknown>)[k]));
}

// ── Helpers ──────────────────────────────────────────────────

/** Build the single frontmatter entry a vitamin log produces. Pure — writes nothing. */
function stageVitamin(
  vitamin: Vitamin,
  opts: { time: string; amount: number; note?: string; source?: string },
  settings: VitalLogSettings
): StagedEntry {
  const includeSource = settings.logSource !== false;
  const includeNote = settings.logNoteInFrontmatter !== false;
  const includeUnit = settings.logUnit !== false;

  if (settings.logMode === 'substances') {
    const entry: SubstanceEntry = {
      name: vitamin.displayName,
      time: opts.time,
      amount: opts.amount,
      ...(includeUnit ? { unit: vitamin.unit } : {}),
      ...(includeNote && opts.note ? { note: opts.note } : {}),
      ...(includeSource && opts.source ? { source: opts.source } : {}),
    };
    return { propertyKey: 'substances', entry };
  }

  const entry: VitaminEntry = {
    time: opts.time,
    amount: opts.amount,
    ...(includeUnit ? { unit: vitamin.unit } : {}),
    ...(includeNote && opts.note ? { note: opts.note } : {}),
    ...(includeSource ? { source: opts.source ?? 'manual' } : {}),
  };
  return { propertyKey: vitamin.propertyKey, entry };
}

/** Build every entry a pack log produces, recording unknown vitamin IDs in `skipped`. */
function stagePack(
  pack: Pack,
  settings: VitalLogSettings,
  opts: { time: string; source?: string },
  skipped: string[]
): StagedEntry[] {
  const staged: StagedEntry[] = [];
  const includeSource = settings.logSource !== false;

  if (settings.logPackEntries !== false) {
    const packEntry: PackEntry = {
      time: opts.time,
      name: pack.displayName,
      ...(includeSource ? { source: opts.source ?? 'manual' } : {}),
    };
    staged.push({ propertyKey: 'packs', entry: packEntry });
  }

  for (const item of pack.items) {
    const vitamin = settings.vitamins.find((v) => v.id === item.vitaminId);
    if (!vitamin) {
      skipped.push(item.vitaminId);
      continue;
    }
    staged.push(stageVitamin(vitamin, {
      time: opts.time,
      amount: item.amount,
      source: pack.displayName,
    }, settings));
  }

  return staged;
}

/** Build every entry one stack item produces, flattening nested packs. */
function stageStackItem(
  item: StackItemType,
  stack: Stack,
  settings: VitalLogSettings,
  opts: { time: string },
  skipped: string[]
): StagedEntry[] {
  if (item.type === 'pack') {
    const pack = settings.packs.find((p) => p.id === item.packId);
    if (!pack) {
      skipped.push(`pack:${item.packId}`);
      return [];
    }
    return stagePack(pack, settings, { time: opts.time, source: stack.displayName }, skipped);
  }

  const vitamin = settings.vitamins.find((v) => v.id === item.vitaminId);
  if (!vitamin) {
    skipped.push(`vitamin:${item.vitaminId}`);
    return [];
  }
  return [stageVitamin(vitamin, {
    time: opts.time,
    amount: item.amount ?? vitamin.defaultAmount,
    source: stack.displayName,
  }, settings)];
}
