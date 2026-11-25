// ============================================================
// Vital Log — trackers linked to Management Tracker
//
// A minutes tracker can be linked to one of Management Tracker's start
// choices (an effort, habit, goal, area…). Each reading logged is then
// also a Time Tracker session counting toward it — 10 minutes of
// meditation at 08:30 is a session from 08:20 to 08:30 — and deleting
// or editing the reading takes that session back. Sessions are keyed by
// the reading (sessionIdFor), so nothing extra is stored in the note.
// ============================================================

import { Notice, type App, type TFile } from 'obsidian';
import type { Metric, VitalLogSettings } from './types';
import { findMetric } from './types';
import { getSessionApi, sessionIdFor, sessionWindow } from './managementTracker';
import { noteDateForTemplate } from './dailyNoteResolver';
import { dayEndMinutes, logicalDay } from './dayBoundary';
import { toISODate } from './planManager';

/** The live tracker when it is a linked minutes tracker; copies in custom modals may be stale. */
function linked(settings: VitalLogSettings, tracker: Metric): Metric | null {
  const live = findMetric(settings, tracker.id) ?? tracker;
  return live.trackerType === 'minutes' && live.mtLink?.choice ? live : null;
}

function noteDate(settings: VitalLogSettings, file: TFile): string {
  return toISODate(noteDateForTemplate(file.path, settings.dailyNotePath) ?? logicalDay());
}

/** Log a minutes reading in Management Tracker, when its tracker is linked. */
export async function pushReading(
  app: App,
  settings: VitalLogSettings,
  tracker: Metric,
  file: TFile,
  reading: { time: string; value: number }
): Promise<void> {
  const t = linked(settings, tracker);
  if (!t?.mtLink) return;
  const api = getSessionApi(app);
  if (!api?.logSession) {
    new Notice(`Vital Log: ${t.displayName} wasn't logged in Management Tracker — Management Tracker is off or needs updating.`);
    return;
  }
  const date = noteDate(settings, file);
  const window = sessionWindow(date, reading.time, reading.value, dayEndMinutes());
  if (!window) return;
  const sessionId = sessionIdFor(t.id, date, reading.time, reading.value);
  const result = await api.logSession({
    choice: t.mtLink.choice,
    title: t.displayName,
    start: window.start,
    end: Math.min(window.end, Date.now()),
    sessionId,
    eventId: sessionId,
  });
  if (!result.ok) new Notice(`Vital Log: Management Tracker didn't log ${t.displayName}: ${result.error ?? 'unknown error'}`);
}

/** Take back the session a deleted (or edited) minutes reading logged. */
export async function pullReading(
  app: App,
  settings: VitalLogSettings,
  tracker: Metric,
  file: TFile,
  reading: { time: string; value: number }
): Promise<void> {
  const t = linked(settings, tracker);
  if (!t) return;
  const api = getSessionApi(app);
  if (!api?.removeSession) return;
  const sessionId = sessionIdFor(t.id, noteDate(settings, file), reading.time, reading.value);
  // Not found is fine: the reading may predate the link.
  await api.removeSession({ sessionId });
}

/** A frontmatter entry of a linked tracker's list, read as a reading. */
export function readingOf(tracker: Metric, entry: unknown): { time: string; value: number } | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const e = entry as Record<string, unknown>;
  const value = e[tracker.valueName];
  return typeof e.time === 'string' && typeof value === 'number' ? { time: e.time, value } : null;
}

/** The linked minutes tracker writing to `propertyKey`, if any. */
export function linkedTrackerFor(settings: VitalLogSettings, propertyKey: string): Metric | null {
  const t = settings.metrics.find((m) => m.propertyKey === propertyKey);
  return t ? linked(settings, t) : null;
}
