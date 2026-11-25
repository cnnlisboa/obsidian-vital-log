// ============================================================
// Vital Log — planned supplements that log themselves
//
// A vitamin, pack or stack in the schedule with `autoLog` is taken unless
// said otherwise: on each day it's due it is logged at its first reminder
// time (or, with none, when Obsidian first runs that day), unless it was
// already logged. Skipping a day — before or after it was logged — takes
// it back. Days missed while Obsidian was closed are caught up, a week
// back at most, for items with a reminder time.
//
// What was done is kept per item in settings.plannedLogs.autoLogged, so
// a log taken back by hand isn't written again.
// ============================================================

import type { App } from 'obsidian';
import type { AutoLogRecord, ScheduleItem, VitalLogSettings } from './types';
import { dateRange, frequencyMatches, fromISODate, shiftDaysISO } from './planManager';
import { dayEndMinutes, dayMinutes, logicalTodayISO } from './dayBoundary';
import { getDailyNoteIfExists, resolveDailyNote } from './dailyNoteResolver';
import { readAllFrontmatter } from './yamlManager';
import { isScheduleItemDone } from './statsEngine';
import { logPack, logStack, logVitamin, unlogSupplement, type LoggedSupplement } from './vitaminManager';

/** How many days back a missed auto-log is caught up. */
export const AUTO_LOG_CATCH_UP_DAYS = 7;

export function canAutoLog(item: ScheduleItem): boolean {
  return item.kind === 'vitamin' || item.kind === 'pack' || item.kind === 'stack';
}

export interface AutoLogPlan {
  /** Days to log on, oldest first, with the time to log at. */
  writes: { date: string; time: string }[];
  /** The last day fully handled once the writes are done, or null when nothing moved on. */
  through: string | null;
}

function clockMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/**
 * What auto-logging should do now for one item. Pure.
 * @param today the logical day, `YYYY-MM-DD`
 * @param now   the clock, `HH:mm`
 * @param dayEnd minutes after midnight the day ends (late-night times count as after 24:00)
 */
export function planAutoLog(
  item: ScheduleItem,
  record: AutoLogRecord | undefined,
  today: string,
  now: string,
  dayEnd = 0
): AutoLogPlan {
  const earliest = shiftDaysISO(today, -AUTO_LOG_CATCH_UP_DAYS);
  // First time on: start today, not with a week of back-logs.
  let start = record ? shiftDaysISO(record.date, 1) : today;
  if (start < earliest) start = earliest;
  if (start > today) return { writes: [], through: null };

  const at = item.times?.length ? [...item.times].sort((a, b) => dayMinutes(clockMinutes(a), dayEnd) - dayMinutes(clockMinutes(b), dayEnd))[0] : null;
  const writes: AutoLogPlan['writes'] = [];
  let through: string | null = null;
  for (const date of dateRange(start, today)) {
    if (frequencyMatches(item.frequency, fromISODate(date))) {
      if (date === today) {
        if (at && dayMinutes(clockMinutes(now), dayEnd) < dayMinutes(clockMinutes(at), dayEnd)) break;
        writes.push({ date, time: at ?? now });
      } else if (at) {
        writes.push({ date, time: at });
      }
    }
    through = date;
  }
  return { writes, through };
}

/** The supplement a schedule item logs, as configured now. */
export function supplementFor(settings: VitalLogSettings, item: ScheduleItem): LoggedSupplement | null {
  switch (item.kind) {
    case 'vitamin': {
      const vitamin = settings.vitamins.find((v) => v.id === item.refId);
      return vitamin ? { kind: 'vitamin', vitamin, amount: vitamin.defaultAmount, source: 'auto' } : null;
    }
    case 'pack': {
      const pack = settings.packs.find((p) => p.id === item.refId);
      return pack ? { kind: 'pack', pack, source: 'auto' } : null;
    }
    case 'stack': {
      const stack = settings.stacks.find((s) => s.id === item.refId);
      return stack ? { kind: 'stack', stack } : null;
    }
    default:
      return null;
  }
}

