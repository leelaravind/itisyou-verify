#!/usr/bin/env node
/**
 * The ITISYOU Verify maintenance runner.
 *
 * WHAT IT IS
 * ----------
 * A small Node script the owner runs on their own machine, under their own account. It
 * **polls outbound** at a modest interval, claims at most one job at a time, runs a fixed
 * compiled-in command for that job's typed kind, and posts back a redacted result.
 *
 * WHAT IT IS NOT
 * --------------
 * It opens **no inbound port**. It creates **no tunnel**. It executes **no arbitrary
 * command** — see `jobs.mjs`, where every job kind maps to a literal argv and `spawn` runs
 * with `shell: false`. The hosted service cannot reach this process; this process reaches
 * the hosted service. Nothing in the product can start it, stop it, or make it do anything
 * other than the jobs in that table.
 *
 * For `investigate_incident` and `prepare_patch` it checks whether the `claude` CLI is
 * present and whether its supported non-interactive print mode works. If it is not
 * available the job is reported as `infrastructure_error` with the reason. It never
 * fabricates a result and never claims a coding agent ran when one did not.
 *
 * Node built-ins only.
 *
 * USAGE
 *   node tools/maintenance-runner/runner.mjs pair --base-url https://… --code ABCDE-FGHIJ
 *   node tools/maintenance-runner/runner.mjs run   [--once] [--interval 30]
 *   node tools/maintenance-runner/runner.mjs status
 */
import { argv, exit } from 'node:process';
import {
  generateIdentityMaterial,
  identityPath,
  loadIdentity,
  saveIdentity,
  signRequest,
} from './identity.mjs';
import {
  composeAgentPrompt,
  looksLikeRepo,
  planFor,
  probeCodingAgent,
  runCodingAgent,
  runCommand,
} from './jobs.mjs';

const DEFAULT_INTERVAL_SECONDS = 30;
const MAX_INTERVAL_SECONDS = 15 * 60;
const HEARTBEAT_EVERY_POLLS = 4;

function parseArgs(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i += 1;
      }
    } else out._.push(arg);
  }
  return out;
}

function log(message, extra = {}) {
  // One structured line per event. No secrets: the identity file is never read into a log.
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), message, ...extra })}\n`);
}

async function request(identity, { method, path, body }) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const headers = await signRequest(identity, { method, path, body: payload });
  const response = await fetch(`${identity.baseUrl}${path}`, {
    method,
    headers: { ...headers, 'content-type': 'application/json', accept: 'application/json' },
    ...(payload === '' ? {} : { body: payload }),
  });
  let parsed = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed };
}

// ---------------------------------------------------------------------------
// pair
// ---------------------------------------------------------------------------

async function pair(options) {
  const baseUrl = String(options['base-url'] ?? '').replace(/\/+$/, '');
  const code = String(options.code ?? '');
  if (baseUrl.length === 0 || code.length === 0) {
    log('pair requires --base-url and --code');
    return 2;
  }
  if (!baseUrl.startsWith('https://') && !baseUrl.startsWith('http://localhost')) {
    log('refusing to pair over a non-HTTPS base URL', { baseUrl });
    return 2;
  }

  const material = await generateIdentityMaterial();
  const response = await fetch(`${baseUrl}/api/v1/runner/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, public_key: material.publicKeyBase64 }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || typeof body?.device_id !== 'string') {
    log('pairing refused', { status: response.status, code: body?.error?.code ?? null });
    return 1;
  }

  const path = saveIdentity(
    {
      deviceId: body.device_id,
      label: body.label ?? 'maintenance runner',
      baseUrl: `${baseUrl}/api/v1/runner`,
      publicKeyBase64: material.publicKeyBase64,
      privateKeyBase64: material.privateKeyBase64,
      pairedAt: new Date().toISOString(),
    },
    process.cwd(),
  );
  log('paired', { deviceId: body.device_id, identityFile: path });
  return 0;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

