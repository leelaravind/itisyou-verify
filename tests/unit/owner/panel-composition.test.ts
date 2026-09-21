/**
 * The owner panel's recomposition, held in place.
 *
 * The panel used to draw four different kinds of "nothing is wrong" in the colour it uses
 * for a failure: figures not measured yet, a maintenance runner nobody has paired, a check
 * that did not run, and a secret shown once after a successful enrolment. Red on all of
 * them teaches the reader that red means nothing, which is expensive on the one page where
 * a real failure has to be noticed.
 *
 * So these cases assert the split rather than the pixels: a state of knowledge renders
 * `data-tone="limit"`, a refusal keeps `data-tone="warn"`, and the long second paragraphs
 * are now disclosures rather than walls.
 *
 * Case ids `OWNER-919..OWNER-923`.
 */
import { describe, expect, it } from 'vitest';
import { OverviewPage } from '@app/routes/owner/dashboardPages';
import { OperationsPage } from '@app/routes/owner/opsPages';
import { OwnerLayout } from '@app/routes/owner/chrome';
import { MemoryOwnerDataPort, syntheticOwnerPrincipal } from '@app/owner/memory';
import type { OverviewView } from '@app/owner/port';
import { html, renderSync } from '@verify/ui';

const NOW = new Date('2026-09-20T12:00:00.000Z');

/**
 * The tone of the callout whose title carries this text. Found by splitting on the element
 * rather than by one regex spanning it: the title holds an inline SVG, and a pattern with a
 * length bound over that is a test that fails for the wrong reason.
 */
function toneOfCallout(html: string, titleText: string): string | null {
  for (const chunk of html.split('<aside').slice(1)) {
    const body = chunk.slice(0, chunk.indexOf('</aside>'));
    if (!body.includes(titleText)) continue;
    return /data-tone="([a-z]+)"/.exec(body)?.[1] ?? null;
  }
  return null;
}

/** The tones a page actually emitted, in order, so a test can say which sat where. */
function tonesOf(html: string): readonly string[] {
  return [...html.matchAll(/data-tone="([a-z]+)"/g)].map((match) => match[1] ?? '');
}

async function overviewHtml(mutate: (view: OverviewView) => OverviewView): Promise<string> {
  const principal = syntheticOwnerPrincipal(NOW);
  const port = new MemoryOwnerDataPort({ principal, now: () => NOW });
  const view = mutate(await port.overview(NOW));
  return renderSync(OverviewPage({ view, now: NOW, paidOrders: 1 }));
}

describe('the owner panel reserves error styling for problems', () => {
  it('OWNER-919 figures that were never measured render as a limit, not as a failure', async () => {
    const html = await overviewHtml((view) => view);

    // The notice that names the unknown figures is the one under test.
    expect(toneOfCallout(html, 'Some figures are not known yet'), 'unknown was drawn as a failure').toBe(
      'limit',
    );
    expect(tonesOf(html), 'something on the overview still claims a problem').not.toContain('warn');
  });

  it('OWNER-920 the net-receipts explanation is a disclosure, not a third paragraph', async () => {
    const html = await overviewHtml((view) => view);

    expect(html).toContain('<details class="callout__detail">');
    expect(html).toContain('How net receipts is worked out');
    // The caveat is inside the disclosure body, which is the point: available, not shouted.
    const detail = /<details class="callout__detail">[\s\S]*?<\/details>/.exec(html)?.[0] ?? '';
    expect(detail).toMatch(/not profit/i);
  });

  it('OWNER-921 the strip states the freshness most figures share, and a figure that differs keeps its own line', async () => {
    // Three launch metrics read at the moment the page was assembled, which is also when
    // three of the four counts were read, so six of the eight tiles agree. The fourth
    // launch metric is a day old, and is the tile the rule must leave alone.
    const html = await overviewHtml((view) => ({
      ...view,
      launch: {
        ...view.launch,
        totalVisits: { value: 13, observedAt: view.assembledAt },
        adAttributedVisits: { value: 5, observedAt: view.assembledAt },
        qualifiedSignups: { value: 3, observedAt: view.assembledAt },
        payingCustomers: { value: 2, observedAt: '2026-09-19T11:50:00.000Z' },
      },
    }));

    expect(html, 'the shared freshness was not stated once').toContain('data-strip-freshness="true"');
    const strip = /data-strip-freshness="true"[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? '';
    expect(strip).toContain('Unless a figure says otherwise');

    // The outlier is a day old, so it still carries its own line: that difference is the
    // only reason to read a freshness at all.
    expect(html).toMatch(/last refreshed 24 hours ago, out of date/);

    // And it is stated once, not eight times: the tiles that agree with the strip are quiet.
    const perTile = html.match(/<p class="micro muted">\s*last refreshed/g) ?? [];
    expect(perTile.length, 'the tiles still repeat a freshness they all share').toBeLessThan(3);
  });

  it('OWNER-922 a runner nobody has paired is a limit, and its consequences are a disclosure', async () => {
    const principal = syntheticOwnerPrincipal(NOW);
    const port = new MemoryOwnerDataPort({ principal, now: () => NOW });
    // The real view, with nothing paired and nothing bound: the two states the panel used
    // to draw in the colour of a failure.
    const view = await port.operations(NOW);
    const html = renderSync(
      OperationsPage({ view, csrfToken: 'token-for-this-test', now: NOW }),
    );

    expect(toneOfCallout(html, 'Nothing is listening'), 'an unpaired runner was drawn as a failure').toBe(
      'limit',
    );
    expect(html).toContain('What happens to jobs meanwhile');

    // And the check that did not run says so in the same register.
    expect(toneOfCallout(html, 'Not checked'), 'an unchecked queue was drawn as a failure').toBe('limit');
  });

  it('OWNER-923 the placeholder-deployment banner is one sentence with the rest behind a disclosure', () => {
    const page = renderSync(
      OwnerLayout({
        title: 'Overview',
        path: '/owner',
        body: html`<p>nothing on this page matters to this case</p>`,
        synthetic: true,
        accountLabel: 'owner@example.invalid',
      }),
    );

    expect(
      toneOfCallout(page, 'These figures are placeholders'),
      'a stand-in deployment was drawn as a failure',
    ).toBe('limit');
    expect(page).toContain('Every number, customer and campaign below is invented.');
    expect(page).toContain('What that means for anything you press');
  });
});
