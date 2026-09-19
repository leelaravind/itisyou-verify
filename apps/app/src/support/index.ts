/**
 * Customer support: the public form, the case record, deterministic triage, and
 * rules-based FAQ matching.
 *
 * Nothing in this directory calls a model, and nothing in it answers a customer with a
 * sentence it made up. It either returns one of A01's published answers verbatim, or it
 * says a person will read the message.
 */
export * from './port';
export * from './cases';
export * from './triage';
export * from './faq';
export * from './form';
export { InMemorySupportData, InMemoryRateLimiter, RecordingTransport } from './memory';
export type { MemoryRow, MemoryExportSection, RecordedMessage } from './memory';
