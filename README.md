# ITISYOU Verify

**Know whether your automations finished the job.**

Your automation says it succeeded. ITISYOU Verify goes and looks. It reads the CRM record
and the email outcome back from the connected systems themselves, checks them against
rules you set, and tells you whether the run passed, failed, or could not be verified —
with the evidence attached.

A workflow's own "success" webhook is a trigger, not proof. That distinction is the
entire product.

---

## Status

Early-stage, in active development. This repository is **public by design** and contains
no production credentials, no customer data and no confidential operational records.

Version one supports one workflow shape: _an enquiry should create the correct CRM record
and trigger an acknowledgement email_, using HubSpot and Resend as evidence sources.

## The four statuses

| Status         | Meaning                                                                                |
| -------------- | -------------------------------------------------------------------------------------- |
| **VERIFIED**   | Every mandatory check has sufficient supporting evidence.                              |
| **FAILED**     | Evidence contradicts a rule, or a deadline was missed and evidence access was working. |
| **UNVERIFIED** | Access, correlation or evidence is missing or ambiguous. Not a pass, not a failure.    |
| **PENDING**    | Still inside the agreed completion window.                                             |

Absence of evidence never becomes VERIFIED. "No runs received yet" is never "100% success".

## What it deliberately does not do

- It does not modify your CRM, send replacement emails, or repair your automation.
- It does not claim to detect a run that never started, unless your workflow is configured
  with an independently sourced trigger. Coverage mode is shown next to every result.
- It does not treat "email accepted by the sending service" as inbox delivery, and it does
  not treat an open-tracking pixel as proof anyone read anything.
- It makes no security certification, uptime or accuracy guarantee.

## Architecture

One Cloudflare Worker serving both the site and the API, backed by D1. Background work
runs from a one-minute cron trigger over a single indexed due-job query — no always-on
machine, and nothing that depends on a developer's laptop being awake.

```
apps/app/            Worker: routes, scheduler, webhooks
packages/contracts/  Zod schemas, shared types, status vocabularies, money
packages/domain/     Pure rule evaluation and the run state machine
packages/connectors/ HubSpot, Resend and Stripe adapters
packages/security/   Credential envelopes, signatures, redaction
packages/ui/         Design tokens and accessible components
migrations/          Ordered D1 migrations
tests/               Unit, integration and browser suites
docs/                Architecture, limitations, development story
```

See [`docs/agent-brief.md`](docs/agent-brief.md) for the engineering contract.

## Local development

```bash
pnpm install
cp .dev.vars.example .dev.vars   # fill in placeholders; never commit this file
pnpm --filter @verify/app dev
```

```bash
pnpm typecheck
pnpm test            # unit + integration; outbound fetch is blocked
pnpm scan:secrets    # run before every push
```

The test suites use synthetic fixtures only and never contact a real provider.

## Security

See [SECURITY.md](SECURITY.md) for private vulnerability reporting.

## Licence

Copyright © 2026 ITISYOU. All rights reserved.

The source is published for transparency about how the service works. No licence to reuse,
redistribute or create derivative works is granted at this time. Third-party dependencies
remain under their own licences.
