/**
 * The owner's stop switches.
 *
 * Five things the owner can turn off in a hurry: advertising, new orders, expensive
 * verification, the optional chatbot, and an individual connection. Each is a settings row,
 * each writes an audit row, and each says honestly what it did and did not stop.
 *
 * ## The invariant this file exists to protect
 *
 * **Cancelling and getting help never stop working.** Whatever is paused, a customer can
 * still cancel their plan and still reach support. A pause switch that also silences the
 * cancel button turns an operational decision into a consumer-rights problem, and it is the
 * exact failure a hurried "pause everything" button produces. {@link PROTECTED_PATHS} is
 * therefore not a convention — it is consulted by {@link isPathSuspended}, which is the only
 * function permitted to answer "is this suspended", and it returns false for those paths
 * unconditionally, before it looks at any control at all.
 *
 * ## Pausing an advert is a request, not a fact
 *
 * `ads` paused locally means *we have asked*. Until a provider read confirms it, the
 * campaign state is `pause_pending`, never `paused` — A12's `verifyPause` rule, honoured
 * here rather than re-derived.
 */
import type { CampaignState } from '@verify/contracts';

export const CONTROL_KEYS = ['ads', 'new_orders', 'expensive_verification', 'chatbot'] as const;

export type ControlKey = (typeof CONTROL_KEYS)[number];

export function isControlKey(value: string): value is ControlKey {
  return (CONTROL_KEYS as readonly string[]).includes(value);
}

/** The settings key one control is stored under. */
export function controlSettingKey(key: ControlKey): string {
  return `controls.${key}`;
}

export interface ControlState {
  readonly key: ControlKey;
  readonly paused: boolean;
  /** When the pause was requested. Null when the control has never been touched. */
  readonly since: string | null;
  /** The owner who requested it. Null when never touched. */
  readonly by: string | null;
  readonly note: string | null;
}

export function defaultControlState(key: ControlKey): ControlState {
  return { key, paused: false, since: null, by: null, note: null };
}

/**
 * Paths that keep working through every pause, with the reason each one is on the list.
 * Prefix match: `/app/cancel` covers `/app/cancel/confirm`.
 */
export const PROTECTED_PATHS: readonly { readonly path: string; readonly why: string }[] = [
  { path: '/app/cancel', why: 'a customer must always be able to stop paying us' },
  { path: '/app/support', why: 'a customer must always be able to ask for help' },
  { path: '/support', why: 'the public support page is how someone with no session reaches us' },
  { path: '/refunds', why: 'the cancellation and refund terms must stay readable' },
  { path: '/terms', why: 'the terms we are trading under must stay readable' },
  { path: '/privacy', why: 'the privacy notice must stay readable' },
  { path: '/status', why: 'people need to be able to see that something is wrong' },
  { path: '/admin/login', why: 'the owner must be able to get in and undo the pause' },
];

export function isProtectedPath(path: string): boolean {
  return PROTECTED_PATHS.some((p) => path === p.path || path.startsWith(`${p.path}/`));
}

/**
 * Which paths one control suspends when it is on. Deliberately narrow: a control stops the
 * thing it names and nothing adjacent.
 */
const SUSPENDED_BY: Readonly<Record<ControlKey, readonly string[]>> = {
  ads: [],
  new_orders: ['/app/checkout', '/app/order'],
  expensive_verification: [],
  chatbot: ['/app/assistant', '/owner/assistant/ask'],
  // `ads` and `expensive_verification` suspend background work rather than a page; the
  // empty lists are correct and are asserted by a test so nobody "fixes" them later.
};

export type Controls = Readonly<Record<ControlKey, ControlState>>;

export function defaultControls(): Controls {
  return {
    ads: defaultControlState('ads'),
    new_orders: defaultControlState('new_orders'),
    expensive_verification: defaultControlState('expensive_verification'),
    chatbot: defaultControlState('chatbot'),
  };
}

/**
 * Is this path suspended by the current controls?
 *
 * The protected check comes first and is unconditional. Nothing below it can re-suspend a
 * protected path, however many controls are on.
 */
export function isPathSuspended(path: string, controls: Controls): boolean {
  if (isProtectedPath(path)) return false;
  for (const key of CONTROL_KEYS) {
    const control = controls[key];
    if (!control.paused) continue;
    const paths = SUSPENDED_BY[key];
    if (paths.some((p) => path === p || path.startsWith(`${p}/`))) return true;
  }
  return false;
}

