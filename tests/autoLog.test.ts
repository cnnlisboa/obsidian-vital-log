import { describe, expect, it } from 'vitest';
import { planAutoLog, autoLogState } from '../src/autoLog';
import { removeStaged, stageSupplement } from '../src/vitaminManager';
import { DEFAULT_SETTINGS } from '../src/types';
import type { ScheduleItem, VitalLogSettings, Vitamin, Pack } from '../src/types';

const daily: ScheduleItem = { id: 'i1', kind: 'pack', refId: 'p1', frequency: { type: 'daily' }, times: ['08:00'], autoLog: true };

describe('planAutoLog', () => {
  it('waits for the reminder time, then logs at it', () => {
    expect(planAutoLog(daily, { date: '2026-11-24' }, '2026-11-25', '07:59')).toEqual({ writes: [], through: null });
    expect(planAutoLog(daily, { date: '2026-11-24' }, '2026-11-25', '09:10')).toEqual({
      writes: [{ date: '2026-11-25', time: '08:00' }],
      through: '2026-11-25',
    });
  });

  it('starts today the first time, with no back-logs', () => {
    expect(planAutoLog(daily, undefined, '2026-11-25', '09:00').writes).toEqual([{ date: '2026-11-25', time: '08:00' }]);
  });

  it('catches up missed days, a week back at most', () => {
    const plan = planAutoLog(daily, { date: '2026-11-01' }, '2026-11-25', '07:00');
    expect(plan.writes.map((w) => w.date)).toEqual([
      '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24',
    ]);
    expect(plan.through).toBe('2026-11-24');
  });

  it('logs an item without a time now, and only today', () => {
    const untimed = { ...daily, times: undefined };
    expect(planAutoLog(untimed, { date: '2026-11-22' }, '2026-11-25', '06:12')).toEqual({
      writes: [{ date: '2026-11-25', time: '06:12' }],
      through: '2026-11-25',
    });
  });

  it('skips days it isn\'t due and does nothing twice', () => {
    const mondays: ScheduleItem = { ...daily, frequency: { type: 'weekdays', days: [1] } };
    // 2026-11-25 is a Wednesday; the 23rd a Monday.
    expect(planAutoLog(mondays, { date: '2026-11-22' }, '2026-11-25', '10:00').writes).toEqual([{ date: '2026-11-23', time: '08:00' }]);
    expect(planAutoLog(daily, { date: '2026-11-25', time: '08:00' }, '2026-11-25', '10:00')).toEqual({ writes: [], through: null });
  });

  it('counts a late-night now as after the reminder', () => {
    const plan = planAutoLog({ ...daily, times: ['23:00'] }, { date: '2026-11-24' }, '2026-11-25', '01:30', 180);
    expect(plan.writes).toEqual([{ date: '2026-11-25', time: '23:00' }]);
  });
});

describe('autoLogState', () => {
  const settings = (rec?: object) => ({ ...DEFAULT_SETTINGS, plannedLogs: { trackerGoals: [], schedule: [daily], autoLogged: rec ? { i1: rec } : {} } }) as VitalLogSettings;
  it('reads the record for today', () => {
    expect(autoLogState(settings(), daily, '2026-11-25')).toEqual({ state: 'pending', at: '08:00' });
    expect(autoLogState(settings({ date: '2026-11-25', time: '08:00' }), daily, '2026-11-25')).toEqual({ state: 'logged', time: '08:00' });
    expect(autoLogState(settings({ date: '2026-11-25', skipped: true }), daily, '2026-11-25')).toEqual({ state: 'skipped' });
    expect(autoLogState(settings({ date: '2026-11-25' }), daily, '2026-11-25')).toEqual({ state: 'handled' });
  });
});

describe('removeStaged', () => {
  const vitD: Vitamin = { id: 'v1', displayName: 'Vitamin D', propertyKey: 'vitaminD', defaultAmount: 2000, unit: 'IU' } as Vitamin;
  const pack: Pack = { id: 'p1', displayName: 'Morning Pack', items: [{ vitaminId: 'v1', amount: 2000 }] } as Pack;
  const s = { ...DEFAULT_SETTINGS, logMode: 'substances', vitamins: [vitD], packs: [pack] } as VitalLogSettings;

  it('takes back exactly one log, leaving others at other times', () => {
    const at8 = stageSupplement({ kind: 'pack', pack, source: 'auto' }, '08:00', s);
    const fm: Record<string, unknown> = {
      packs: [{ time: '08:00', name: 'Morning Pack', source: 'auto' }, { time: '20:00', name: 'Morning Pack', source: 'manual' }],
      substances: [
        { name: 'Vitamin D', time: '20:00', amount: 2000, unit: 'IU', source: 'Morning Pack' },
        { unit: 'IU', amount: 2000, time: '08:00', name: 'Vitamin D', source: 'Morning Pack' },
      ],
    };
    expect(removeStaged(fm, at8)).toBe(2);
    expect(fm.packs).toEqual([{ time: '20:00', name: 'Morning Pack', source: 'manual' }]);
    expect(fm.substances).toEqual([{ name: 'Vitamin D', time: '20:00', amount: 2000, unit: 'IU', source: 'Morning Pack' }]);
  });
});
