/**
 * Shared synthetic fixtures. Import these rather than hand-rolling evidence objects — they
 * are typed against the frozen contract, so a contract change breaks the fixtures once
 * instead of breaking every suite separately.
 *
 * Nothing here is real: no real customer record, no real credential, no real address.
 */
export * from './time.js';
export * from './evidence.js';
export * from './rules.js';
export * from './results.js';
