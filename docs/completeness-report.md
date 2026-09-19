# Completeness report — ITISYOU Verify

Every line below is either a verified fact with the check that produced it, or an explicit
statement that something is not done. Nothing is rounded up.

Compiled 19 September 2026 against the deployed production build.

---

## Live URLs

| | |
| --- | --- |
| Production | **https://verify.itisyou.app** — custom domain, live |
| Production origin | `https://verify-itisyou-production.kpleelaaravind.workers.dev` |
| Staging | `https://verify-itisyou-staging.kpleelaaravind.workers.dev` |

Verified by request, not by assumption:

| Path | Status |
| --- | --- |
| `/` `/how-it-works` `/pricing` `/demo` `/security` | 200 |
| `/admin/login` | **200 — publicly reachable, as required** |
| `/api/v1/runner/status` | **401** on all three hostnames |
| `POST /api/v1/events` unsigned | **401 `SIGNATURE_INVALID`** |
| `/health` | reports `"database":"reachable"` from a real D1 probe |

Owner pages return **404** to an anonymous visitor rather than 401 — deliberately, so the
dashboard's existence is not confirmable by probing.

## Owner access

`/admin/login` is publicly reachable. Privileged actions require an authenticated session,
and the consequential ones additionally require **recent MFA**. That last control is not
theoretical: the scoped automation identity used for browser testing can read the owner
dashboard and is refused with `403 Confirm it is you` when it attempts to dispatch a test
run. A standing test credential cannot take a consequential action.

## Public repository

`https://github.com/leelaravind/itisyou-verify` — public, `main` current, **0 open security
advisories**. Three moderate advisories were cleared today by taking a dependency major
after measuring it rather than guessing.

Secrets are protected by three independent mechanisms: GitHub push protection, a local
scanner run over the tracked tree **and every blob in history**, and a claim scanner over
public surfaces. All three are release gates.

## Tested release

Pinned to the CI gate artefact, produced by GitHub Actions on a clean checkout:

| | |
| --- | --- |
| Distinct passing countable cases | **2,213** against a required 500 |
| Passing but uncountable | **0** |
| Category floors | **12 of 12 met** |
| Browser suite | now measured in CI: 15 expected, 0 unexpected, 26 skipped |
| Full local suite | 2,554 passed, 0 failed, 3 skipped |

The three skips are named and explained in `docs/release-reconciliation.md`. Two of them —
a real HubSpot read and a real Resend read — skip because no credential exists, and they
are the exact cases that would confirm `transport: 'live'`. **0 of 2 confirmed.**

## Actual spending

| Category | Amount | Confidence |
| --- | --- | --- |
| Advertising | **£0.00** | Confirmed — no campaign activated, the approval gate never invoked |
| Infrastructure | No new paid resource created | Resources verified; the invoice is not visible to me |
| £15 advertising allocation | **Reserved and untouched** | Now enforced in code, not by nobody pressing the button |
| £30 contingency | **Untouched**, separately gated | |
| Claude usage | **Unquantified** | Not measurable from inside this session; see `docs/spend.md` |

No card details have been requested. No payment method is on file.

## Campaign status

**Prepared, not run.** Three destinations researched with each community's rules read from
source: Show HN, r/n8n and r/automate recommended; Indie Hackers conditional; r/msp dropped
because its rules do not permit it. Full post text is in `docs/organic-launch.md`.

**Nothing is published**, because the owner instructed that posts require approval before
publishing. That instruction is being followed rather than interpreted around.

## Visitor count

**0 external visits.** No promotion has run, so there is no external traffic to count. The
only requests to the deployed service are my own verification probes and CI. Reporting any
other number would be fabrication.

---

## Precise remaining blockers

### Requires the owner — I cannot and should not do these

1. **Provider credentials.** HubSpot, Resend and Stripe test access. Three official browser
   tabs are open and verified by domain. This blocks: workflow configuration, signing-key
   issuance for a real customer, every signed-event path end to end, `CONN-900`/`CONN-901`,
   and the first `transport: 'live'` evidence this codebase has ever produced.
2. **Approval to publish the organic posts.** Blocks all ten target visits.
3. **Sole-trader details**, including a decision on whether to publish a home address, use a
   paid business-address service, or defer. Blocks lawful commercial terms and therefore
   taking payment. The form is at `C:\Users\kplee\.itisyou-verify-ops\owner-input.md`.
4. **Explicit approval before live payments**, per the owner's own gate.

### Known and open, not owner-blocked

5. **`RESEND_FROM_ADDRESS` is unset**, so notifications are recorded as
   `no_email_transport_configured` rather than sent. Visible, not silent.
6. **Ten of twelve notification templates have no trigger.** Two are wired and proven.
7. **A live provider outage has never been observed**, because no provider has ever been
   contacted. Outage behaviour is proven against scripted connectors only.
8. **No deployed rollback has been performed.** Version history exists and a rollback is a
   version switch, but the drill has not been run and is not claimed.
9. **Test-id collision**: `BUDGET-017`/`BUDGET-018` are reserved in the ledger for budget
   tests and were used by the assistant work. Needs arbitration.

---

## What this report does not claim

The gates pass and the service answers. That is a statement about the tests and the
deployment, not about the product being correct, secure or ready to sell.

The single largest gap is unchanged and worth stating plainly: **no provider has ever been
contacted.** The connector layer is proven against each vendor's published specification
and against its own tests, not against HubSpot or Resend. Until `CONN-900` and `CONN-901`
run against real credentials, the central claim of this product — that it reads evidence
back from the systems themselves — is implemented and unproven in the one way that counts.
