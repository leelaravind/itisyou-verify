# Independent review — generated Stitch landing page

**A19, 2026-09-19.** Subject:
`design/stitch/screens/batch-01/stitch_itisyou_verify_landing_page/itisyou_verify_ground_truth_automation_verification_for_agencies/code.html`
(67,610 bytes) and its `screen.png`, plus
`itisyou_verify_logo/code.html` (1,041 bytes).

This is a review, not an integration. **No application code was changed by this
task.** The generated HTML is reference material and is never a source.

Companion documents: `design/tokens.css` (the token set actually proposed) and
`design/MAPPING.md` (the contrast audit, the palette decision, the four status
treatments, and the replacement lexicon).

---

## 1. Verdict in one paragraph

The **visual system is worth taking** — the dark instrument aesthetic, the
mono-for-machine-output rule, the side-by-side "what the log said / what we
found" comparator, and the 4px/8px radius pair are all good and two of them the
house system already independently arrived at. The **content is not usable at
all**. The page makes at least six categories of factual claim that are false
about this product today, and one that is false about what this product will
_ever_ do. Several would be actionable if published: invented named individuals
with invented quotes, and unearned SOC 2 and ISO 27001 badges.

The owner's instruction was **synthetic data only**. Synthetic data is
`Acme Logistics Global, Inc.` as a placeholder account name. A named founder at
a named agency giving a dated-sounding quote about their retainer is not
synthetic data; it is a fabricated testimonial. A dollar figure presented as an
outcome the product delivers is not synthetic data; it is a false statistic.
The distinction is whether a reader could reasonably believe it refers to
something real, and in every case below they could.

---

## 2. Must-not-integrate

Ordered by severity, worst first.

### 2.1 Auto-remediation — contradicts the frozen contract, not merely the facts

**Severity: highest.** This is the only item on the list that cannot be fixed by
waiting until it becomes true.

The page claims, in four places:

- `STEP 3: RESOLUTION — Proof Certificate & Auto-Remediation … triggers a
self-healing retry routine`
- `SILENT FAILURES RESCUED — 4 Faults — Auto-healed in <14s`
- `FLOW: Shopify_Order -> 3PL_Warehouse — AUTO-REMEDIATED [RETRY 2/3]`
- `"When you catch it via ground truth and auto-heal, you're irreplaceable."`

`docs/agent-brief.md` states: _"The service observes. It never modifies a
customer's CRM, sends replacement emails or repairs their automation."_

This is not a roadmap gap. Observe-only is the product's safety position and the
reason a customer can connect it to a live CRM with a read-scoped token. A
marketing page promising auto-healing would sell a capability whose absence is a
deliberate design decision, and would invite customers to grant write scopes they
should never grant. **Reject entirely. Do not soften; delete.**

### 2.2 Fabricated founder testimonials

**Severity: high.** Three named people, three named companies, three quotes,
fifteen stars.

| Name            | Attributed role                 | Quote contains                                                                                     |
| --------------- | ------------------------------- | -------------------------------------------------------------------------------------------------- |
| Marcus Sterling | Founder at Synthetix Automation | "600+ complex Make and Python flows", "$8k/mo retainer", "caught 3 silent drops in our first week" |
| Devon Kross     | Head of Ops at WorkflowCraft    | "12 silent failures were proactively mitigated"                                                    |
| Amara Vance     | CEO of FlowForge Agency         | "Zapier and Make logs are fundamentally dishonest"                                                 |

Every one is invented. The product has no customers. Three separate problems:

1. **They are false claims about real-world outcomes**, presented in the format
   readers are trained to read as verified social proof. A five-star rating
   graphic is a claim that someone rated us.
2. **The names may collide with real people.** "Synthetix", "WorkflowCraft" and
   "FlowForge" are plausible agency names and at least some are likely to exist.
   Putting words in a real company's mouth is a different and worse problem than
   inventing a fictional one.
3. **The third quote defames a named third party.** "Zapier and Make logs are
   fundamentally dishonest" is a statement about two identifiable companies'
   products, attributed to a person who does not exist. That is the single most
   dangerous sentence on the page.

**Reject. No testimonial section ships until a real customer gives real written
permission for a real quote.** If a placeholder is needed for layout, it must be
visibly non-real — a grey block labelled "customer quote", not a person.

