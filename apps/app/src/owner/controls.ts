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
 * How each control is actually enforced — the registry the middleware, the campaign
 * actions and the controls page all read.
 *
 * ## Why this replaced a bare path list
 *
 * `SUSPENDED_BY` used to be four string arrays, and three separate things were wrong with
 * it at once, each invisible from inside this file:
 *
 *  1. **Nothing called `isPathSuspended`.** The switches wrote a settings row, returned
 *     "Paused." and changed nothing the Worker served. That is the emergency brake, and a
 *     brake that reports success without acting is worse than no brake: a missing one sends
 *     someone to find another way to stop, and a lying one does not.
 *  2. **The paths did not exist.** `new_orders` named `/app/checkout` and `/app/order`;
 *     the real checkout is `POST /app/onboarding/checkout`. So even wired, it would have
 *     suspended nothing. `chatbot` named `/app/assistant` and `/owner/assistant/ask`, and
 *     **no route serves the assistant at all** on this deployment.
 *  3. **Two controls cannot be paths and an empty array could not say so.** `ads` stops an
 *     owner action, and `expensive_verification` stops background work in the scheduler.
 *     An empty list read as "enforced, suspends nothing", which is indistinguishable from
 *     "not enforced" — and they mean opposite things.
 *
 * So enforcement is now declared, not implied, and the declaration is the single source
 * every consumer reads. A control that is `none` renders on the controls page as not
 * enforced, because a switch the owner can press that stops nothing must say so on its
 * face rather than in a comment in this file.
 */
export type ControlEnforcement =
  /** Suspended by a middleware in front of these exact paths. Prefix match on `/`. */
  | { readonly kind: 'http_paths'; readonly paths: readonly string[] }
  /** Suspended inside a named action, because it stops work rather than a page. */
  | { readonly kind: 'action'; readonly sites: readonly string[]; readonly what: string }
  /** Not enforced anywhere. The owner is told, on the switch. */
  | { readonly kind: 'none'; readonly why: string; readonly owner: string };

export const CONTROL_ENFORCEMENT: Readonly<Record<ControlKey, ControlEnforcement>> = {
  /*
   * Advertising is the one switch with money directly behind it: the owner reserved £15 and
   * instructed that ads must not activate without separate approval. The approval gate and
   * this pause are two halves of one control, so this is enforced where a campaign can
   * actually start — not at a path, because activation is an owner action and pausing a
   * page would leave the action reachable.
   */
  ads: {
    kind: 'action',
    sites: ['D1OwnerDataPort.activateCampaign', 'D1OwnerDataPort.resumeCampaign'],
    what: 'No campaign can be activated or resumed while advertising is paused.',
  },
  /*
   * Narrow on purpose. `POST /app/onboarding/checkout` is the only request that can start a
   * subscription. The review page above it stays reachable deliberately: it carries the
   * seven-day recovery policy, and hiding the terms is not part of pausing sales.
   */
  new_orders: { kind: 'http_paths', paths: ['/app/onboarding/checkout'] },
  expensive_verification: {
    kind: 'none',
    why:
      'This would stop the retries and extra provider reads inside the scheduler tick, which is ' +
      'where the cost is. Nothing consults it there yet, so pressing this changes nothing.',
    owner: 'the scheduler owner (apps/app/src/scheduler/)',
  },
  chatbot: {
    kind: 'none',
    why:
      'No route serves the assistant on this deployment, so there is nothing for this switch to ' +
      'suspend. It becomes enforceable the moment an assistant route is mounted.',
    owner: 'whoever mounts the assistant route',
  },
};

/** The paths any control could suspend. Checked in memory before any database read. */
export const SUSPENDABLE_PATHS: readonly string[] = Object.values(CONTROL_ENFORCEMENT).flatMap(
  (enforcement) => (enforcement.kind === 'http_paths' ? enforcement.paths : []),
);

/** Is this control enforced at all? Rendered next to the switch, so it cannot lie silently. */
export function isControlEnforced(key: ControlKey): boolean {
  return CONTROL_ENFORCEMENT[key].kind !== 'none';
}

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
  return suspendingControl(path, controls) !== null;
}

/**
 * Which control suspends this path, or null.
 *
 * The middleware needs the key, not just a boolean: a customer told "this is paused" is
 * owed which thing was paused and what still works, and that sentence lives in
 * {@link CONTROL_DESCRIPTION} against the key.
 */
export function suspendingControl(path: string, controls: Controls): ControlKey | null {
  if (isProtectedPath(path)) return null;
  for (const key of CONTROL_KEYS) {
    const control = controls[key];
    if (!control.paused) continue;
    const enforcement = CONTROL_ENFORCEMENT[key];
    if (enforcement.kind !== 'http_paths') continue;
    if (enforcement.paths.some((p) => path === p || path.startsWith(`${p}/`))) return key;
  }
  return null;
}

/** What a control actually stops, in the owner's words. Rendered next to every switch. */
export const CONTROL_DESCRIPTION: Readonly<
  Record<
    ControlKey,
    { readonly label: string; readonly stops: string; readonly doesNotStop: string }
  >
> = {
  ads: {
    label: 'Advertising',
    stops: 'We stop submitting new campaigns and ask the ad platform to pause the running ones.',
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
    return {
      ok: false,
      reason: 'unknown_control',
      detail: `${String(change.key)} is not a control`,
    };
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