/** What a control actually stops, in the owner's words. Rendered next to every switch. */
export const CONTROL_DESCRIPTION: Readonly<
  Record<ControlKey, { readonly label: string; readonly stops: string; readonly doesNotStop: string }>
> = {
  ads: {
    label: 'Advertising',
    stops:
      'We stop submitting new campaigns and ask the ad platform to pause the running ones.',
    doesNotStop:
      'An ad already being shown may keep running until the platform confirms the pause. Until it confirms, this reads "pause requested", not "paused".',
  },
  new_orders: {
    label: 'New orders',
    stops: 'Nobody new can reach checkout, and no new subscription can start.',
    doesNotStop:
      'Existing customers keep their service, keep being charged on their normal schedule, and can still cancel.',
  },
  expensive_verification: {
    label: 'Expensive verification',
    stops:
      'We stop the retries and the extra provider reads that cost money. Runs still record what they have.',
    doesNotStop:
      'Verification does not become wrong — it becomes unverified where we could not look. Nothing is marked failed because of this.',
  },
  chatbot: {
    label: 'Assistant',
    stops: 'The optional assistant stops answering anywhere.',
    doesNotStop:
      'Nothing about verification, billing or support changes. The assistant never decided any of those.',
  },
};

// ---------------------------------------------------------------------------
// Applying a change
// ---------------------------------------------------------------------------

export interface ControlChange {
  readonly key: ControlKey;
  readonly paused: boolean;
  readonly by: string;
  readonly at: string;
  readonly note: string | null;
}

export type ControlChangeResult =
  | { readonly ok: true; readonly state: ControlState; readonly changed: boolean }
  | { readonly ok: false; readonly reason: 'unknown_control'; readonly detail: string };

/** Pure. The caller persists the returned state and writes the audit row. */
export function applyControlChange(current: Controls, change: ControlChange): ControlChangeResult {
  if (!isControlKey(change.key)) {
    return { ok: false, reason: 'unknown_control', detail: `${String(change.key)} is not a control` };
  }
  const existing = current[change.key];
  if (existing.paused === change.paused) {
    return { ok: true, state: existing, changed: false };
  }
  return {
    ok: true,
    changed: true,
    state: {
      key: change.key,
      paused: change.paused,
      since: change.paused ? change.at : null,
      by: change.paused ? change.by : null,
      note: change.note,
    },
  };
}

// ---------------------------------------------------------------------------
// Ads: a pause we asked for is not a pause that happened
// ---------------------------------------------------------------------------

export interface AdPauseView {
  /** What we show. Never `paused` on the strength of our own request. */
  readonly state: CampaignState;
  readonly confirmedByPlatform: boolean;
  readonly observedAt: string | null;
  readonly explanation: string;
}

/**
 * Turn "the owner pressed pause" plus "what the platform last told us" into a state we are
 * willing to display.
 *
 * `paused` requires a reconciled provider read. An owner's own confirmation that they saw
 * it paused in the platform's console also counts — that is a human reading the provider,
 * which is the same evidence by a slower route. Our own request counts for nothing.
 */
export function adPauseView(input: {
  readonly pauseRequested: boolean;
  readonly providerState: CampaignState | null;
  readonly providerObservedAt: string | null;
  readonly ownerConfirmedPaused: boolean;
}): AdPauseView {
  if (!input.pauseRequested) {
    return {
      state: input.providerState ?? 'unknown',
      confirmedByPlatform: input.providerState !== null,
      observedAt: input.providerObservedAt,
      explanation:
        input.providerState === null
          ? 'We have not read the ad platform recently enough to say what is running.'
          : `Last read from the ad platform at ${String(input.providerObservedAt)}.`,
    };
  }

  const confirmed = input.providerState === 'paused' || input.ownerConfirmedPaused;
  if (confirmed) {
    return {
      state: 'paused',
      confirmedByPlatform: input.providerState === 'paused',
      observedAt: input.providerObservedAt,
      explanation:
        input.providerState === 'paused'
          ? 'The ad platform reports this campaign is paused.'
          : 'You confirmed you saw this paused in the ad platform. We are taking that as the observation.',
    };
  }

  return {
    state: 'pause_pending',
    confirmedByPlatform: false,
    observedAt: input.providerObservedAt,
    explanation:
      'We have asked the ad platform to pause this campaign and it has not confirmed yet. ' +
      'Until it does, assume the advert may still be showing and may still be spending.',
  };
}
