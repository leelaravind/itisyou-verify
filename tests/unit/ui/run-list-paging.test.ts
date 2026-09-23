/**
 * The runs list's pager keeps the filter it is paging through.
 *
 * Page 2 of "your tests" used to be page 2 of all runs, because the older/newer links
 * carried only `?cursor=`, and the cursor was interpolated unencoded (audit, 23 September).
 * Case id `VERIFY-936`.
 */
import { describe, expect, it } from 'vitest';
import { render } from '@verify/ui';
import { RunListPage } from '../../../apps/app/src/routes/app/runPages.js';

function hrefs(markup: string): string[] {
  return [...markup.matchAll(/href="([^"]*cursor[^"]*)"/g)].map((match) =>
    (match[1] ?? '').replace(/&amp;/g, '&'),
  );
}

describe('the runs list pager', () => {
  it('VERIFY-936 paging through your tests stays on your tests, with the cursor encoded', async () => {
    const markup = await render(
      RunListPage({
        page: {
          items: [
            {
              id: 'run_1',
              status: 'VERIFIED',
              summary: 'All checks passed',
              correlationId: 'ENQ-TEST-1',
              occurredAt: '2026-09-23T12:00:00.000Z',
              decidedAt: '2026-09-23T12:01:00.000Z',
              mandatorySupported: 2,
              mandatoryTotal: 2,
              isTest: true,
            },
          ],
          nextCursor: 'a+b/c=',
          prevCursor: null,
        } as never,
        workflowName: 'Verification workflow',
        basePath: '/app/runs',
        source: 'test',
      }),
    );
    const links = hrefs(markup);
    expect(links.length).toBeGreaterThan(0);
    const url = new URL(links[0] ?? '', 'https://verify.itisyou.app');
    expect(url.searchParams.get('show')).toBe('test');
    expect(url.searchParams.get('cursor')).toBe('a+b/c=');
  });
});
