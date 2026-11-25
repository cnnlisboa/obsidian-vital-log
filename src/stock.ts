// ============================================================
// Vital Log — Stock
// Optional per-vitamin and per-pack stock counts (capsules, scoops…)
// that go down each time something is logged.
//
// A pack with its own stock is one physical product (a capsule holding
// several substances), so logging it uses only the pack's stock. A pack
// without stock draws from the stock of each vitamin inside it instead.
// ============================================================

import type { Pack, Stack, Vitamin, VitalLogSettings } from './types';

/** Doses left at which a low-stock warning starts, when none is set. */
export const DEFAULT_LOW_STOCK_DOSES = 7;

export interface StockUse {
  kind: 'vitamin' | 'pack';
  id: string;
  units: number;
}

export interface StockChange {
  name: string;
  left: number;
  low: boolean;
}

type Stocked = Pick<Vitamin, 'stock' | 'stockPerDose' | 'lowStockAt'>;

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export function hasStock(item: Stocked): boolean {
  return typeof item.stock === 'number' && isFinite(item.stock);
}

export function perDose(item: Stocked): number {
  return item.stockPerDose && item.stockPerDose > 0 ? item.stockPerDose : 1;
}

/** The stock count at or below which `item` is low. */
export function lowStockThreshold(item: Stocked): number {
  return typeof item.lowStockAt === 'number' && item.lowStockAt >= 0
    ? item.lowStockAt
    : DEFAULT_LOW_STOCK_DOSES * perDose(item);
}

/** Units a vitamin logged on its own uses, scaled by amount over its default dose. */
export function vitaminUse(vitamin: Vitamin, amount: number): StockUse[] {
  if (!hasStock(vitamin) || !(vitamin.defaultAmount > 0) || !(amount > 0)) return [];
  return [{ kind: 'vitamin', id: vitamin.id, units: round((amount / vitamin.defaultAmount) * perDose(vitamin)) }];
}

export function packUse(pack: Pack, settings: VitalLogSettings): StockUse[] {
  if (hasStock(pack)) return [{ kind: 'pack', id: pack.id, units: perDose(pack) }];
  const uses: StockUse[] = [];
  for (const item of pack.items) {
    const vitamin = settings.vitamins.find((v) => v.id === item.vitaminId);
    if (vitamin) uses.push(...vitaminUse(vitamin, item.amount));
  }
  return uses;
}

export function stackUse(stack: Stack, settings: VitalLogSettings): StockUse[] {
  const uses: StockUse[] = [];
  for (const item of stack.items) {
    if (item.type === 'pack') {
      const pack = settings.packs.find((p) => p.id === item.packId);
      if (pack) uses.push(...packUse(pack, settings));
    } else {
      const vitamin = settings.vitamins.find((v) => v.id === item.vitaminId);
      if (vitamin) uses.push(...vitaminUse(vitamin, item.amount ?? vitamin.defaultAmount));
    }
  }
  return uses;
}

/**
 * Subtract `uses` from the stock in `settings` (looked up by id, so uses built
 * from an edited copy of a pack still land on the saved one). Stock never
 * drops below zero. Returns one change per item whose stock moved.
 */
export function applyStockUse(settings: VitalLogSettings, uses: StockUse[]): StockChange[] {
  const totals = new Map<string, StockUse>();
  for (const use of uses) {
    const key = `${use.kind}:${use.id}`;
    const prev = totals.get(key);
    totals.set(key, prev ? { ...prev, units: prev.units + use.units } : { ...use });
  }

  const changes: StockChange[] = [];
  for (const use of totals.values()) {
    const item: (Stocked & { displayName: string }) | undefined = use.kind === 'pack'
      ? settings.packs.find((p) => p.id === use.id)
      : settings.vitamins.find((v) => v.id === use.id);
    // Negative units put stock back (a log taken back).
    if (!item || !hasStock(item) || use.units === 0) continue;
    item.stock = Math.max(0, round((item.stock as number) - use.units));
    changes.push({ name: item.displayName, left: item.stock, low: item.stock <= lowStockThreshold(item) });
  }
  return changes;
}

/** The warning to show after a log, or null when nothing is low. */
export function lowStockMessage(changes: StockChange[]): string | null {
  const low = changes.filter((c) => c.low);
  if (low.length === 0) return null;
  const parts = low.map((c) => (c.left <= 0 ? `${c.name} is out` : `${c.name}: ${c.left} left`));
  return `Vital Log: Restock soon — ${parts.join(', ')}.`;
}

/** Short stock label for lists, e.g. "42 left". */
export function stockLabel(item: Stocked): string | null {
  if (!hasStock(item)) return null;
  const left = item.stock as number;
  const doses = Math.floor(left / perDose(item));
  const doseText = perDose(item) === 1 ? '' : ` (${doses} dose${doses === 1 ? '' : 's'})`;
  return `${left} left${doseText}`;
}

// ── Hook ─────────────────────────────────────────────────────
// vitaminManager reports what a log used; the plugin applies it to its
// saved settings. Logs come from many callers, some holding copies of the
// settings, so this keeps the bookkeeping in one place.

type StockHandler = (uses: StockUse[]) => void | Promise<void>;
let handler: StockHandler | null = null;

export function setStockHandler(h: StockHandler | null): void {
  handler = h;
}

export async function reportStockUse(uses: StockUse[]): Promise<void> {
  if (!handler || uses.length === 0) return;
  try {
    await handler(uses);
  } catch (err) {
    console.error('Vital Log stock update:', err);
  }
}

/** Put back what a log taken back had used. */
export async function returnStockUse(uses: StockUse[]): Promise<void> {
  await reportStockUse(uses.map((u) => ({ ...u, units: -u.units })));
}
