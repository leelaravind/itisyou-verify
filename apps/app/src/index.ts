/**
 * Worker entry point.
 *
 * Bootstrap shape only: it serves the static holding page and answers the health
 * endpoint. Routing, the API and the scheduler are added by the implementation
 * agents who own `src/routes/**` and `src/scheduler/**`.
 */

export interface BootstrapEnv {
  readonly ASSETS: Fetcher;
  readonly DB: D1Database;
  readonly ENVIRONMENT: string;
  readonly PUBLIC_BASE_URL: string;
}

export default {
  async fetch(request: Request, env: BootstrapEnv): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      // Reports what is actually true, not a hard-coded "ok".
      let database: 'reachable' | 'unreachable' = 'unreachable';
      try {
        await env.DB.prepare('SELECT 1').first();
        database = 'reachable';
      } catch {
        database = 'unreachable';
      }
      const body = JSON.stringify({
        service: 'itisyou-verify',
        stage: 'in_development',
        environment: env.ENVIRONMENT,
        database,
        checked_at: new Date().toISOString(),
      });
      return new Response(body, {
        status: database === 'reachable' ? 200 : 503,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        },
      });
    }

    const response = await env.ASSETS.fetch(request);
    if (response.status === 404) {
      return new Response('Not found', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    return response;
  },

  /**
   * The minute tick that will drive the due-job scheduler, the outbox dispatcher and
   * bounded retention deletes. It is deliberately a no-op until A03's scheduler lands —
   * an empty tick is honest; a fabricated one would not be.
   */
  async scheduled(_event: ScheduledController, _env: BootstrapEnv): Promise<void> {
    return;
  },
} satisfies ExportedHandler<BootstrapEnv>;
