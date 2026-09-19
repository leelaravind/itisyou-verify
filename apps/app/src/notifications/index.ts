/**
 * Transactional notifications: templates, at-most-once sending, and alert-storm grouping.
 *
 * Two invariants hold across every file here. A notification key sends once, ever. And we
 * record that a sending service accepted a message — never that anyone received it.
 */
export * from './templates';
export * from './send';
export * from './grouping';
export * from './telegram';
