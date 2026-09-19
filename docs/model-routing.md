# Model routing policy

How work on this project is assigned to models, and what was actually used. Routing is by
**task value, risk and cost** — not by seniority-by-default. The strongest model is not
automatically the right one, and a cheap model on a payment-semantics decision is a false
economy.

Last updated: 2026-09-19.

## Catalogue actually available to this project

Recorded from the delegation tooling this session can genuinely reach. A catalogue entry
is not proof an account can call it, so anything unconfirmed is marked `unknown`.

| Model                     | Access route                      | Confirmed callable                                                  | Used for                                                                                   |
| ------------------------- | --------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Opus 5 (1M context)       | Claude Code session model         | yes — this session                                                  | Lead: architecture, contracts, schema, integration, release decisions                      |
| Opus (subagent)           | `Agent` tool, `model: opus`       | yes — A02, A03, A04, A05, A10, A11 returned real work               | Verification engine, data/security layer, connectors, payments, security review, test gate |
| Sonnet (subagent)         | `Agent` tool, `model: sonnet`     | yes — A01 returned real work                                        | Product scope, factual copy, competitor research, documentation                            |
| Haiku (subagent)          | `Agent` tool, `model: haiku`      | **yes** — produced CONTRIBUTING.md, issue forms and the PR template | Bounded documentation and repository scaffolding                                           |
| Fable (subagent)          | `Agent` tool, `model: fable`      | **yes** — launched for the dependency licence auditor               | Bounded deterministic scripting                                                            |
| OpenRouter free catalogue | Product feature, not a build tool | not configured                                                      | The optional in-product assistant only; requires an owner-supplied key                     |

No model was purchased. No additional account was created. Claude Code subscription access
is used only through its supported delegation interface — it is never transformed into a
general hosted inference API.

## Routing table in force

| Task class                                                                                              | Route                                                                                    | Escalate when                                                                                     |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| File listing, exact search, schema validation, formatting, counting                                     | Deterministic tools only — `grep`, `tsc`, `vitest`, a Node script. No model call.        | Facts conflict in a way that changes a decision                                                   |
| Reading routine files, extracting fields, simple copy edits                                             | Cheapest eligible model, short bounded context                                           | Missing context or repeated concrete errors                                                       |
| Bounded component, fixture, isolated bug, documentation                                                 | Economical capable coding model                                                          | Acceptance criteria still failing after a bounded diagnosis                                       |
| Normal multi-file feature, connector adapter, UI flow                                                   | Balanced coding model                                                                    | Architectural, security or payment implications appear                                            |
| Architecture, tenant isolation, auth, money semantics, budgets under concurrency, public-release review | Strongest suitable reasoning model                                                       | Escalate to the founder only for a consequential unresolved decision — never for model preference |
| Complex debugging with an uncertain root cause                                                          | Balanced diagnosis first, strong model with focused evidence if unresolved               | A specific remaining uncertainty, with traces                                                     |
| Repetitive validation and report generation                                                             | Code and templates — `scripts/verify-test-cases.mjs`, the JUnit reporter. No model call. | A genuinely novel exception needs interpretation                                                  |

**Risk overrides size.** A ten-line change to signature verification deserves a strong
reviewer; a thousand-line routine log does not.

## Context and cost discipline

- Agents receive a short contract excerpt and their owned paths, never the whole repository
  or the whole conversation. `docs/agent-brief.md` exists precisely so twelve agents do not
  each re-derive the same decisions.
- Findings are shared forward: A03's evaluator contract was handed to A04 as an explicit
  brief rather than letting A04 rediscover it. A01's copy is imported by A05 rather than
  rewritten.
- Deterministic checks (`tsc`, `vitest`, the secret scanner, the case-ledger verifier) do
  the repetitive validation. No model is asked to count tests or diff a file.
- Waves are bounded. Concurrency is limited so rate and budget limits are respected, not
  so the team looks large.

## Honesty rules

- A model is recorded as used only when it actually returned work. Selecting one in
  configuration is not evidence it ran.
- Where the tooling does not expose a token count or a cost, that value stays `unknown`
  rather than being estimated into a table.
- Cache behaviour and discounts are not claimed. Pricing differs by provider and cache
  writes can themselves cost money.
- The number of agents is a delivery structure, not a quality claim. Twelve agents do not
  justify twelve expensive models, and ordinary customer operations run as deterministic
  hosted code with no model in the path at all.

## Relationship to the running product

None of the above is in the request path of the service. The hosted application performs
verification, billing, notifications and reporting as deterministic code. The optional
in-product assistant is off by default, and turning it on is never a prerequisite for
support, payments, customer management or any owner control.

## Observed in practice

Recorded after the fact, not predicted.

- **Opus** carried the lead role and eight specialists: contracts, data layer, verification
  engine, connectors, commerce, customer experience, support and privacy, security review,
  the test gate, and growth. Every one of those touches money, tenant isolation, credentials
  or a public claim.
- **Sonnet** settled the product scope and wrote the factual site copy. It cut seven claims
  that nothing implemented — the most valuable single output of the cheaper tier.
- **Haiku** produced the public-repository contribution docs and issue forms. It worked,
  and it **hallucinated the repository URL** in the security contact link
  (`github.com/itisyou/verify`, which does not exist). Caught by checking the link resolved
  rather than accepting "validated" at face value. That is the tier's real failure mode:
  confident, plausible, wrong in a detail nobody would notice until it mattered.
- **Fable** was given the dependency licence auditor — bounded, deterministic, verifiable by
  running it.

The pattern worth keeping: cheaper tiers are good at producing the shape of a thing and
unreliable about specific facts. Anything they emit that names a URL, a version, an
endpoint or a price gets verified by a deterministic check before it is trusted.
