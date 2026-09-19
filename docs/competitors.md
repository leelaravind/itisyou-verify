# Competitive landscape — "did my automation actually do the thing?"

Owned by A01. Researched via web search and direct doc fetches on 2026-09-19. Where a
detail (pricing, an exact feature cap) could not be confirmed against a primary source in
a reasonable search, it is marked **could not confirm** rather than estimated. No customer
counts, quotes or pricing are stated here unless they came from the vendor's own page.

The consistent finding across every category below: existing tools either (a) trust the
automation platform's own report that it succeeded, or (b) probe a generic, vendor-defined
synthetic transaction on a schedule, or (c) audit CRM data in bulk after the fact. None of
them independently reads back a _specific_ downstream CRM record and a _specific_
downstream email-delivery event and ties both to the one business event that was supposed
to produce them. That is the gap ITISYOU Verify fills, and only for the one workflow shape
it supports (enquiry → CRM record → acknowledgement email, via HubSpot and Resend).

## 1. Automation platforms' own error handling

### n8n — Error Trigger / error workflows

- What it is: a special trigger node that fires a separate "error workflow" when a linked
  workflow throws an execution error.
- Source: https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.errortrigger
  and https://docs.n8n.io/flow-logic/error-handling/ (accessed 2026-09-19).
- What it observes: only that the n8n workflow itself threw or failed inside n8n's own
  engine. It receives execution metadata (execution id, execution URL, whether this was a
  retry) about the failed run. It does not fire for a run that completes without throwing.
- The gap: if the HubSpot node returns 200 but creates the wrong record, a duplicate, or a
  record with the wrong or missing correlation value — or if the Resend node accepts the
  send but the email later bounces — n8n's own workflow reports success and the Error
  Trigger never runs. It catches n8n-side exceptions only, never a silently wrong outcome
  in HubSpot or Resend.

### Make (Integromat) — error handler routes and scenario notifications

- What it is: per-module error handler directives (Break, Ignore, Resume, Commit,
  Rollback) plus scenario-level notifications (Warnings, Errors, Stopped) including
  automatic deactivation after repeated consecutive errors.
- Source: https://www.make.com/en/help/tools/errors, redirecting to https://help.make.com/
  (accessed 2026-09-19).
- What it observes: module-level execution errors (an API call rejected, a connection
  failure) and the scenario's own run/deactivation state.
- The gap: same structural blind spot as n8n. A HubSpot module returning 200 with a
  malformed or duplicate contact, or a Resend module accepting a send that later bounces,
  raises no error Make can react to.

### Zapier — Zapier Manager

- What it is: a meta-Zap app exposing triggers such as "New Zap Error" and "Zap Turned
  Off", used to build failure-alert Zaps.
- Source: https://help.zapier.com/hc/en-us/articles/8496200014477-Troubleshoot-Zapier-Manager
  (accessed 2026-09-19).
- What it observes: Zap-level execution failures and forced shutoffs after repeated
  errors, per the documentation.
- The gap: identical to the above — it is scoped to whether the Zap's own execution threw
  or was halted, never to whether the resulting CRM record or email outcome is correct.

## 2. Dedicated workflow-observability add-ons

### SigNoz for n8n

- What it is: an OpenTelemetry-based observability layer that ingests n8n's own traces,
  logs and metrics into dashboards.
- Source: https://signoz.io/docs/n8n-monitoring/ and
  https://signoz.io/blog/n8n-monitoring-with-opentelemetry/ (accessed 2026-09-19).
- What it observes: node-level execution timing, error attribution and instance health —
  all telemetry the n8n engine itself emits about its own execution.
- Pricing: could not confirm specific figures for the n8n integration in the time
  available.
- The gap: it is a better window onto the automation engine's internal state, not an
  independent read of HubSpot or Resend. It cannot tell you the CRM record is wrong if
  n8n's own execution looked healthy.

### Community consensus (n8n)

- A user thread — https://community.n8n.io/t/a-tool-for-workflow-observability-and-monitoring-for-workflows/303372
  (accessed 2026-09-19) — confirms there is no widely-known dedicated product that verifies
  the real-world downstream effect of an n8n workflow; the common answer is to bolt on
  general infrastructure observability (Grafana/Prometheus, or Elasticsearch/Kibana) on
  top of n8n's own exported logs and metrics, per n8n's own monitoring documentation
  (referenced from https://deepwiki.com/n8n-io/n8n-docs/9-monitoring-and-observability,
  accessed 2026-09-19). Same blind spot: infra/engine telemetry, not downstream business
  outcome.

