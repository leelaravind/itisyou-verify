# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately, not in a public issue.

- Preferred: GitHub private vulnerability reporting on this repository
  (**Security → Report a vulnerability**).
- Alternative: the contact form at https://verify.itisyou.app/support, choosing
  the "Security report" category.

Please include what you observed, how to reproduce it and the impact you believe it has.
**Do not include credentials, customer data or a working exploit payload.** A description
of the class of problem and a minimal reproduction is enough for us to act.

We will acknowledge receipt and tell you what we found. This is a small, early-stage
service run by one person; we cannot offer a guaranteed response time or a bug bounty,
and we would rather say so than promise otherwise.

## Scope

In scope: this repository, and the hosted service at `verify.itisyou.app`.

Out of scope: denial-of-service testing, automated scanning that generates significant
load, social engineering, physical access, and third-party services we depend on
(report those to the vendor). Please do not test against other customers' data —
if you believe cross-tenant access is possible, tell us and we will reproduce it.

## What this project does and does not claim

This service checks configured operational outcomes using evidence retrieved from
connected systems. It is **not** forensic certification, and it does not claim complete
security, tamper-proof records or any certification. Ordinary application logs are not
immutable. Independent read-back from a provider is stronger evidence than an
automation's own success claim, but it is not a guarantee against someone who controls
the provider account being read.

## Handling of secrets in this public repository

This repository is public by design. It contains no production credentials, no customer
data and no confidential operational records. Every committed environment file is an
example with placeholder values. A secret scan (`pnpm scan:secrets`) runs over the
tracked tree, the full git history and build artifacts before each push.

If you believe a real credential has been committed, report it privately using the route
above and we will revoke and rotate it rather than only deleting the file.