### 2.3 The "$100,800/yr saved" statistic and the entire ROI calculator

**Severity: high.** The calculator chains five invented numbers into a sixth:

| Displayed                                | Value                                               | Problem                                                                                                              |
| ---------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Cost of a churned client (12-mo LTV)     | `$42,000`                                           | Invented, and stated as "based on calculated 12-month contract value" — a methodology that does not exist.           |
| Estimated Prevented Churn                | `2.4 Clients / Year`                                | Invented. A churn-prevention rate is an outcome claim requiring outcome data. We have none.                          |
| Net Agency Retainer Value Preserved      | **`$100,800 / yr`**                                 | 2.4 × $42,000. The arithmetic is consistent; both inputs are fiction, so the output is fiction with a decimal point. |
| Estimated Net ROI                        | `56.4x Return`                                      | Derived from the above against a price that is also wrong (§2.4).                                                    |
| Downtime Shield / Est. Revenue Protected | `$18,400`                                           | Invented, and "revenue protected" claims a causal outcome we cannot observe.                                         |
| Client impact figures                    | `$42,000`, `$120k pipeline`, `80 customer accounts` | Invented harms attributed to named categories of failure.                                                            |

A precise number is a claim of measurement. `$100,800` reads as measured in a way
that "could save you money" does not — that precision is exactly what makes it a
false statistic rather than a puff. **Reject the numbers and the calculator
together.** A calculator that multiplies the visitor's own inputs by a rate
_they_ supply is defensible; one that supplies the rate is not.

### 2.4 Pricing tiers that match neither the product nor its currency

**Severity: high.** The page shows three tiers: `$49` Starter Agency, `$149`
Growth Agency, `$399` High-Scale Partner, all per month, all in US dollars.

The real product, from `apps/app/src/billing/config.ts` and
`packages/contracts/src/rules.ts`:

|          | Generated page                                              | Actual product                                                                                                         |
| -------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Tiers    | 3                                                           | **1**                                                                                                                  |
| Price    | $49 / $149 / $399                                           | **£29.00/month** (`PLAN_PRICE_PENCE: 2900`)                                                                            |
| Currency | USD                                                         | **GBP** (`currency: 'GBP'`, lookup key `verify_single_workflow_monthly_gbp_v1`)                                        |
| Scope    | "up to 15 client workspaces", "unlimited client workspaces" | **one workflow** (`verify_single_workflow_monthly`)                                                                    |
| Unit     | "5,000 / 25,000 / 100,000 Ground-Truth Checks"              | **500 runs per period** (`LIMITS.PLAN_RUNS_PER_PERIOD`) — the smallest generated tier overstates the allowance tenfold |

Wrong on count, wrong on amount, wrong on currency, wrong on unit, wrong on what
is being sold. A displayed price is the one string on a marketing site a customer
is entitled to rely on. The feature lists attached to the tiers are equally
invented (white-label PDF certificates, PagerDuty integration, dedicated egress
IPs, agency directory listing, a custom SLA). **Reject the whole section.**
The real price renders from the frozen constant via
`packages/ui/src/content/pricing.ts` — there is already exactly one correct way
to display it and this is not it.

### 2.5 Unearned compliance and reliability claims

**Severity: high.** These are the items most likely to end a procurement process
badly.

| Claim                                                                                                                                       | Where                | Problem                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------- |
| `SOC2 TYPE II VERIFIED`                                                                                                                     | footer trust badge   | We hold no SOC 2 report. A Type II badge asserts a completed audit over an observation window.              |
| `ISO 27001 COMPLIANT`                                                                                                                       | footer trust badge   | We hold no certification.                                                                                   |
| `SOC2 & ISO 27001 Ready`                                                                                                                    | hero                 | "Ready" is the weasel form of the same claim and is read as the claim.                                      |
| `All Verification Oracles Operational 99.99%`                                                                                               | footer               | An uptime figure we have never measured, presented as live status with a pulsing dot.                       |
| `Custom SLA Settlement Guarantee (99.99%)`                                                                                                  | pricing              | We offer no SLA and settle nothing.                                                                         |
| `GROUND TRUTH ACCURACY 99.98% — 34,120 of 34,128 records`                                                                                   | dashboard mock       | An accuracy rate with a denominator. Invented to four significant figures.                                  |
| `tamper-proof cryptographic execution receipt`, `digest_stored: AWS_KMS_CERTIFIED`, `Cryptographic Proof Protocol`, `E2E ENCRYPTED HASHING` | how-it-works, footer | We sign and attest nothing cryptographically. "AWS_KMS_CERTIFIED" is not a thing, and we do not run on AWS. |
| `Zero client PII retention policy`                                                                                                          | footer               | False — evidence rows contain customer data within the retention window.                                    |

