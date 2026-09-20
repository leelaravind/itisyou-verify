# Time-boxed launch plan — 20 September 2026

Written at **T+0 = 06:45 UTC**. Allowance resets at **13:45 UTC**, so the box is seven
hours. Release candidate at **hour five (11:45)**; the last two hours are reserved for the
full gate, independent reproduction, production checks, campaign submission and handover.

**Feature freeze is in force.** Nothing new is built. Work is: finish what is started,
prove what is claimed, and disable what cannot be proved.

## The rule this plan is held to

A capability that fails its gate stays **disabled** and is reported as disabled. No test
is weakened to go green, and nothing unfinished is labelled complete to meet the hour.
Where a deadline is missed, the plan says so and says what remains.

## Lanes and file ownership

Separate ownership so two agents never edit one file.

| Lane                       | Owner      | Owns (exclusive)                                                                                                  | Model |
| -------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------- | ----- |
| Payments and recovery      | lead       | `apps/app/src/billing/`, `apps/app/src/routes/webhooks/`, `apps/app/src/db/billingPort.ts`, `scripts/release.mjs` | Opus  |
| Provider workflow evidence | A-WORKFLOW | `docs/workflow-evidence.md`, `tests/integration/verification/`                                                    | Opus  |
| UI and dashboard           | A-UI       | `apps/app/src/routes/app/`, `packages/ui/src/styles.ts`                                                           | Fable |
| Growth                     | A-GROWTH   | `docs/advertising.md`, `docs/organic-launch.md`, `docs/spend.md`, `docs/campaign-packet.md`                       | Fable |
| Independent release audit  | A-AUDIT    | `docs/audit-pass-9.md` — **reads everything, edits nothing else**                                                 | Fable |

The lead alone commits, pushes and deploys. No agent runs a deploy script.

## Remaining work, with acceptance evidence and deadline

Acceptance evidence means a thing that can be checked by someone who does not trust me.

| #   | Work                                                                       | Owner             | Acceptance evidence                                                                                                 | Due      |
| --- | -------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------- | -------- |
| 1   | Production runs the commit that contains the unknown-workspace fix         | lead              | `/health` returns `commit` equal to the deployed SHA; `wrangler deployments list` shows a matching version message  | T+1h     |
| 2   | Foreign-environment event vs legitimate early event, kept apart            | lead              | BILL-650..653; BILL-650 fails against the unguarded code, 651-653 pass both sides as controls                       | **done** |
| 3   | Fresh sandbox checkout **originating from production**, isolated workspace | lead              | a production-origin Checkout Session id; subscription `active`; one entitlement at 500; authenticated page shows it | T+2h     |
| 4   | Exactly-once activation and allowance on that workspace                    | lead              | two activating events, one subscription and one entitlement row                                                     | T+2h     |
| 5   | Replay protection on production                                            | lead              | replayed event logs `already_processed`; entitlement `updated_at` unchanged                                         | T+2h     |
| 6   | HubSpot-Resend: correct correlation and recipient -> VERIFIED              | A-WORKFLOW        | run id, status, evidence rows with `origin` and `provider`, redacted                                                | T+3h     |
| 7   | Wrong recipient **or** wrong correlation -> FAILED                         | A-WORKFLOW        | two separate runs, each FAILED for its own named reason                                                             | T+3h     |
| 8   | Evidence unavailable -> UNVERIFIED, never a pass                           | A-WORKFLOW        | run id and the absence reason; must not be FAILED                                                                   | T+3h     |
| 9   | Usage increments correctly and shows in the authenticated dashboard        | A-WORKFLOW + A-UI | entitlement `consumed` before and after; the same number rendered on `/app/usage`                                   | T+4h     |
| 10  | Authenticated customer journey end to end                                  | A-UI              | each screen fetched with a real session, status codes and rendered assertions                                       | T+4h     |
| 11  | Owner journey stays authenticated, MFA on consequential actions            | A-UI              | `/owner` 404 anonymous; `/admin/login` 200; OWNER-170/171                                                           | T+4h     |
| 12  | Essential Stitch screens: onboarding and dashboard                         | A-UI              | reference folder named per screen, screenshots at 390 / 820 / 1440 by the iframe method                             | T+4h     |
| 13  | Campaign packet ready for one-sitting approval                             | A-GROWTH          | `docs/campaign-packet.md`: every control, the VAT arithmetic, state named as drafted                                | T+2h     |
| 14  | Organic posts publication-ready                                            | A-GROWTH          | every claim re-verified today against live data, with how                                                           | T+3h     |
| 15  | Two production visits attributed or declared unattributed                  | A-GROWTH          | evidence, or an explicit "unattributed" and what would settle it                                                    | T+3h     |
| 16  | Release candidate                                                          | lead              | full gate green on a clean tree at one SHA                                                                          | **T+5h** |
| 17  | Independent reproduction of the payment proof                              | A-AUDIT           | auditor reproduces activation and replay without the lead's help                                                    | T+6h     |
| 18  | Campaign submitted, if and only if 6-8 pass                                | lead + owner      | Google shows the campaign submitted; spend still GBP 0.00                                                           | T+6h     |
| 19  | Both development stories and the evidence record current                   | lead              | events appended with commit SHAs; both stories name what was missed                                                 | T+6.5h   |

## Owner-only steps — blocking, and yours alone

| #   | Step                                         | Why it cannot be me                                                                          | State                   |
| --- | -------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------- |
| O1  | Google "Confirm it's you" identity challenge | Authenticating as the owner is not mine to do, and confirming pushes a prompt to your device | **on screen now**       |
| O2  | EU political ads declaration                 | A legal attestation about your campaign, in your account                                     | outstanding             |
| O3  | Approve the organic posts before publication | They go out under a human identity                                                           | packet due T+3h         |
| O4  | Approve live customer payments               | Separate approval, after verification. Prepared early; not requested yet                     | prepared, not requested |

Nothing in O1-O4 is done by me. The campaign cannot spend while O1 is outstanding.

## Spending position

| Item                       | Amount                          | State                                                 |
| -------------------------- | ------------------------------- | ----------------------------------------------------- |
| Authorised for advertising | GBP 15.00 all-in, VAT included  | unchanged                                             |
| Campaign as built          | GBP 12.46 net = GBP 14.95 gross | drafted                                               |
| Actually spent             | **GBP 0.00**                    | confirmed; no campaign has ever been activated        |
| Contingency                | GBP 30.00                       | untouched, separately gated, not treated as available |

Live customer payments remain **disabled**.

## The four advertising states, kept apart

**drafted** — built in the account, never served, cannot spend. _This is today._
**submitted** — sent to Google for review. Still cannot serve.
**approved** — Google has accepted it. Can serve when it starts.
**delivering** — actually serving impressions and able to spend.

These are never blurred in any report.
