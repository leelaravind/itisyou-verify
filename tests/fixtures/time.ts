/**
 * Fixed instants for deterministic tests. Nothing in the domain reads a clock, so every test
 * pins its own time and gets the same answer on every machine, forever.
 *
 * Synthetic only. No real customer record, no real token, no real address.
 */

/** The business event: an enquiry arrived. All windows are measured from here. */
export const T_EVENT = new Date('2026-03-01T12:00:00.000Z');

/** Default completion deadline: ten minutes after the enquiry (LIMITS.DEFAULT_DEADLINE_SECONDS). */
export const T_DEADLINE = new Date('2026-03-01T12:10:00.000Z');

/** A wall clock comfortably inside the completion window. */
export const T_INSIDE_WINDOW = new Date('2026-03-01T12:02:00.000Z');

/** A wall clock exactly on the deadline. */
export const T_AT_DEADLINE = new Date('2026-03-01T12:10:00.000Z');

/** A wall clock after the deadline. */
export const T_AFTER_DEADLINE = new Date('2026-03-01T12:20:00.000Z');

/** Seconds offset from an instant, as an ISO-8601 UTC string. */
export function isoAfter(base: Date, seconds: number): string {
  return new Date(base.getTime() + seconds * 1000).toISOString();
}

/** Seconds offset from an instant, as a Date. */
export function dateAfter(base: Date, seconds: number): Date {
  return new Date(base.getTime() + seconds * 1000);
}
