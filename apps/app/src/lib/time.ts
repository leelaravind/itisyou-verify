/**
 * Time. UTC everywhere, ISO-8601 strings in storage, `Date` in memory.
 *
 * There is no local-time function in this module and there must never be one: a
 * deadline computed in Europe/London would silently move twice a year.
 */

/** Matches an ISO-8601 instant with an explicit UTC designator or numeric offset. */
const ISO_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export type Instant = Date | string;

/** Current instant as an ISO-8601 UTC string, millisecond precision. */
export function nowIso(now: Instant = new Date()): string {
  return toIso(now);
}

/** Normalise to an ISO-8601 UTC string. Always ends in `Z`. */
export function toIso(value: Instant | number): string {
  const date =
    value instanceof Date
      ? value
      : typeof value === 'number'
        ? new Date(value)
        : parseIso(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError('toIso received an invalid date');
  }
  return date.toISOString();
}

/** Parse an ISO-8601 instant. Throws on anything ambiguous, including a bare date. */
export function parseIso(value: string): Date {
  if (typeof value !== 'string' || !ISO_RE.test(value)) {
    throw new TypeError(`not an ISO-8601 UTC instant: ${String(value)}`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`not an ISO-8601 UTC instant: ${value}`);
  }
  return date;
}

function asDate(value: Instant): Date {
  return value instanceof Date ? value : parseIso(value);
}

/** `value` shifted by `seconds` (which may be negative), as a Date. */
export function addSeconds(value: Instant, seconds: number): Date {
  if (!Number.isFinite(seconds)) throw new TypeError('addSeconds requires a finite number');
  return new Date(asDate(value).getTime() + Math.trunc(seconds * 1000));
}

/** `value` shifted by `seconds`, as an ISO-8601 UTC string. */
export function addSecondsIso(value: Instant, seconds: number): string {
  return toIso(addSeconds(value, seconds));
}

/** Strictly before. Equal instants return false. */
export function isBefore(a: Instant, b: Instant): boolean {
  return asDate(a).getTime() < asDate(b).getTime();
}

/** Whole seconds from `a` to `b`. Negative when `b` precedes `a`. */
export function secondsBetween(a: Instant, b: Instant): number {
  return Math.trunc((asDate(b).getTime() - asDate(a).getTime()) / 1000);
}

/** True when `deadline` is at or before `now`. */
export function hasElapsed(deadline: Instant, now: Instant = new Date()): boolean {
  return asDate(deadline).getTime() <= asDate(now).getTime();
}

/** Clamp to whole seconds, rounding up, with a floor of zero. Used for Retry-After. */
export function retryAfterSeconds(from: Instant, until: Instant): number {
  const ms = asDate(until).getTime() - asDate(from).getTime();
  return ms <= 0 ? 0 : Math.ceil(ms / 1000);
}
