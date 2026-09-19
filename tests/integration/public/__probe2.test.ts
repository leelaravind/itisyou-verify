import { describe, expect, it } from 'vitest';
import worker from '../../../apps/app/src/index.js';
const env = { ASSETS: { fetch: async () => new Response('', { status: 404 }) }, DB: { prepare: () => { const s: Record<string, unknown> = {}; s['bind'] = () => s; s['first'] = async () => null; s['all'] = async () => ({ results: [] }); s['run'] = async () => ({}); return s; }, batch: async () => [] }, ENVIRONMENT: 'test', PUBLIC_BASE_URL: 'https://verify.itisyou.app' } as never;
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as never;
describe('probe2', () => {
  it('finds soc2', async () => {
    const res = await worker.fetch(new Request('https://verify.itisyou.app/development-story/visual'), env, ctx);
    const html = await res.text();
    const i = html.search(/SOC[ -]?2/i);
    console.log('INDEX', i);
    console.log(JSON.stringify(html.slice(Math.max(0, i - 400), i + 200)));
    expect(true).toBe(true);
  });
});
