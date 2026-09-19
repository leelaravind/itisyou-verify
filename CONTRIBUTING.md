# Contributing to ITISYOU Verify

Thank you for your interest in contributing. This repository is public and accepts pull requests from anyone.

## Before you start

**Understand the licence position.** The source code is published here for transparency about how the service works. No licence to reuse, redistribute or create derivative works is granted at this time. If you are planning a substantial change, please open an issue first to discuss it. Your effort is welcome; we want to be clear about what we can and cannot do with contributions.

For security issues: do not open a public issue. Please report privately using the route in [SECURITY.md](SECURITY.md).

This is a small, early-stage project run by one person. Response times are not guaranteed, and pull requests may not be reviewed immediately.

## Local development

Install dependencies:

```bash
pnpm install
```

Copy the example environment file and fill in any placeholders (never commit `.dev.vars`):

```bash
cp .dev.vars.example .dev.vars
```

Start the development server:

```bash
pnpm --filter @verify/app dev
```

## Before opening a pull request

Run the full check suite locally:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm scan:secrets
```

All checks must pass. The test suite uses synthetic fixtures only and never contacts a real provider.

## Test IDs

Every test title must include a stable case ID. The format is `[PREFIX]-[number]`, for example `VERIFY-012`.

Use the appropriate prefix for your test category:

- `VERIFY` — rules, evidence, verification logic
- `CONN` — connector implementations (HubSpot, Resend, Stripe)
- `PERSIST` — persistence, queues, concurrency
- `AUTH` — authentication, roles, tenant scoping
- `BILL` — checkout, refunds, billing
- `CUST` — customer lifecycle, UI, onboarding
- `OWNER` — owner panel, approvals, quality, cleanup
- `API` — API validation, security, privacy
- `BUDGET` — budgets, models, maintenance
- `ADS` — advertising, analytics
- `RESIL` — accessibility, resilience, deployment
- `DOC` — development stories, release hygiene
- `SEC` — security regression tests

A case counts once. Repeated runs, viewport copies and snapshots without assertions do not count as separate cases.

## About deployment secrets and CI

Pull requests from forks cannot access deployment secrets or production configuration. The continuous integration pipeline runs against synthetic data only — no real provider accounts are used in the test environment.

## What not to commit

Never commit:

- Credentials, API keys or environment files (`.env`, `.dev.vars`)
- Real customer data or customer records
- Browser storage state or session files
- Any sensitive information from a production account

The repository includes a secret scan (`pnpm scan:secrets`) that runs before push. If you believe a real credential has been committed, report it privately using the route in [SECURITY.md](SECURITY.md).
