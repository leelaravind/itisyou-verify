/**
 * Growth: campaign approval binding, campaign lifecycle, automatic stops, visit analytics.
 *
 * Nothing in this directory spends money, creates a campaign or calls an advertising
 * platform. It produces the packet an owner approves and the machinery that keeps an
 * approved campaign honest afterwards.
 */
export * from './approval';
export * from './port';
export * from './memory';
export * from './visits';
export * from './launchMetrics';
export * from './sync';
export * from './lifecycle';
export * from './stops';
export * from './analytics';