**Reject all.** A compliance badge is the easiest claim in the world to check and
the most expensive one to be caught on.

### 2.6 Integrations and artefacts that do not exist

**Severity: medium-high**, and one item has a security dimension.

| Claim                                                                                                    | Reality                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Works with Make, Zapier, n8n, Modal & LangChain"                                                        | v1 connectors are **HubSpot and Resend**. Nothing else.                                                                                                 |
| Salesforce, QuickBooks, Stripe-as-evidence, Shopify, Typeform, 3PL warehouse flows in the dashboard mock | None are connectors. Stripe is our billing provider, not an evidence source.                                                                            |
| `Python SDK (PyPI: itisyou)`                                                                             | We publish no PyPI package. **Naming an unclaimed package name on a public page invites someone else to register it and ship malware under our brand.** |
| `Make (Integromat) Webhook Node`, `Zapier Private Integration CLI`, `n8n Verified Community Node`        | None exist. "Verified Community Node" is a status n8n grants; claiming it is a claim about n8n.                                                         |
| `POST https://oracle.itisyou.com/v1/assert`                                                              | Endpoint does not exist on a host we do not serve. Documentation-shaped falsehood is worse than prose-shaped falsehood: a developer will copy it.       |
| `© 2025 ITISYOU Verify Inc.`                                                                             | Wrong year (it is 2026), and "Inc." asserts a US corporation.                                                                                           |

### 2.7 Status vocabulary that is not ours

**Severity: medium**, but it is the defect that matters most to the product's
argument.

The page uses `VERIFIED REALITY`, `SILENT FAILURE DETECTED`, `PHANTOM 200
DETECTED`, `Phantom Peace of Mind`, `AUTO-REMEDIATED [RETRY 2/3]`,
`VERIFIED IN QB LEDGER`, `VERIFIED IN SFDC API`. Not one is one of the four
statuses, and the set is effectively binary: things worked, or a failure was
detected and fixed.

**`UNVERIFIED` does not appear anywhere on the page.** The product's entire
thesis — that we say "we could not check" rather than rounding up — is missing
from the page built to sell it. That is not a copy problem; the page argues for a
different product.

The full rejected-vocabulary list with replacements is in `design/MAPPING.md` §7.

---

## 3. Technical defects — the page could not be served by this Worker as-is

Separate from truthfulness. Recorded so nobody attempts a shortcut.

