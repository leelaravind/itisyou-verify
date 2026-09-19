/**
 * `@verify/connectors` advertising adapters.
 *
 * Imported by relative path (`.../ads`) rather than through the package root, because the
 * package root belongs to the evidence connectors (A04) and advertising has nothing to do
 * with evidence. Nothing in this subtree may ever be reachable from the verification path.
 */
export * from './types';
export * from './facts';
export * from './manual';
export * from './reddit-planner';
