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
  it('RESIL-300 staging has no cron trigger, so nothing runs there on a schedule', () => {
    const staging = environments().staging;
    expect(staging).toBeDefined();
    expect(staging?.triggers).toBeUndefined();
  });

  it('RESIL-301 staging declares no cron expressions by any route', () => {
    const staging = environments().staging as Record<string, unknown> | undefined;
    expect(staging).toBeDefined();
    // Belt and braces: no key anywhere in the staging block mentions a cron.
    expect(JSON.stringify(staging ?? {})).not.toContain('cron');
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