## 3. Uptime / synthetic monitoring

### Checkly

- What it is: API and browser synthetic monitoring on a schedule.
- Source: https://www.checklyhq.com/docs/detect/synthetic-monitoring/overview/ and
  https://www.checklyhq.com/pricing/ (accessed 2026-09-19). Search results suggested
  roughly $24/month (Starter, billed annually) and $64/month (Team) tiers; **could not
  independently confirm these are the current exact prices** beyond the search snippet, so
  treat as unverified.
- What it observes: whether a URL or a scripted synthetic transaction the vendor defines
  responds correctly (status code, response time, assertions on the response) at each
  scheduled run.

### Better Stack (Better Uptime)

- What it is: HTTP/uptime monitoring with status pages and incident alerting.
- Source: https://betterstack.com/docs/uptime/uptime-monitor/ and
  https://betterstack.com/community/guides/monitoring/what-is-api-monitoring/ (accessed
  2026-09-19).
- What it observes: HTTP status code (2xx), response time, TLS certificate expiry, and
  optionally a keyword match in the response body, on a polling interval.

### The gap for both

Synthetic monitors test a generic, vendor-scripted probe against an endpoint on a
schedule. They have no concept of a specific customer's enquiry. They cannot say "enquiry
#4821 produced contact record X in HubSpot and the acknowledgement email for that specific
enquiry was delivered" — they monitor system reachability in general, not the outcome of
one particular business transaction.

## 4. CRM data-quality / hygiene tools

### Insycle

- What it is: bulk CRM data-cleaning — duplicate detection/merging, field formatting,
  standardisation, aggregation, run in bulk or on a schedule.
- Source: https://www.insycle.com/hubspot/ and
  https://blog.insycle.com/hubspot-data-quality-automation (accessed 2026-09-19).

### HubSpot's own Data Quality tools

- What it is: native duplicate-detection tooling that surfaces likely duplicate
  contact/company pairs for manual or bulk merge.
- Source: https://knowledge.hubspot.com/data-management/use-data-quality-tools and
  https://knowledge.hubspot.com/records/manage-duplicate-records (accessed 2026-09-19).
  Search results referenced tier-dependent duplicate-pair caps (figures in the low
  thousands to hundreds of thousands depending on Professional/Enterprise); **could not
  confirm the current exact caps** against the primary docs above in the time available,
  so no specific numbers are stated here.

### The gap for both

These tools work retrospectively and in bulk, across the whole database, on their own
schedule. They do not check, at the moment one specific enquiry comes in, that the correct
single record was created with the right correlation value, or that the acknowledgement
email tied to that specific enquiry was actually delivered. They catch aggregate mess
after the fact; they have no notion of a single event's expected outcome.

## 5. General APM / error tracking (Datadog, Sentry) applied to no-code automation

These are code-level application-performance and exception-tracking platforms — capturing
exceptions, distributed traces and infrastructure metrics from instrumented code. They
apply to a no-code automation only to the extent the platform exports telemetry (for
example n8n's OpenTelemetry/webhook export referenced above) or a custom script inside the
automation calls their SDK directly.

For a small agency running an enquiry automation over HubSpot and Resend via
n8n/Make/Zapier, adopting Datadog or Sentry is generally impractical: it needs engineering
effort to instrument, and even instrumented, it still only reports what the automation
platform itself threw or logged — the same upstream-only blind spot as the native error
features in §1. No feature was found on either platform that independently reads back a
downstream CRM or email-delivery outcome tied to a specific business event.

## Where this leaves ITISYOU Verify

Every category above answers some version of "did the automation report an error." None of
them answers "does the CRM record actually exist, correctly correlated, and did the email
land." That is the one narrow claim ITISYOU Verify makes for the one workflow shape it
supports — see `docs/product-scope.md` for exactly which fields and rules back that claim,
and where the claim stops (it does not diagnose _why_ an automation failed, and by default
it cannot detect a run that never started at all — see the coverage-mode caveat in that
document).
