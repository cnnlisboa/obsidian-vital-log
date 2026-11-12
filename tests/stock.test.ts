import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { App, TFile, resetNotices } from './stubs/obsidian';
import { logVitamin, logPack, logStack } from '../src/vitaminManager';
import {
  applyStockUse,
  lowStockMessage,
  packUse,
  setStockHandler,
  stackUse,
  stockLabel,
  vitaminUse,
  type StockUse,
} from '../src/stock';
import { DEFAULT_SETTINGS } from '../src/types';
import type { VitalLogSettings, Vitamin, Pack, Stack } from '../src/types';

function lib(): VitalLogSettings {
  const coq10: Vitamin = { id: 'q', displayName: 'CoQ10', propertyKey: 'CoQ10', defaultAmount: 100, unit: 'mg', stock: 90 };
  const pqq: Vitamin = { id: 'p', displayName: 'PQQ', propertyKey: 'PQQ', defaultAmount: 20, unit: 'mg' };
  const biotin: Vitamin = { id: 'b', displayName: 'Biotin', propertyKey: 'Biotin', defaultAmount: 500, unit: 'mcg', stock: 30 };
  const mito: Pack = { id: 'm', displayName: 'Mito', items: [{ vitaminId: 'q', amount: 300 }, { vitaminId: 'p', amount: 60 }] };
  const hair: Pack = { id: 'h', displayName: 'Hair', items: [{ vitaminId: 'b', amount: 500 }], stock: 60 };
  const stack: Stack = {
    id: 's', displayName: 'AM', schedulingHint: 'Morning',
    items: [{ type: 'pack', packId: 'h' }, { type: 'pack', packId: 'm' }, { type: 'vitamin', vitaminId: 'b' }],
  };
  return { ...DEFAULT_SETTINGS, vitamins: [coq10, pqq, biotin], packs: [mito, hair], stacks: [stack] };
}

describe('stock usage', () => {
  it('scales a vitamin log by amount over its default dose', () => {
    const s = lib();
    expect(vitaminUse(s.vitamins[0], 200)).toEqual([{ kind: 'vitamin', id: 'q', units: 2 }]);
    expect(vitaminUse(s.vitamins[1], 20)).toEqual([]); // no stock tracked
  });

  it('uses stockPerDose units per default dose', () => {
    const v: Vitamin = { id: 'e', displayName: 'E', propertyKey: 'E', defaultAmount: 1200, unit: 'IU', stock: 180, stockPerDose: 3 };
    expect(vitaminUse(v, 1200)).toEqual([{ kind: 'vitamin', id: 'e', units: 3 }]);
  });

  it('a pack with its own stock uses only the pack', () => {
    const s = lib();
    expect(packUse(s.packs[1], s)).toEqual([{ kind: 'pack', id: 'h', units: 1 }]);
  });

  it('a pack without stock draws from its vitamins', () => {
    const s = lib();
    expect(packUse(s.packs[0], s)).toEqual([{ kind: 'vitamin', id: 'q', units: 3 }]);
  });

  it('a stack adds up packs and vitamins', () => {
    const s = lib();
    expect(stackUse(s.stacks[0], s)).toEqual([
      { kind: 'pack', id: 'h', units: 1 },
      { kind: 'vitamin', id: 'q', units: 3 },
      { kind: 'vitamin', id: 'b', units: 1 },
    ]);
  });
});

describe('applyStockUse', () => {
  it('subtracts, merges repeats, and never goes below zero', () => {
    const s = lib();
    const changes = applyStockUse(s, [
      { kind: 'vitamin', id: 'q', units: 3 },
      { kind: 'vitamin', id: 'q', units: 3 },
      { kind: 'pack', id: 'h', units: 100 },
    ]);
    expect(s.vitamins[0].stock).toBe(84);
    expect(s.packs[1].stock).toBe(0);
    expect(changes).toEqual([
      { name: 'CoQ10', left: 84, low: false },
      { name: 'Hair', left: 0, low: true },
    ]);
  });

  it('flags low stock at 7 doses by default, or at lowStockAt', () => {
    const s = lib();
    s.vitamins[2].stock = 8;
    expect(applyStockUse(s, [{ kind: 'vitamin', id: 'b', units: 1 }])[0].low).toBe(true);
    s.vitamins[2].lowStockAt = 2;
    expect(applyStockUse(s, [{ kind: 'vitamin', id: 'b', units: 1 }])[0].low).toBe(false);
  });

  it('skips items without stock', () => {
    const s = lib();
    expect(applyStockUse(s, [{ kind: 'vitamin', id: 'p', units: 1 }])).toEqual([]);
    expect(s.vitamins[1].stock).toBeUndefined();
  });
});

describe('messages', () => {
  it('words low and empty stock', () => {
    expect(lowStockMessage([{ name: 'A', left: 0, low: true }, { name: 'B', left: 4, low: true }, { name: 'C', left: 50, low: false }]))
      .toBe('Vital Log: Restock soon — A is out, B: 4 left.');
    expect(lowStockMessage([{ name: 'C', left: 50, low: false }])).toBeNull();
  });

  it('labels stock with doses when a dose is several units', () => {
    expect(stockLabel({ stock: 60 })).toBe('60 left');
    expect(stockLabel({ stock: 100, stockPerDose: 3 })).toBe('100 left (33 doses)');
    expect(stockLabel({})).toBeNull();
  });
});

describe('logging reports stock use', () => {
  let reported: StockUse[][] = [];
  beforeEach(() => {
    resetNotices();
    reported = [];
    setStockHandler((uses) => { reported.push(uses); });
  });
  afterEach(() => setStockHandler(null));

  function file(): { app: App; file: TFile } {
    const app = new App();
    return { app, file: app.vault.create('Daily/2026-11-12.md', '---\n---\n') };
  }

  it('after a vitamin, pack and stack log', async () => {
    const s = lib();
    const { app, file: f } = file();
    await logVitamin(app as never, f as never, s.vitamins[0], { time: '08:00', amount: 100 }, s);
    await logPack(app as never, f as never, s.packs[1], s, { time: '08:00' });
    await logStack(app as never, f as never, s.stacks[0], s, { time: '08:00' });
    expect(reported).toEqual([
      [{ kind: 'vitamin', id: 'q', units: 1 }],
      [{ kind: 'pack', id: 'h', units: 1 }],
      stackUse(s.stacks[0], s),
    ]);
  });
});
