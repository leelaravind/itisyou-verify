/**
 * The rule compiler — through the real onboarding routes.
 *
 * `saveFieldMapping` and `saveExpectedOutcome` used to refuse unconditionally: "Publishing a
 * rules change needs the rule compiler, which is not wired into this environment yet." No
 * customer could ever configure a workflow, so no workflow could ever gain a `WorkflowRules`
 * document, a `signing_key_ref`, or anything for a signed event to be judged against — the
 * whole authenticated customer surface was unmeasurable one level deeper than the missing
 * workspace fixture was.
 *
 * Every case here drives the real `POST /app/onboarding/mapping` and
 * `POST /app/onboarding/outcome` routes through the Worker's default export, then reads the
 * **database** back — `workflow_versions.rules_json` parsed through the same
 * `workflowRulesSchema` the evaluator trusts, never the response HTML — because the response
 * is not the product; the row the scheduler will actually load is.
 *
 * Case ids CUST-450..CUST-456.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { workflowRulesSchema } from '@verify/contracts';
import worker from '../../../apps/app/src/index.js';
import type { TestDb } from '../db/harness.js';
import { BASE, SESSION_VALUE, signedInWorkspace, visibleText, type SignedIn } from './harness.js';

const MAPPING_PATH = '/app/onboarding/mapping';
const OUTCOME_PATH = '/app/onboarding/outcome';

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as never;

function envFor(h: TestDb): never {
  return {
    ASSETS: { fetch: async () => new Response('', { status: 404 }) },
    DB: h.db,
    ENVIRONMENT: 'test',
    PUBLIC_BASE_URL: BASE,
    STRIPE_MODE: 'test',
  } as never;
}

interface Served {
  readonly status: number;
  readonly html: string;
  readonly text: string;
}

async function serve(response: Response): Promise<Served> {
  const html = await response.text();
  return { status: response.status, html, text: visibleText(html) };
}

async function post(
  s: SignedIn,
  path: string,
  fields: Record<string, string>,
  signedIn = true,
): Promise<Served> {
  const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded' });
  if (signedIn) headers.set('cookie', `__Host-verify_session=${SESSION_VALUE}`);
  return serve(
    await worker.fetch(
      new Request(`${BASE}${path}`, {
        method: 'POST',
        headers,
        body: new URLSearchParams({ csrf_token: 'form-token', ...fields }).toString(),
      }),
      envFor(s.h),
      ctx,
    ),
  );
}

/** The workflow's current version, read straight from the row — not the port, not the page. */
function currentVersionRow(
  s: SignedIn,
): { rules_json: string; version_number: number; deadline_seconds: number } | undefined {
  return s.h.raw
    .prepare(
      `SELECT v.rules_json, v.version_number, v.deadline_seconds
         FROM workflow_versions v
         JOIN workflows w ON w.current_version_id = v.id
        WHERE w.workspace_id = ? AND w.id = ?`,
    )
    .get(s.workspaceId, s.workflowId) as
    | { rules_json: string; version_number: number; deadline_seconds: number }
    | undefined;
}

function versionCount(s: SignedIn): number {
  return (
    s.h.raw
      .prepare('SELECT COUNT(*) AS n FROM workflow_versions WHERE workspace_id = ? AND workflow_id = ?')
      .get(s.workspaceId, s.workflowId) as { n: number }
  ).n;
}

let open: SignedIn | null = null;

afterEach(() => {
  open?.h.close();
  open = null;
});

async function workspace(): Promise<SignedIn> {
  open = await signedInWorkspace();
  return open;
}