| Defect                                                                                | Consequence under our CSP                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<script src="https://cdn.tailwindcss.com">`                                          | Blocked by `script-src 'sha256-…'`. This is Tailwind's play-CDN JIT compiler: a development tool that compiles CSS in the browser. Not a production technique under any policy.                                                                                                                                                                                       |
| `<link href="https://fonts.googleapis.com/…">` (Material Symbols)                     | Blocked by `style-src`/`style-src-elem`. Allowing it would convert our hash-only style policy into a host allowlist. See `design/MAPPING.md` §6 for the exact cost.                                                                                                                                                                                                   |
| **16 inline `style="…"` attributes**                                                  | Blocked by `style-src-attr 'none'`. This is precisely the bug recorded in `apps/app/src/routes/public/story/narrative.ts`: a blocked `style="width:33%"` made a 33% verification rate **render as 100%**, on the page arguing that a partial result must never look like a pass. Any integration path that reintroduces inline styles reintroduces that class of bug. |
| Logo hot-linked from `https://lh3.googleusercontent.com/aida/AEtjO1U…`                | Blocked by `img-src 'self' data:`. It is also a Google-generated asset URL with no stability guarantee — the brand mark would vanish without warning.                                                                                                                                                                                                                 |
| 68 `material-symbols-outlined` spans, 0 `aria-label`s                                 | Icons are ligature text. If the icon font fails or is blocked, the literal words `check_circle`, `warning`, `verified` render in the layout. Icon-as-font also means the icon has no accessible name.                                                                                                                                                                 |
| `::-webkit-scrollbar{display:none}`                                                   | Hides scrollbars globally. Removes a primary affordance for users who scroll by dragging.                                                                                                                                                                                                                                                                             |
| `<html class="dark">` with `darkMode:"class"`                                         | Hard-forces dark. `prefers-color-scheme` is ignored and there is no toggle. The app supports light, dark and system.                                                                                                                                                                                                                                                  |
| 5 `animate-pulse` / `animate-ping` elements                                           | No `prefers-reduced-motion` guard. Two of them are the status pips, so the motion is attached to the verdict.                                                                                                                                                                                                                                                         |
| **3 inline event handlers** — `oninput="updateCalculator()"` ×2, `onsubmit="…"`       | Blocked by `script-src-attr 'none'`, which the brief calls "not a concession". The ROI calculator is therefore inert, and it fails silently: the sliders move and the numbers never change.                                                                                                                                                                           |
| 3 `<label>` elements, **zero `for=` attributes**, inputs not nested inside them       | The two range sliders and the email field have no accessible name at all.                                                                                                                                                                                                                                                                                             |
| 16 `href="#"` links                                                                   | Every navigation target is dead.                                                                                                                                                                                                                                                                                                                                      |
| One `<h1>`, eight `<h2>`, no skip link, no `sr-only`/visually-hidden utility anywhere | Landmark and focus structure would need rebuilding regardless.                                                                                                                                                                                                                                                                                                        |
| `overscroll-behavior:none` on `body`                                                  | Suppresses pull-to-refresh with no reason given.                                                                                                                                                                                                                                                                                                                      |

---

## 4. What is worth taking

Recorded so the export is not written off wholesale.

| Take                                                                                                                     | Note                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The comparator device** — "Standard Automation Log" beside "ITISYOU Ground Truth" with the same fields in both columns | The single best idea in the export. It makes the product's argument visible in one glance without a sentence of copy. The house `.claimrule` component is the same idea; the export's two-column treatment is a stronger version of it and should inform A05's next pass. |
| **Mono for machine output, sans for prose**                                                                              | The export reached the same rule the house system already enforces. Independent corroboration.                                                                                                                                                                            |
| **4px control / 8px container radius**                                                                                   | Matches the shipped `RADIUS` pair exactly.                                                                                                                                                                                                                                |
| **A raised surface tier and a 12px overlay radius**                                                                      | Two genuine gaps in the house system. Adopted into `design/tokens.css`, re-measured.                                                                                                                                                                                      |
| **The three-catastrophe structure** (a concrete failure, why the log missed it, what it cost)                            | Structurally sound. Every number in it must be replaced with the customer's own, or removed.                                                                                                                                                                              |
| **`screen.png` renders**                                                                                                 | Useful as a visual reference for layout density. No content from them is usable.                                                                                                                                                                                          |

The logo screen (`itisyou_verify_logo/code.html`, 1KB) was also reviewed: it is a
text lockup in Plus Jakarta Sans with no mark, so there is no asset to extract —
only a font dependency we are not taking.

---

## 5. Recommendation

1. **Do not integrate this page, in whole or in part.** Nothing in §2 can be
   patched into truth; §2.1 cannot become true at all.
2. Treat `code.html` as a mood reference for layout and density only, and keep it
   where it is, under `design/stitch/`, clearly outside `apps/`.
3. Take the comparator device to A05 as an input to the marketing route.
4. Apply `design/MAPPING.md` §7's lexicon to any copy that gets written next, and
   apply its one-line test: _if the engine returned `UNVERIFIED`, would this
   sentence still be true?_
5. If Stitch is used again, give it the four statuses, the real price in GBP, the
   observe-only constraint and an explicit "invent no people, companies,
   statistics, prices, logos or compliance claims" instruction in the prompt.
   Every defect in §2 is a defect of an unconstrained generator, not of a
   careless one — it filled the gaps it was given, which is what it does.
