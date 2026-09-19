/**
 * Types for `jobs.mjs`.
 *
 * The runner is plain ESM with no dependencies and no build step, so it is not compiled by
 * `tsconfig.json`. This declaration exists purely so the test suite can import it under
 * `strict` and `noImplicitAny` — it is documentation with teeth, not a compilation target.
 */

export interface CommandResult {
  readonly ok: boolean;
  readonly timedOut?: boolean;
  readonly spawnFailed?: boolean;
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface JobStep {
  readonly label: string;
  readonly argv: readonly string[];
}

export type JobPlan =
  | { readonly kind: 'command'; readonly argv: readonly string[] }
  | { readonly kind: 'sequence'; readonly steps: readonly JobStep[] }
  | {
      readonly kind: 'coding_agent';
      readonly brief: { summary?: string; context?: string; constraints?: string[] } | null;
      readonly paths: readonly string[];
    }
  | { readonly kind: 'unsupported'; readonly why?: string };

export interface LeasedJobShape {
  readonly job_id?: string;
  readonly typed_kind?: string;
  readonly payload?: Record<string, unknown>;
}

export function planFor(job: LeasedJobShape | null | undefined): JobPlan;

export function runCommand(
  argv: readonly string[],
  options?: { cwd?: string; timeoutMs?: number; stdin?: string },
): Promise<CommandResult>;

export function sanitisedEnv(): Record<string, string>;

export function composeAgentPrompt(
  kind: string,
  brief: { summary?: string; context?: string; constraints?: string[] } | null,
  paths: readonly string[] | null | undefined,
): string;

/**
 * The absolute path to a directly spawnable binary, or `null`. Never a `.cmd`/`.bat` shim:
 * Node refuses to spawn those without a shell, and this runner never uses one.
 */
export function resolveExecutable(
  name: string,
  env?: Record<string, string | undefined>,
): string | null;

export type AgentProbe =
  | { readonly available: true; readonly version: string }
  | { readonly available: false; readonly reason: string };

export function probeCodingAgent(options?: { binary?: string; cwd?: string }): Promise<AgentProbe>;

export function runCodingAgent(
  prompt: string,
  options?: { binary?: string; cwd?: string; timeoutMs?: number; maxTurns?: number },
): Promise<CommandResult>;

export function looksLikeRepo(repoRoot: string): boolean;
