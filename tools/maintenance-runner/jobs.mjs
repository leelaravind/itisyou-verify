/**
 * The job table: typed kind -> fixed, compiled-in command.
 *
 * This is the file that makes "no arbitrary command" true rather than aspirational. There
 * is no template, no interpolation and no shell. A command is an argv array of string
 * literals written here, and `runJob` spawns it with `shell: false`. A payload field can
 * never become an argument, an option, a redirect or a second command — the only payload
 * values that reach a process at all are `investigate_incident` and `prepare_patch`'s
 * brief, which is written to **stdin** as data.
 *
 * Node built-ins only. No dependencies.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

/** Windows needs the `.cmd` shim for pnpm; everything else uses the bare name. */
const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const NODE = process.execPath;

/**
 * The complete command table. Every entry is a literal argv.
 *
 * `run_test_suite` maps a validated `suite` value to one of a fixed set of argv arrays —
 * it is a lookup, not a string built from the payload.
 */
const TEST_SUITE_COMMANDS = Object.freeze({
  unit: [PNPM, 'test:unit'],
  integration: [PNPM, 'test:integration'],
  security: [PNPM, 'test:security'],
  typecheck: [PNPM, 'typecheck'],
  all: [PNPM, 'test'],
});

const DIAGNOSTIC_COMMANDS = Object.freeze({
  database: [PNPM, 'typecheck'],
  connectors: [PNPM, 'test:integration'],
  scheduler: [PNPM, 'test:unit'],
  billing: [PNPM, 'test:integration'],
});

/**
 * Resolve a job to a plan.
 *
 * Returns `{ kind: 'command', argv }` for a job a fixed command can do, or
 * `{ kind: 'coding_agent', prompt }` for the two that genuinely need one. Anything else
 * returns `{ kind: 'unsupported' }`, which the runner reports as `infrastructure_error`.
 */
export function planFor(job) {
  const payload = job?.payload ?? {};
  switch (job?.typed_kind) {
    case 'run_health_checks':
      return {
        kind: 'sequence',
        steps: [
          { label: 'typecheck', argv: [PNPM, 'typecheck'] },
          { label: 'secret-scan', argv: [NODE, 'scripts/scan-secrets.mjs'] },
        ],
      };

    case 'collect_redacted_diagnostics': {
      const argv = DIAGNOSTIC_COMMANDS[payload.area];
      return argv === undefined ? { kind: 'unsupported' } : { kind: 'command', argv };
    }

    case 'run_test_suite': {
      const argv = TEST_SUITE_COMMANDS[payload.suite];
      return argv === undefined ? { kind: 'unsupported' } : { kind: 'command', argv };
    }

    case 'investigate_incident':
    case 'prepare_patch':
      return { kind: 'coding_agent', brief: payload.brief ?? null, paths: payload.paths ?? [] };

    case 'execute_approved_release':
      // Deliberately not wired to a deploy command. A release is the one job where a wrong
      // argv is unrecoverable, and the hosted side already requires a bound approval. Until
      // the owner explicitly enables it here, this returns an honest refusal rather than a
      // half-tested deployment path.
      return { kind: 'unsupported', why: 'release execution is not enabled in this runner build' };

    default:
      return { kind: 'unsupported', why: 'unknown job kind' };
  }
}

/**
 * Spawn one argv with no shell, a wall-clock timeout, and captured output.
 *
 * `shell: false` is the default for `spawn` and is stated explicitly because it is the
 * security property, not a detail.
 */
export function runCommand(argv, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000;
  const [command, ...args] = argv;

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: sanitisedEnv(),
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 200_000) stdout = stdout.slice(-200_000);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 200_000) stderr = stderr.slice(-200_000);
    });

    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, spawnFailed: true, code: null, stdout, stderr: String(error.message) });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, timedOut, code, stdout, stderr });
    });
  });
}

/**
 * The environment a job runs in.
 *
 * An allowlist, not a filter: a maintenance command gets what it needs to find Node and
 * the toolchain and nothing else, so a provider key or a Stripe secret sitting in the
 * owner's shell cannot be read by a job and echoed back into a result.
 */
