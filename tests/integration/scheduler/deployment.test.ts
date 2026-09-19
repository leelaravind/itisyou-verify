/**
 * Where the tick runs, and — more importantly — where it does not.
 *
 * Plan §30: staging has no cron triggers, deliberately, so a test environment cannot
 * generate recurring cost or recurring provider calls against real customer connections.
 * That is a claim about a config file, so it is asserted against the config file rather
 * than trusted to a comment, and it is asserted by *absence*: adding a `triggers` block to
 * staging fails this test.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const WRANGLER_PATH = fileURLToPath(new URL('../../../apps/app/wrangler.jsonc', import.meta.url));

/**
 * Parse `wrangler.jsonc`.
 *
 * JSONC permits both comments and trailing commas, and this file uses both, so a naive
 * line-based strip is not enough — an added trailing comma broke this suite once already.
 * The scanner tracks string state so a `//` inside a URL is never mistaken for a comment.
 */
function stripJsonc(raw: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i] as string;
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === '/' && raw[i + 1] === '/') {
      while (i < raw.length && raw[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (char === '/' && raw[i + 1] === '*') {
      i += 2;
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    out += char;
  }
  // Trailing commas before a closing brace or bracket, outside any string.
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function readWranglerConfig(): Record<string, unknown> {
  return JSON.parse(stripJsonc(readFileSync(WRANGLER_PATH, 'utf8'))) as Record<string, unknown>;
}

interface EnvBlock {
  readonly triggers?: { readonly crons?: readonly string[] };
}

function environments(): Record<string, EnvBlock> {
  const config = readWranglerConfig();
  return (config.env ?? {}) as Record<string, EnvBlock>;
}

describe('scheduler deployment', () => {
  /**
   * These two used to assert the opposite: that staging declared no cron at all, per plan
   * §30, so a test environment could not generate recurring cost.
   *
   * That decision was revised on 19 September 2026 and the reason is kept here because it
   * is the kind of thing that gets quietly reverted. With no tick on staging, the half of
   * the product that turns an accepted event into a verdict -- the due-run pass, the
   * outbox, allowance settlement, the billing recovery sweep -- had never executed on any
   * deployed environment. Its first real execution was always going to be in production,
   * in front of a customer. Three defects of exactly that shape (correct code that nothing
   * reached) were found in a single afternoon, each invisible until a real request hit a
   * real deployment.
   *
   * So the assertion is no longer "staging has no schedule". It is "staging has a schedule,
   * and it is cheaper than production's" -- which keeps the cost intent that produced §30
   * while removing the blind spot that came with it.
   */
  it('RESIL-300 staging runs the scheduler, so the verdict path is exercised before production', () => {
    const staging = environments().staging;
    expect(staging).toBeDefined();
    const crons = (staging?.triggers as { crons?: string[] } | undefined)?.crons;
    expect(crons, 'staging must schedule the tick, or nothing exercises it pre-production').toEqual(
      ['*/5 * * * *'],
    );
  });

  it('RESIL-301 staging ticks less often than production, so the cost intent behind plan §30 survives', () => {
    const staging = (environments().staging?.triggers as { crons?: string[] } | undefined)?.crons;
    const production = (environments().production?.triggers as { crons?: string[] } | undefined)
      ?.crons;
    expect(staging).toBeDefined();
    expect(production).toBeDefined();

    // Both are plain minute-field expressions; comparing the stride is enough and does not
    // need a cron parser. Production is every minute; staging must be strictly rarer.
    const stride = (expression: string | undefined): number => {
      const minute = (expression ?? '').split(' ')[0] ?? '';
      if (minute === '*') return 1;
      const step = /^\*\/(\d+)$/.exec(minute);
      return step === null ? Number.NaN : Number(step[1]);
    };

    expect(stride(production?.[0])).toBe(1);
    expect(stride(staging?.[0])).toBeGreaterThan(1);
  });

  it('RESIL-302 production runs the tick once a minute', () => {
    const production = environments().production;
    expect(production?.triggers?.crons).toEqual(['* * * * *']);
  });

  it('RESIL-303 the default (development) environment has no cron either', () => {
    const config = readWranglerConfig();
    expect(config.triggers).toBeUndefined();
  });

  it('RESIL-304 every environment that runs the tick has a database to run it against', () => {
    const config = readWranglerConfig();
    for (const [name, block] of Object.entries(environments())) {
      const crons = (block as EnvBlock).triggers?.crons ?? [];
      if (crons.length === 0) continue;
      const databases = (block as Record<string, unknown>).d1_databases;
      expect(Array.isArray(databases), `${name} runs a cron but binds no database`).toBe(true);
      expect((databases as unknown[]).length).toBeGreaterThan(0);
    }
    expect(config).toBeDefined();
  });
});
