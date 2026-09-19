/**
 * Keyboard operation and small screens, asserted on the rendered HTML.
 *
 * These are the structural properties a keyboard-only owner on a phone actually depends
 * on, and they can be proved from the markup without a browser: every control is a real
 * focusable element inside a real form, nothing needs JavaScript, and a wide table scrolls
 * inside its own container rather than pushing the page sideways.
 *
 * The browser-level version of the same journey — open an incident, pause the service,
 * cancel a campaign request, entirely from the keyboard at 390px — is
 * `tests/e2e/owner.spec.ts`. It needs the owner router mounted in `apps/app/src/index.ts`,
 * which is the lead's file, and skips itself with a stated reason until that happens.
 */
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createOwnerRoutes } from '@app/routes/owner/index';
import { MemoryOwnerDataPort, syntheticOwnerPrincipal } from '@app/owner/memory';
import type { RouteBindings } from '@app/routes/public/shared';

const NOW = new Date('2026-09-19T12:00:00.000Z');
const ORIGIN = 'http://localhost';
const ENV = { ENVIRONMENT: 'development', PUBLIC_BASE_URL: ORIGIN };

function app(): Hono<RouteBindings> {
  const port = new MemoryOwnerDataPort({ principal: syntheticOwnerPrincipal(NOW), now: () => NOW });
  const instance = new Hono<RouteBindings>();
  instance.route('/', createOwnerRoutes({ resolvePort: async () => port, now: () => NOW }));
  return instance;
}

const PAGES = ['/owner', '/owner/operations', '/owner/controls', '/owner/ads', '/owner/quality', '/owner/cleanup'];

async function bodyOf(path: string): Promise<string> {
  const response = await app().request(`${ORIGIN}${path}`, {}, ENV);
  return response.text();
}

describe('owner panel — keyboard and small screens', () => {
  it('OWNER-158 every owner page carries the mobile viewport and a skip link to the main region', async () => {
    for (const path of PAGES) {
      const body = await bodyOf(path);
      expect(body, path).toContain('name="viewport" content="width=device-width, initial-scale=1"');
      expect(body, path).toContain('<a class="skip" href="#main">Skip to main content</a>');
      expect(body, path).toContain('<main id="main" tabindex="-1">');
    }
  });

  it('OWNER-159 no control anywhere in the panel depends on JavaScript', async () => {
    for (const path of PAGES) {
      const body = await bodyOf(path);
      expect(body, path).not.toMatch(/\son[a-z]+=/i);
      expect(body, path).not.toContain('javascript:');
      expect(body, path).not.toContain('<div role="button"');
    }
  });

  it('OWNER-169 every action is a submit button inside a real form with its own CSRF token', async () => {
    const body = await bodyOf('/owner/controls');
    const forms = body.match(/<form[^>]*method="post"[\s\S]*?<\/form>/g) ?? [];
    expect(forms.length).toBeGreaterThan(3);
    for (const form of forms) {
      expect(form).toContain('name="csrf_token"');
      expect(form).toMatch(/<button[^>]*type="submit"/);
    }
  });

  it('OWNER-176 a wide table scrolls inside its own keyboard-reachable region', async () => {
    const body = await bodyOf('/owner/connections');
    expect(body).toContain('class="tablewrap" role="region" tabindex="0"');
    // The scroll container has an accessible name, so a keyboard user knows what they are in.
    expect(body).toMatch(/class="tablewrap" role="region" tabindex="0" aria-label="[^"]+"/);
  });

  it('OWNER-177 a destructive action names its consequence and needs the word typed in', async () => {
    const body = await bodyOf('/owner/operations');
    expect(body).toContain('name="confirm"');
    expect(body).toMatch(/Type <span class="mono">restore<\/span> to confirm/);
    expect(body).toMatch(/a rollback undoes code, not data/i);
  });

  it('OWNER-178 an incident on the operations page can be opened and acknowledged from the keyboard', async () => {
    const body = await bodyOf('/owner/operations');
    // The alert row carries a real submit button, so Tab then Enter is the whole interaction.
    expect(body).toMatch(/action="\/owner\/operations\/alerts\/alr_1\/acknowledge"/);
    expect(body).toMatch(/HubSpot read latency/);
  });

  it('OWNER-179 the campaign pause control is a submit button, not a link with a side effect', async () => {
    const body = await bodyOf('/owner/ads');
    expect(body).toMatch(/<form method="post" action="\/owner\/ads\/cmp_first_test\/pause"/);
    expect(body).not.toMatch(/<a[^>]+href="\/owner\/ads\/[^"]*\/pause"/);
  });

  it('OWNER-186 every form field has a label bound to its own control', async () => {
    const body = await bodyOf('/owner/settings');
    const labels = [...body.matchAll(/<label[^>]*for="([^"]+)"/g)].map((m) => m[1]);
    expect(labels.length).toBeGreaterThan(5);
    for (const id of labels) {
      expect(body, `no control for label ${String(id)}`).toMatch(new RegExp(`id="${String(id)}"`));
    }
  });

  it('OWNER-187 an error is announced rather than only coloured', async () => {
    const port = new MemoryOwnerDataPort({ principal: syntheticOwnerPrincipal(NOW), now: () => NOW });
    const instance = new Hono<RouteBindings>();
    instance.route('/', createOwnerRoutes({ resolvePort: async () => port, now: () => NOW }));
    const response = await instance.request(
      `${ORIGIN}/owner/settings/business`,
      {
        method: 'POST',
        body: new URLSearchParams({ csrf_token: syntheticOwnerPrincipal(NOW).csrfToken, tradingName: 'Only this' }).toString(),
        headers: {
          cookie: `verify_csrf=${syntheticOwnerPrincipal(NOW).csrfToken}`,
          origin: ORIGIN,
          'content-type': 'application/x-www-form-urlencoded',
        },
      },
      ENV,
    );
    const body = await response.text();
    expect(response.status).toBe(422);
    expect(body).toContain('role="alert"');
    expect(body).toContain('aria-invalid="true"');
    expect(body).toContain('aria-describedby=');
  });

  it('OWNER-188 the panel never renders a status by colour alone', async () => {
    const body = await bodyOf('/owner/controls');
    // Every badge carries its own text, so greyscale and forced-colours modes still work.
    const badges = body.match(/<span[^>]*class="badge[^"]*"[^>]*>([\s\S]*?)<\/span>/g) ?? [];
    expect(badges.length).toBeGreaterThan(0);
    for (const badge of badges) {
      expect(badge.replace(/<[^>]+>/g, '').trim().length).toBeGreaterThan(0);
    }
  });

  it('OWNER-189 the layout uses the shared design system rather than a second stylesheet', async () => {
    const body = await bodyOf('/owner');
    // Exactly one <style> block, the shared one; no <link rel=stylesheet> anywhere.
    expect((body.match(/<style>/g) ?? []).length).toBe(1);
    expect(body).not.toMatch(/<link[^>]+rel="stylesheet"/);
  });
});