async function executeJob(job, repoRoot) {
  const startedAt = new Date().toISOString();
  const plan = planFor(job);

  if (plan.kind === 'unsupported') {
    return {
      outcome: 'infrastructure_error',
      summary: plan.why ?? `this runner has no command for ${String(job.typed_kind)}`,
      details: [],
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    };
  }

  if (plan.kind === 'coding_agent') {
    const probe = await probeCodingAgent({ cwd: repoRoot });
    if (!probe.available) {
      // The honest outcome. Never a fabricated investigation, never a claim that an agent
      // ran. A queued job with a stated reason is the correct product behaviour.
      return {
        outcome: 'infrastructure_error',
        summary: `no coding agent is available on this machine: ${probe.reason}`,
        details: [
          'This job needs a coding agent. The runner checked for the claude CLI and its',
          'supported non-interactive print mode and did not find a working one.',
          'Nothing was investigated and no patch was prepared.',
        ],
        started_at: startedAt,
        finished_at: new Date().toISOString(),
      };
    }
    const prompt = composeAgentPrompt(job.typed_kind, plan.brief, plan.paths);
    const result = await runCodingAgent(prompt, { cwd: repoRoot });
    return {
      outcome: result.ok ? 'passed' : result.timedOut ? 'timed_out' : 'failed',
      summary: result.ok
        ? `coding agent completed (${probe.version ?? 'version unknown'})`
        : `coding agent exited ${String(result.code)}`,
      details: tailLines(result.ok ? result.stdout : `${result.stdout}\n${result.stderr}`, 30),
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    };
  }

  const steps =
    plan.kind === 'sequence' ? plan.steps : [{ label: job.typed_kind, argv: plan.argv }];
  const details = [];
  let outcome = 'passed';
  for (const step of steps) {
    const result = await runCommand(step.argv, { cwd: repoRoot });
    details.push(
      `${step.label}: exit ${String(result.code)}${result.timedOut ? ' (timed out)' : ''}`,
    );
    details.push(...tailLines(`${result.stdout}\n${result.stderr}`, 15));
    if (result.spawnFailed) {
      outcome = 'infrastructure_error';
      break;
    }
    if (result.timedOut) {
      outcome = 'timed_out';
      break;
    }
    if (!result.ok) {
      outcome = 'failed';
      break;
    }
  }
  return {
    outcome,
    summary: `${job.typed_kind} ${outcome}`,
    details,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  };
}

function tailLines(text, count) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-count);
}

async function run(options) {
  const repoRoot = String(options['repo'] ?? process.cwd());
  const identity = loadIdentity(repoRoot);
  if (identity === null) {
    log('no identity found; run `pair` first', { expected: identityPath(repoRoot) });
    return 2;
  }
  if (!looksLikeRepo(repoRoot)) {
    log('refusing to run: this does not look like the verify repository', { repoRoot });
    return 2;
  }

  const baseInterval = Math.max(
    5,
    Math.min(Number(options.interval ?? DEFAULT_INTERVAL_SECONDS) || DEFAULT_INTERVAL_SECONDS, 600),
  );
  const once = options.once === true;

  let interval = baseInterval;
  let polls = 0;
  let stopping = false;
  process.on('SIGINT', () => {
    stopping = true;
    log('stopping after the current poll');
  });

  while (!stopping) {
    polls += 1;
    try {
      if (polls % HEARTBEAT_EVERY_POLLS === 1) {
        await request(identity, { method: 'POST', path: '/heartbeat', body: {} });
      }
      const lease = await request(identity, { method: 'POST', path: '/lease', body: {} });

      if (lease.status === 403) {
        log('this device has been revoked; stopping', { status: lease.status });
        return 0;
      }
      if (lease.status !== 200) {
        // Exponential backoff, capped. A hosted outage must not become a retry storm.
        interval = Math.min(interval * 2, MAX_INTERVAL_SECONDS);
        log('lease request failed', { status: lease.status, nextPollSeconds: interval });
      } else if (lease.body?.job == null) {
        interval = baseInterval;
      } else {
        interval = baseInterval;
        const job = lease.body.job;
        log('claimed job', { jobId: job.job_id, kind: job.typed_kind });
        const result = await executeJob(job, repoRoot);
        const posted = await request(identity, {
          method: 'POST',
          path: `/jobs/${job.job_id}/result`,
          body: { lease_nonce: job.lease_nonce, result },
        });
        log('posted result', {
          jobId: job.job_id,
          outcome: result.outcome,
          status: posted.status,
          duplicate: posted.body?.duplicate ?? null,
        });
      }
    } catch (error) {
      interval = Math.min(interval * 2, MAX_INTERVAL_SECONDS);
      log('poll failed', {
        error: error instanceof Error ? error.name : 'unknown',
        nextPollSeconds: interval,
      });
    }

    if (once) break;
    await sleep(interval * 1000);
  }
  return 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function status(options) {
  const repoRoot = String(options['repo'] ?? process.cwd());
  const identity = loadIdentity(repoRoot);
  const probe = await probeCodingAgent({ cwd: repoRoot });
  log('status', {
    identityFile: identityPath(repoRoot),
    paired: identity !== null,
    deviceId: identity?.deviceId ?? null,
    baseUrl: identity?.baseUrl ?? null,
    codingAgentAvailable: probe.available,
    codingAgentDetail: probe.available ? probe.version : probe.reason,
  });
  return 0;
}

const options = parseArgs(argv.slice(2));
const command = options._[0] ?? 'status';
const handlers = { pair, run, status };
const handler = handlers[command];
if (handler === undefined) {
  log(`unknown command ${command}`, { commands: Object.keys(handlers) });
  exit(2);
}
exit(await handler(options));