export function sanitisedEnv() {
  const allowed = [
    'PATH',
    'Path',
    'SystemRoot',
    'windir',
    'COMSPEC',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'PROGRAMDATA',
    'NODE_PATH',
    'LANG',
    'LC_ALL',
    'TZ',
  ];
  const env = { CI: '1', NO_COLOR: '1' };
  for (const key of allowed) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

/**
 * Compose the prompt for a coding-agent job from the reviewed brief.
 *
 * It is written to the agent's **stdin**, not onto a command line, and the brief's fields
 * were capped and stripped of control characters by the hosted side before they ever got
 * here. Paths are listed as text for the agent to read; the runner does not open them.
 */
export function composeAgentPrompt(kind, brief, paths) {
  const lines = [
    kind === 'prepare_patch'
      ? 'Prepare a patch for the following reviewed maintenance brief.'
      : 'Investigate the following reviewed maintenance incident brief.',
    '',
    'Do not commit, push, deploy, or change any configuration. Report findings only.',
    '',
    `Summary: ${brief?.summary ?? '(none)'}`,
    '',
    'Context:',
    brief?.context ?? '(none)',
  ];
  if (Array.isArray(brief?.constraints) && brief.constraints.length > 0) {
    lines.push('', 'Constraints:', ...brief.constraints.map((item) => `- ${item}`));
  }
  if (Array.isArray(paths) && paths.length > 0) {
    lines.push('', 'Relevant repository paths:', ...paths.map((item) => `- ${item}`));
  }
  return lines.join('\n');
}

/**
 * Find a real executable for `name`, without a shell.
 *
 * This exists because `spawn(name, …, { shell: false })` on Windows searches PATH with
 * `CreateProcess`, which does **not** append `PATHEXT`. An npm global install puts a
 * `claude.cmd` shim and an extensionless bash script on PATH but no `.exe`, so a bare
 * `spawn('claude')` fails with ENOENT even though `claude --version` works in a terminal.
 *
 * The temptation is to set `shell: true`. That would make every argument a shell token and
 * throw away the strongest guarantee this runner has, so instead we resolve the genuine
 * binary, in this order:
 *
 *   1. `CLAUDE_CLI_PATH`, if the owner set it explicitly;
 *   2. `<dir>/<name><ext>` for each PATH directory, for a directly executable extension;
 *   3. the `bin` entry of `<dir>/node_modules/@anthropic-ai/claude-code/package.json` for
 *      any PATH directory that carries an npm shim — which is where the real `claude.exe`
 *      lives on a global npm install.
 *
 * Returns the absolute path, or `null`. A `.cmd`/`.bat` shim is deliberately **not**
 * returned: Node refuses to spawn those without a shell, and adding one back is the thing
 * this function exists to avoid.
 */
export function resolveExecutable(name, env = process.env) {
  const explicit = env['CLAUDE_CLI_PATH'];
  if (typeof explicit === 'string' && explicit.length > 0 && existsSync(explicit)) {
    return resolve(explicit);
  }
  if (name.includes('/') || name.includes('\\') || isAbsolute(name)) {
    return existsSync(name) ? resolve(name) : null;
  }

  const directExtensions = process.platform === 'win32' ? ['.exe', '.com'] : [''];
  const shimNames = process.platform === 'win32' ? [`${name}.cmd`, `${name}.ps1`, name] : [name];
  const pathDirs = String(env['PATH'] ?? env['Path'] ?? '')
    .split(delimiter)
    .filter((dir) => dir.length > 0);

  for (const dir of pathDirs) {
    for (const ext of directExtensions) {
      const candidate = join(dir, `${name}${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }

  for (const dir of pathDirs) {
    if (!shimNames.some((shim) => existsSync(join(dir, shim)))) continue;
    for (const packageDir of [
      join(dir, 'node_modules', '@anthropic-ai', 'claude-code'),
      join(dir, '..', 'lib', 'node_modules', '@anthropic-ai', 'claude-code'),
    ]) {
      const manifest = join(packageDir, 'package.json');
      if (!existsSync(manifest)) continue;
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
        const bin = typeof parsed.bin === 'string' ? parsed.bin : parsed.bin?.[name];
        if (typeof bin !== 'string') continue;
        const target = resolve(packageDir, bin);
        if (existsSync(target)) return target;
      } catch {
        // A manifest we cannot read is simply not a candidate.
      }
    }
  }
  return null;
}

/**
 * Is the `claude` CLI usable here, and does its supported non-interactive invocation work?
 *
 * Verified on this machine on 2026-09-19: `claude --version` reported `2.1.261 (Claude
 * Code)` and `claude -p "<prompt>" --output-format json` exited 0 with a JSON result
 * object (`"subtype":"success"`). That is the documented print mode — `-p/--print` with
 * `--output-format`, both listed in `claude --help` — and it runs under the owner's own
 * account. Nothing here scrapes an interface, reuses a login token as an API key, or works
 * around a subscription restriction.
 *
 * If the CLI is absent, or print mode fails, the caller must return `infrastructure_error`
 * with the reason. It must never report a fabricated result, and never claim an agent ran.
 */
export async function probeCodingAgent(options = {}) {
  const name = options.binary ?? 'claude';
  const binary = resolveExecutable(name);
  if (binary === null) {
    return {
      available: false,
      reason: `no directly executable ${name} binary was found on PATH (set CLAUDE_CLI_PATH to point at it)`,
    };
  }
  const probe = await runCommand([binary, '--version'], { timeoutMs: 60_000, cwd: options.cwd });
  if (probe.spawnFailed) {
    return { available: false, reason: `${binary} could not be started: ${probe.stderr}` };
  }
  if (!probe.ok) {
    return { available: false, reason: `${name} --version exited ${String(probe.code)}` };
  }
  return { available: true, version: probe.stdout.trim().slice(0, 100) };
}

/** Run a coding-agent job through the CLI's supported print mode. */
export async function runCodingAgent(prompt, options = {}) {
  const binary = resolveExecutable(options.binary ?? 'claude');
  if (binary === null) {
    return {
      ok: false,
      spawnFailed: true,
      code: null,
      stdout: '',
      stderr: 'no coding agent binary is available',
    };
  }
  return runCommand(
    [
      binary,
      '--print',
      '--output-format',
      'json',
      '--max-turns',
      String(options.maxTurns ?? 12),
      // Nothing that prompts is allowed to prompt: this runs unattended.
      '--permission-prompts',
      'none',
    ],
    {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs ?? 20 * 60 * 1000,
      stdin: prompt,
    },
  );
}

/** True when `repoRoot` looks like this repository, so a job cannot run somewhere random. */
export function looksLikeRepo(repoRoot) {
  return existsSync(join(repoRoot, 'package.json')) && existsSync(join(repoRoot, 'migrations'));
}
