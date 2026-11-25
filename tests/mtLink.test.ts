import { describe, expect, it } from 'vitest';
import { sessionIdFor, sessionWindow } from '../src/managementTracker';

describe('sessionWindow', () => {
  it('ends at the reading time and lasts its minutes', () => {
    const w = sessionWindow('2026-11-25', '08:30', 10, 0)!;
    expect(new Date(w.end)).toEqual(new Date(2026, 10, 25, 8, 30));
    expect(new Date(w.start)).toEqual(new Date(2026, 10, 25, 8, 20));
  });

  it('puts a time before the day end on the morning after', () => {
    const w = sessionWindow('2026-11-25', '01:15', 30, 180)!;
    expect(new Date(w.end)).toEqual(new Date(2026, 10, 26, 1, 15));
  });

  it('rejects no minutes and bad times', () => {
    expect(sessionWindow('2026-11-25', '08:30', 0, 0)).toBeNull();
    expect(sessionWindow('2026-11-25', 'later', 5, 0)).toBeNull();
    expect(sessionWindow('nope', '08:30', 5, 0)).toBeNull();
  });
});

describe('sessionIdFor', () => {
  it('is stable per reading and safe for block ids', () => {
    const id = sessionIdFor('3f2a-11ee-9c', '2026-11-25', '08:30', 10);
    expect(id).toBe(sessionIdFor('3f2a-11ee-9c', '2026-11-25', '08:30', 10));
    expect(id).toMatch(/^[A-Za-z0-9-]+$/);
    expect(id).not.toBe(sessionIdFor('3f2a-11ee-9c', '2026-11-25', '08:30', 15));
  });
});
