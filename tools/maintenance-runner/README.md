# Maintenance runner

A small Node script you run on your own machine. It **polls outbound**, claims one
maintenance job at a time, runs a fixed command for that job's kind, and posts back a
redacted result.

It opens no inbound port. It creates no tunnel. It runs no arbitrary command. The hosted
service cannot start it, stop it, or reach it — it only ever answers the requests this
script makes.

If this script is not running, maintenance jobs **queue**. Verification, billing,
notifications, support and every owner control carry on exactly as normal.

## Requirements

- Node 22 or newer (uses `node:crypto` Web Crypto Ed25519, `spawn`, `fetch` — no packages).
- A checkout of this repository, because the commands it runs are this repository's own
  scripts.

## Pair

In the owner dashboard, create a pairing code. Then, from the repository root:

```sh
node tools/maintenance-runner/runner.mjs pair --base-url https://verify.itisyou.app --code ABCDE-FGHIJ
```

This generates an Ed25519 keypair locally, sends only the **public** key, and stores the
identity outside the repository:

| Platform | Path                                                                |
| -------- | ------------------------------------------------------------------- |
| Windows  | `%LOCALAPPDATA%\itisyou-verify\runner\identity.json`                |
| macOS    | `~/Library/Application Support/itisyou-verify/runner/identity.json` |
| Linux    | `$XDG_STATE_HOME/itisyou-verify/runner/identity.json`               |

The script refuses to write the identity anywhere inside the working tree, so the private
key cannot be committed by accident.

The code is single-use and expires in ten minutes.

## Run

```sh
node tools/maintenance-runner/runner.mjs run              # poll every 30s
node tools/maintenance-runner/runner.mjs run --once       # one poll, then exit
node tools/maintenance-runner/runner.mjs run --interval 60
```

A failing hosted endpoint backs off exponentially to a fifteen-minute ceiling. A revoked
device stops the loop.

## Check

```sh
node tools/maintenance-runner/runner.mjs status
```

Reports whether an identity exists, which service it is paired to, and whether a coding
agent is available on this machine.

## What each job kind actually runs

| Job kind                       | Command                                                                                                                            |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `run_health_checks`            | `pnpm typecheck`, then `node scripts/scan-secrets.mjs`                                                                             |
| `collect_redacted_diagnostics` | one of `pnpm typecheck` / `pnpm test:unit` / `pnpm test:integration`, chosen by a lookup on the validated `area`                   |
| `run_test_suite`               | one of `pnpm test:unit` / `test:integration` / `test:security` / `typecheck` / `test`, chosen by a lookup on the validated `suite` |
| `investigate_incident`         | the `claude` CLI in its supported print mode, with the reviewed brief on **stdin**                                                 |
| `prepare_patch`                | the same, with a patch-preparation brief                                                                                           |
| `execute_approved_release`     | **not enabled in this build** — returns `infrastructure_error` with that reason                                                    |

Every command is a literal argv array in `jobs.mjs`. `spawn` is called with
`shell: false`. No payload field is ever interpolated into a command line; the brief is
written to stdin as data. Jobs run with an allowlisted environment, so a provider key in
your shell is not visible to them.

## The coding-agent jobs, honestly

`investigate_incident` and `prepare_patch` need a coding agent. The runner checks for the
`claude` CLI and its supported non-interactive invocation:

```sh
claude --print --output-format json --max-turns N --permission-prompts none   # prompt on stdin
```

**Verified on the development machine on 2026-09-19**: `claude --version` reported
`2.1.261 (Claude Code)`, and the print-mode invocation above returned a JSON result object
with `"subtype": "success"` and exit code 0, both with the prompt as an argument and with
the prompt piped on stdin. It runs under your own account and your own subscription, and
it costs whatever your account is charged for that usage.

If the CLI is absent, or print mode fails, the job is reported as `infrastructure_error`
with the reason. The runner never fabricates an investigation and never reports that an
agent ran when it did not.

**Finding the binary.** The runner never uses a shell, and on Windows that means a bare
`claude` on PATH is not enough: an npm global install puts a `claude.cmd` shim there, and
Node refuses to spawn a `.cmd` without `shell: true`. So the runner resolves the real
executable itself — `CLAUDE_CLI_PATH` if you set it, then a directly executable
`claude.exe` on PATH, then the `bin` entry of the installed `@anthropic-ai/claude-code`
package next to the shim. If it cannot find one it says so and the job returns
`infrastructure_error`. Set `CLAUDE_CLI_PATH` to the binary if your installation is
somewhere unusual.

Nothing here scrapes a web interface, reuses a login token as an API key, or works around
a subscription restriction.

## Stopping

Ctrl-C. The current poll finishes, then the loop exits. Any job already leased returns to
the queue when its lease expires (fifteen minutes) and another runner — or the same one,
restarted — picks it up.
