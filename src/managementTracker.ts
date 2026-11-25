// ============================================================
// Vital Log — Management Tracker integration
// Reads Time Tracker sessions through Management Tracker's public API
// (`app.plugins.plugins['management-tracker'].api`, version >= 1).
// Optional: every caller copes with the plugin being absent, disabled,
// or loaded after Vital Log.
// ============================================================

import type { App } from 'obsidian';

/** One session as Management Tracker's API returns it. */
export interface MtSession {
  id: string;
  date: string;
  /** `HH:mm` start. */
  time: string;
  /** `HH:mm` end; may pass midnight (`24:10`). */
  end: string;
  minutes: number;
  title: string;
  /** What it counts toward, readable; empty when nothing. */
  countsToward: string;
  targetPath: string | null;
  area: string;
  tags: string[];
  note: string;
  source: 'timer' | 'koreader';
  notePath: string;
  line: number;
}

export interface ManagementApi {
  version: number;
  sessionsOn(date: string): MtSession[];
  minutesOn(date: string): number;
  onChange(callback: () => void): () => void;
  editSession(notePath: string, id: string): boolean;
  openTimeTracker(where?: 'tab' | 'sidebar'): void;
  /** When a day ends, `HH:mm` (since version 2). */
  dayEndsAt?(): string;
  /** Today as Management Tracker counts days, `YYYY-MM-DD` (since version 2). */
  today?(): string;
  /** Since version 3. */
  timerReady?(): boolean;
  /** What a session can count toward (since version 3). */
  startChoices?(): MtStartChoice[];
  /** Log a finished session (since version 7). */
  logSession?(opts: { choice?: string; title?: string; start: number; end: number; eventId?: string; sessionId?: string }): Promise<MtResult>;
  /** Take back a session logged with logSession (since version 8). */
  removeSession?(opts: { sessionId: string; eventId?: string }): Promise<MtResult>;
}

export interface MtStartChoice {
  id: string;
  /** Effort, Goal, Habit, Pillar, a recent setup… */
  kind: string;
  label: string;
  detail: string;
  area: string;
  toward: string;
}

export interface MtResult {
  ok: boolean;
  error?: string;
  duplicate?: boolean;
}

/** Version that can both log and take back sessions. */
export const MT_SESSIONS_VERSION = 8;

/** The API when it can log and remove sessions, else null. */
export function getSessionApi(app: App): ManagementApi | null {
  const api = getManagementApi(app);
  if (!api || api.version < MT_SESSIONS_VERSION) return null;
  if (typeof api.logSession !== 'function' || typeof api.removeSession !== 'function' || typeof api.startChoices !== 'function') return null;
  return api;
}

/**
 * The session a minutes reading stands for: it ends at the reading's time
 * on the note's day (or the morning after, for a time before the day end)
 * and lasts its minutes. Epoch milliseconds; null for no minutes or a bad time.
 */
export function sessionWindow(noteDate: string, time: string, minutes: number, dayEndMinutes: number): { start: number; end: number } | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(noteDate);
  const t = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!d || !t || !(minutes > 0)) return null;
  const clock = Number(t[1]) * 60 + Number(t[2]);
  const nextDay = dayEndMinutes > 0 && clock < dayEndMinutes ? 1 : 0;
  const end = new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]) + nextDay, Number(t[1]), Number(t[2])).getTime();
  return { start: end - Math.round(minutes * 60_000), end };
}

/**
 * A reading's session id: the same reading always gets the same id, so a
 * retry is logged once and deleting the reading can find the session.
 */
export function sessionIdFor(trackerId: string, noteDate: string, time: string, minutes: number): string {
  const tracker = trackerId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'tracker';
  return `vl-${tracker}-${noteDate}-${time.replace(/[^0-9]/g, '')}-${String(minutes).replace(/[^0-9]/g, '-')}`;
}

/** The API when Management Tracker is enabled and new enough, else null. */
export function getManagementApi(app: App): ManagementApi | null {
  const plugins = (app as unknown as { plugins?: { plugins?: Record<string, { api?: unknown }> } }).plugins;
  const api = plugins?.plugins?.['management-tracker']?.api as Partial<ManagementApi> | undefined;
  if (!api || typeof api.version !== 'number' || api.version < 1) return null;
  if (typeof api.sessionsOn !== 'function' || typeof api.onChange !== 'function') return null;
  return api as ManagementApi;
}

/** "1h 25m", "45m", "2h". */
export function formatMinutes(minutes: number): string {
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