function records(settings: VitalLogSettings): Record<string, AutoLogRecord> {
  return (settings.plannedLogs.autoLogged ??= {});
}

function nowHHmm(d = new Date()): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

let running = false;

/**
 * Log every auto-log item that's due and not yet handled. Safe to call
 * often; returns true when anything was written or recorded.
 */
export async function runAutoLog(app: App, settings: VitalLogSettings, save: () => Promise<void>, dayEnd = dayEndMinutes()): Promise<boolean> {
  if (running) return false;
  running = true;
  let changed = false;
  try {
    const today = logicalTodayISO();
    const now = nowHHmm();
    for (const item of settings.plannedLogs.schedule) {
      if (!item.autoLog || !canAutoLog(item)) continue;
      const what = supplementFor(settings, item);
      if (!what) continue;
      const plan = planAutoLog(item, records(settings)[item.id], today, now, dayEnd);
      for (const { date, time } of plan.writes) {
        const file = await resolveDailyNote(app, settings, fromISODate(date));
        if (!file) return changed;
        const fm = await readAllFrontmatter(app, file);
        if (isScheduleItemDone(fm, settings, item)) {
          records(settings)[item.id] = { date };
        } else {
          await logSupplement(app, file, what, time, settings);
          records(settings)[item.id] = { date, time };
        }
        changed = true;
      }
      const rec = records(settings)[item.id];
      if (plan.through && (!rec || rec.date < plan.through)) {
        records(settings)[item.id] = { date: plan.through };
        changed = true;
      }
    }
    if (changed) await save();
  } catch (err) {
    console.error('Vital Log auto-log:', err);
  } finally {
    running = false;
  }
  return changed;
}

async function logSupplement(app: App, file: import('obsidian').TFile, what: LoggedSupplement, time: string, settings: VitalLogSettings): Promise<void> {
  switch (what.kind) {
    case 'vitamin':
      return logVitamin(app, file, what.vitamin, { time, amount: what.amount, source: what.source }, settings);
    case 'pack':
      return logPack(app, file, what.pack, settings, { time, source: what.source });
    case 'stack':
      return logStack(app, file, what.stack, settings, { time });
  }
}

/** How an auto-log item stands today, for the dashboard. */
export type AutoLogState =
  | { state: 'pending'; at: string | null }
  | { state: 'logged'; time: string }
  | { state: 'skipped' }
  | { state: 'handled' };

export function autoLogState(settings: VitalLogSettings, item: ScheduleItem, today: string): AutoLogState {
  const rec = settings.plannedLogs.autoLogged?.[item.id];
  if (!rec || rec.date < today) return { state: 'pending', at: item.times?.length ? [...item.times].sort()[0] : null };
  if (rec.skipped) return { state: 'skipped' };
  return rec.time ? { state: 'logged', time: rec.time } : { state: 'handled' };
}

/**
 * Skip an auto-log item today: take back what it logged, if anything, and
 * don't log it again today. Logging it by hand afterwards still works.
 */
export async function skipAutoLogToday(app: App, settings: VitalLogSettings, item: ScheduleItem, save: () => Promise<void>): Promise<void> {
  const today = logicalTodayISO();
  const rec = settings.plannedLogs.autoLogged?.[item.id];
  if (rec?.date === today && rec.time && !rec.skipped) {
    const what = supplementFor(settings, item);
    const file = getDailyNoteIfExists(app, settings, fromISODate(today));
    if (what && file) await unlogSupplement(app, file, what, rec.time, settings);
  }
  records(settings)[item.id] = { date: today, skipped: true };
  await save();
}

/** Undo a skip today: back to pending, so the next run logs it (now, if its time has passed). */
export async function unskipAutoLogToday(settings: VitalLogSettings, item: ScheduleItem, save: () => Promise<void>): Promise<void> {
  const today = logicalTodayISO();
  const rec = settings.plannedLogs.autoLogged?.[item.id];
  if (rec?.date === today && rec.skipped) {
    records(settings)[item.id] = { date: shiftDaysISO(today, -1) };
    await save();
  }
}
