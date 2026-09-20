/**
 * Frequently asked questions. Answers must match implemented behaviour — see
 * docs/product-scope.md's claims-to-implementation map. Do not answer a question with a
 * claim that isn't in that map.
 *
 * Figures are read from `LIMITS`, never retyped. Two answers used to say "30 days" and
 * "Thirty days" as literals while `EVIDENCE_RETENTION_NOTE` and the privacy page rendered
 * the constant beside them: four copies of one number, three of which a change to the
 * retention period would have left behind.
 */
import { LIMITS } from '@verify/contracts';

export interface FaqEntry {
  readonly id: string;
  readonly question: string;
  readonly answer: string;
}

export const FAQ_ENTRIES: readonly FaqEntry[] = [
  {
    id: 'different-from-automation-error-alerts',
    question: "How is this different from my automation's own error alerts?",
    answer:
      "Your automation platform's error alerts tell you when the automation itself threw an error. They say nothing about whether the CRM record or email that came out the other end is actually correct — a workflow that runs top to bottom without an error can still write to the wrong record, skip a step, or send to the wrong address, and none of that raises an alert. We don't watch your automation at all. We read HubSpot and Resend back ourselves, independently, and check what's actually there against the rules you set.",
  },
  {
    id: 'evidence-source-down',
    question: 'What if the evidence source is down?',
    answer:
      // claim-scan:allow we retry OUR OWN check, which is the opposite of fixing their system
      "If HubSpot or Resend is unreachable when we try to check, we don't guess and we don't report a pass. The run shows as unverified with the reason recorded, and we retry automatically within a bounded number of attempts. A missed deadline only counts as failed if the evidence sources were actually reachable at the time — a provider outage never turns into a false failure.",
  },
  {
    id: 'run-never-started',
    question: 'Can you tell me when a run never started?',
    answer:
      'No. We only find out about an enquiry when your automation sends us a signed event — if it never sends one, we have nothing to check, and we show nothing rather than treating silence as a pass. We have built no way to find enquiries your automation never reported, and we would rather name that blind spot than sell you a setting that does not close it. Every result shows the coverage we actually have next to it.',
  },
  {
    id: 'store-customer-data',
    question: 'Do you store my customer data?',
    answer: `We store the specific pieces of evidence needed to check your rules — the CRM record fields and email status your workflow's assertions reference, and the source event your automation sent us — scoped to your workspace. We do not import or mirror your whole CRM. Evidence is kept for ${LIMITS.EVIDENCE_RETENTION_DAYS} days by default and then removed.`,
  },
  {
    id: 'how-cancel',
    question: 'How do I cancel?',
    answer:
      'From the billing portal, at any time. Cancelling stops the next renewal; you keep access for the rest of the period you already paid for. We do not charge a cancellation fee.',
  },
  {
    id: 'data-used-to-train',
    question: 'Is my data used to train anything?',
    answer:
      'No. Evidence we retrieve is used only to check your rules and show you results. If you turn on the optional AI assistant, only what is needed to answer your specific question is sent to the model provider for that request — the assistant can never decide a verification result, an access right, or a charge, and by default the assistant is switched off.',
  },
  {
    id: 'what-workflows-supported',
    question: 'What workflows do you support?',
    answer:
      'One shape, in version one: an enquiry that should create the correct CRM record and trigger an acknowledgement email, using HubSpot and Resend. If your automation does something else, or uses a different CRM or email provider, we cannot verify it yet.',
  },
  {
    id: 'what-do-i-need-before-starting',
    question: 'What do I need before I can start?',
    answer:
      'A HubSpot account you can grant us read access to, a property on your HubSpot contact records that carries a correlation value for each enquiry, a Resend account whose message events we can read, and a small change to your existing automation so it sends us one signed event per enquiry. This is real setup work, not a one-click connection. There is no separate onboarding guide yet — the how-it-works page is the full instructions until one is written.',
  },
  {
    id: 'what-counts-as-a-run',
    question: 'What counts as a "run"?',
    answer:
      "One signed event from your automation, for one enquiry, counted once against your monthly allowance. Sending the same event again with the same event ID returns the existing run's result rather than starting — or charging for — a second one.",
  },
  {
    id: 'what-happens-over-allowance',
    question: 'What happens if I go over my included runs?',
    answer:
      "We stop accepting new events for that workflow until your next billing period starts. We do not charge overage, and we do not keep running and bill you afterwards — you get a plain notice that the period's allowance is used.",
  },
  {
    id: 'accepted-vs-delivered',
    question: 'What\'s the difference between an email being "accepted" and being "delivered"?',
    answer:
      '"Accepted" means Resend, the sending service, took the message. "Delivered" means the receiving mail server actually took it in. Those are different claims and we never merge them — a rule that requires delivery is not satisfied by acceptance alone. We also never treat an email being opened as proof anyone read it.',
  },
  {
    id: 'do-you-modify-anything',
    question: 'Do you ever modify my CRM or resend my emails?',
    answer:
      'No. We only ever read. We do not create or edit CRM records, and we do not send a replacement email on your behalf. If a run fails, fixing it is still on you.',
  },
  {
    id: 'what-is-coverage-mode',
    question: 'What does "coverage mode" mean?',
    answer:
      'It tells you how a workflow finds out about a run. There is one coverage mode today — "customer triggered" — and it means we only see an enquiry when your automation tells us about it, so we cannot see a run that never started at all. It is shown next to your results so the blind spot is never out of sight. A second mode, where we would find the enquiries ourselves, is on the roadmap and is not built; it is not offered, because offering it would mean promising to spot enquiries we have no way to see.',
  },
  {
    id: 'how-long-evidence-kept',
    question: 'How long do you keep evidence?',
    answer: `${LIMITS.EVIDENCE_RETENTION_DAYS} days by default, then it is removed.`,
  },
  {
    id: 'invite-team',
    question: 'Can I invite my team?',
    answer:
      'The plan includes one owner and one invited viewer per workspace. The viewer can see results and evidence; only the owner can change workflow rules, connections or billing.',
  },
  {
    id: 'connection-expires',
    question: 'What happens if my HubSpot or Resend connection expires or loses access?',
    answer:
      'Runs waiting on that connection show as unverified with the specific reason, rather than a false pass or fail, until you reconnect. We tell you which connection needs attention rather than leaving you to guess.',
  },
  {
    id: 'ai-decide-pass-fail',
    question: 'Do you use AI to decide whether a run passes or fails?',
    answer:
      'No. Verification is decided by the rules you set, evaluated against the evidence we read back — that logic never depends on a model. An optional AI assistant exists to help you with things like explaining a result or drafting a rule, but it proposes; it never decides a verification outcome, an access right, or a charge.',
  },
  {
    id: 'is-this-real-time',
    question: 'Is this real-time?',
    answer:
      'No. We check evidence on a schedule, not instantly. A result can take up to an hour to settle, depending on the completion window your workflow is set to.',
  },
  {
    id: 'tax-and-currency',
    question: 'Is tax included in the price?',
    answer:
      'The headline price is what you see at checkout before tax. Any tax required by law, such as VAT, is calculated and added by our payment provider based on your billing details, so the amount actually charged may be higher.',
  },
  {
    id: 'is-verification-live-today',
    question: 'Is this actually running for real accounts right now?',
    answer:
      'Not yet, and the reason is narrower than it used to be. Both providers have now been exercised against live accounts, and a sandbox purchase has completed end to end on a deployment and activated a subscription exactly once. What remains is the part that matters most before anyone pays: live payments are switched off until the owner turns them on separately, and this deployment cannot yet create a new customer workspace. We are not taking payment until both are done. This page stops saying it the day it stops being true, which is why it says less today than it did yesterday.',
  },
];