describe('the rule compiler, reached through the real onboarding routes', () => {
  it('CUST-450 saving the field mapping publishes a schema-valid version seeded with the default checks', async () => {
    const s = await workspace();
    const before = versionCount(s);

    const served = await post(s, MAPPING_PATH, { correlationProperty: 'verify_correlation_id' });
    expect(served.status).toBe(303);

    // A new immutable version, not an edit of the fixture `seedWorkspace` planted.
    expect(versionCount(s)).toBe(before + 1);

    const row = currentVersionRow(s);
    expect(row).toBeDefined();
    // The document the scheduler will actually load must parse — this is the assertion the
    // whole file exists to make. `workflowRulesSchema.parse` throws on anything less.
    const rules = workflowRulesSchema.parse(JSON.parse(row?.rules_json ?? '{}'));
    expect(rules.crm_correlation_property).toBe('verify_correlation_id');
    // Seeded with the default four checks — see `ruleCompiler.ts` on why the mapping step
    // alone cannot publish an empty-assertions document.
    expect(rules.assertions.length).toBe(4);
    expect(rules.assertions.every((a) => a.mandatory === true)).toBe(true);
  });

  it('CUST-451 saving the expected outcome afterwards publishes exactly the selected checks, explicitly mandatory', async () => {
    const s = await workspace();
    await post(s, MAPPING_PATH, { correlationProperty: 'verify_correlation_id' });
    const afterMapping = versionCount(s);

    const served = await post(s, OUTCOME_PATH, {
      deadlineSeconds: '1800',
      requireRecordExists: 'on',
      requireEmailDelivered: 'on',
      // requireCorrelationMatch and requireRecipientMatch left off deliberately.
      coverageMode: 'customer_triggered',
    });
    expect(served.status).toBe(303);
    expect(versionCount(s)).toBe(afterMapping + 1);

    const row = currentVersionRow(s);
    const rules = workflowRulesSchema.parse(JSON.parse(row?.rules_json ?? '{}'));
    expect(rules.deadline_seconds).toBe(1800);
    expect(rules.crm_correlation_property).toBe('verify_correlation_id');
    const fields = rules.assertions.map((a) => a.field).sort();
    expect(fields).toEqual(['message.status', 'record.id']);
    expect(rules.assertions.every((a) => a.mandatory === true)).toBe(true);
  });

  it('CUST-452 selecting no checks at all is refused before anything is written', async () => {
    const s = await workspace();
    await post(s, MAPPING_PATH, { correlationProperty: 'verify_correlation_id' });
    const before = versionCount(s);

    const served = await post(s, OUTCOME_PATH, { deadlineSeconds: '600' });
    expect(served.status).toBe(422);
    expect(served.text).toMatch(/at least one check/i);
    expect(versionCount(s)).toBe(before);
  });

  it('CUST-453 an invalid correlation property is refused before the compiler ever runs', async () => {
    const s = await workspace();
    const before = versionCount(s);

    const served = await post(s, MAPPING_PATH, { correlationProperty: 'not a valid property!' });
    expect(served.status).toBe(422);
    expect(served.text).toMatch(/not valid/i);
    expect(versionCount(s)).toBe(before);
  });

  it('CUST-454 saving the outcome before any mapping is refused rather than publishing an empty reference', async () => {
    const s = await workspace();
    const before = versionCount(s);

    const served = await post(s, OUTCOME_PATH, { deadlineSeconds: '600', requireRecordExists: 'on' });
    expect(served.status).toBe(422);
    expect(served.text).toMatch(/map your crm reference field/i);
    expect(versionCount(s)).toBe(before);
  });

  it('CUST-455 a workspace viewer cannot configure the workflow, and nothing is written', async () => {
    const s = await workspace();
    s.h.raw
      .prepare("UPDATE memberships SET role = 'workspace_viewer' WHERE workspace_id = ? AND user_id = ?")
      .run(s.workspaceId, s.userId);
    const before = versionCount(s);

    const served = await post(s, MAPPING_PATH, { correlationProperty: 'verify_correlation_id' });
    expect(served.status).toBe(422);
    expect(served.text).toMatch(/workspace admin/i);
    expect(versionCount(s)).toBe(before);
  });

  it('CUST-456 editing the mapping later republishes, keeping the previously chosen checks and every prior version intact', async () => {
    const s = await workspace();
    await post(s, MAPPING_PATH, { correlationProperty: 'verify_correlation_id' });
    await post(s, OUTCOME_PATH, {
      deadlineSeconds: '1800',
      requireRecordExists: 'on',
      coverageMode: 'customer_triggered',
    });
    const v2 = currentVersionRow(s);
    expect(v2).toBeDefined();
    const v2VersionNumber = v2 as NonNullable<typeof v2>;

    const served = await post(s, MAPPING_PATH, { correlationProperty: 'a_different_property' });
    expect(served.status).toBe(303);

    const v3 = currentVersionRow(s);
    expect(v3?.version_number).toBe(v2VersionNumber.version_number + 1);
    const rules = workflowRulesSchema.parse(JSON.parse(v3?.rules_json ?? '{}'));
    expect(rules.crm_correlation_property).toBe('a_different_property');
    // The choice made on the outcome step survives an unrelated mapping edit.
    expect(rules.assertions.map((a) => a.field)).toEqual(['record.id']);
    expect(rules.deadline_seconds).toBe(1800);

    // Version 2 is untouched — a report that cited it still shows what actually decided it.
    const stillThere = s.h.raw
      .prepare('SELECT rules_json FROM workflow_versions WHERE workspace_id = ? AND version_number = ?')
      .get(s.workspaceId, v2VersionNumber.version_number) as { rules_json: string } | undefined;
    expect(stillThere?.rules_json).toBe(v2VersionNumber.rules_json);
  });
});
