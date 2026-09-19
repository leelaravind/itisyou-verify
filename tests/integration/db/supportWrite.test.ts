/**
 * The support write path, through the port a real request reaches.
 *
 * These exist because the defect they catch was live in a mounted route: the raw body was
 * written straight into a column called `body_redacted`, under a comment asserting that
 * redaction had happened somewhere else. Every case below goes through
 * `D1CustomerDataPort.submitSupportRequest` or `recordAnonymousSupportCase` and then reads
 * the **stored row**, because reading the return value would have passed either way.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { D1CustomerDataPort, recordAnonymousSupportCase, supportCases } from '@app/db';
import { issueSignInToken, redeemSignInToken } from '@app/lib/auth';
import type { Env } from '@app/lib/context';
import {
  countRows,
  createTestDb,
  seedRun,
  seedWorkspace,
  type SeededWorkspace,
  type TestDb,
} from './harness';

const NOW = new Date('2026-09-19T10:00:00.000Z');

function env(): Env {
  return {
    DB: undefined as unknown as Env['DB'],
    ASSETS: undefined as unknown as Env['ASSETS'],
    ENVIRONMENT: 'development',
    PUBLIC_BASE_URL: 'http://localhost:8787',
    STRIPE_MODE: 'test',
  };
}

async function signedInPort(h: TestDb, ws: SeededWorkspace): Promise<D1CustomerDataPort> {
  const issued = await issueSignInToken(h.db, { email: `${ws.workspaceId}@example.com`, now: NOW });
  const redeemed = await redeemSignInToken(h.db, { token: issued.token, now: NOW });
  if (!redeemed.ok) throw new Error('fixture sign-in failed');
  h.raw
    .prepare('UPDATE sessions SET user_id = ? WHERE id = ?')
    .run(ws.userId, redeemed.session.sessionId);
  return new D1CustomerDataPort({
    db: h.db,
    env: env(),
    request: {
      headers: new Headers({ cookie: `verify_session=${redeemed.session.sessionValue}` }),
      url: 'http://localhost:8787/app/support',
    },
    now: NOW,
  });
}

function storedBody(h: TestDb, id: string): string {
  const row = h.raw.prepare('SELECT body_redacted FROM support_cases WHERE id = ?').get(id) as {
    body_redacted: string;
  };
  return row.body_redacted;
}

describe('a support body is redacted before it is stored', () => {
  let h: TestDb;
  let ws: SeededWorkspace;

  beforeEach(() => {
    h = createTestDb();
    ws = seedWorkspace(h, 'alpha');
  });
  afterEach(() => {
    h.close();
  });

  it('CUST-300 a credential pasted into the form never reaches the stored column', async () => {
    const port = await signedInPort(h, ws);
    // A realistic paste: somebody quoting their own configuration at us.
    // secret-scan:allow synthetic values inside a support-form fixture
    const pasted = [
      'My connection keeps failing. Here is what I have configured:',
      'api_key: ' + 'sk' + '_live_0123456789abcdefghijklmn',
      'Authorization: Bearer ' + 'abcdefghijklmnopqrstuvwxyz012345',
      'password = hunter2hunter2',
    ].join('\n');

    const result = await port.submitSupportRequest({
      subject: 'Connection keeps failing',
      body: pasted,
    });
    expect(result.ok).toBe(true);
    expect(result.reference).not.toBeNull();

    const stored = storedBody(h, result.reference as string);
    // The column is called `body_redacted`. It must be true.
    expect(stored).not.toContain('sk' + '_live_0123456789abcdefghijklmn');
    expect(stored).not.toContain('abcdefghijklmnopqrstuvwxyz012345');
    expect(stored).not.toContain('hunter2hunter2');
    // And the prose around it survives, or the owner cannot help anybody.
    expect(stored).toContain('My connection keeps failing');
    expect(stored).toContain('[redacted:');
  });

  it('CUST-301 the whole row, not just the body, is free of the pasted secret', async () => {
    const port = await signedInPort(h, ws);
    // secret-scan:allow synthetic value inside a support-form fixture
    const secret = 'whsec' + '_0123456789abcdefghijklmnopqrstuv';
    const result = await port.submitSupportRequest({
      subject: 'Webhook problem',
      body: `The signing secret I configured is client_secret: ${secret} and nothing arrives.`,
    });
    expect(result.ok).toBe(true);
    const row = h.raw
      .prepare('SELECT * FROM support_cases WHERE id = ?')
      .get(result.reference as string);
    expect(JSON.stringify(row)).not.toContain(secret);
  });

  it('CUST-302 an email address is masked rather than deleted', async () => {
    const port = await signedInPort(h, ws);
    const result = await port.submitSupportRequest({
      subject: 'Wrong recipient',
      body: 'The acknowledgement went to ada@example.com instead of the enquirer.',
    });
    const stored = storedBody(h, result.reference as string);
    // "the address is wrong" is a common support subject, so the domain has to survive.
    expect(stored).not.toContain('ada@example.com');
    expect(stored).toContain('example.com');
  });
});

describe('triage actually runs', () => {
  let h: TestDb;
  let ws: SeededWorkspace;

  beforeEach(() => {
    h = createTestDb();
    ws = seedWorkspace(h, 'alpha');
  });
  afterEach(() => {
    h.close();
  });

  async function submit(subject: string, body: string): Promise<string> {
    const port = await signedInPort(h, ws);
    const result = await port.submitSupportRequest({ subject, body });
    expect(result.ok, result.message ?? '').toBe(true);
    return result.reference as string;
  }

  it('CUST-310 a security report escalates rather than joining the ordinary queue', async () => {
    const id = await submit(
      'Security vulnerability in your verification API',
      'I have found a security vulnerability that lets me read another workspace data. Please respond.',
    );
    const row = await supportCases.getForOwner(h.db, id);
    expect(row?.state).toBe('escalated');
    expect(row?.category).toBe('security_report');
    expect(row?.priority).toBe('urgent');
  });

  it('CUST-311 a deletion request is categorised as one, not as "other"', async () => {
    const id = await submit(
      'Please delete my account and all my data',
      'I would like my account deleted and all of my data erased under GDPR. Please confirm when done.',
    );
    const row = await supportCases.getForOwner(h.db, id);
    expect(row?.category).toBe('data_deletion');
    expect(row?.state).not.toBe('open');
  });

  it('CUST-312 a billing dispute is categorised as one', async () => {
    const id = await submit(
      'I was charged twice this month',
      'You have taken payment twice for September. I want the duplicate charge refunded, this is a dispute.',
    );
    const row = await supportCases.getForOwner(h.db, id);
    expect(['billing_dispute', 'billing_question']).toContain(row?.category);
    expect(row?.priority).not.toBe('low');
  });

  it('CUST-313 a recognised ordinary question stays ordinary — triage is not indiscriminate', async () => {
    const id = await submit(
      'How do I set up a second workflow',
      'How do I connect a second automation? I am past getting started but stuck on the first workflow.',
    );
    const row = await supportCases.getForOwner(h.db, id);
    expect(row?.state).toBe('open');
    expect(row?.category).toBe('setup_help');
    expect(row?.priority).toBe('normal');
  });

  it('CUST-315 a message no rule understands escalates rather than being assumed unimportant', async () => {
    // A09's deliberate default, and the branch that matters most: not understanding a
    // message is not permission to decide it does not matter.
    const id = await submit(
      'A thought',
      'I wanted to mention something that does not fit any of your categories particularly.',
    );
    const row = await supportCases.getForOwner(h.db, id);
    expect(row?.state).toBe('escalated');
    expect(row?.category).toBe('other');
  });

  it('CUST-314 the acknowledgement only claims escalation when escalation happened', async () => {
    const port = await signedInPort(h, ws);
    const escalated = await port.submitSupportRequest({
      subject: 'Security vulnerability report',
      body: 'There is a security vulnerability that exposes data from another workspace to me.',
    });
    const ordinary = await port.submitSupportRequest({
      subject: 'How do I set up the webhook',
      body: 'How do I connect the webhook for my first workflow? I am still getting started.',
    });
    // The sentence "it has gone straight to the owner" was previously printed for every
    // submission, including ones that went into the ordinary queue.
    expect(escalated.message).toContain('straight to the owner');
    expect(ordinary.message).not.toContain('straight to the owner');
  });
});

describe('support is reachable without a session', () => {
  let h: TestDb;

  beforeEach(() => {
    h = createTestDb();
  });
  afterEach(() => {
    h.close();
  });

  it('CUST-320 a signed-out person can reach us, and the case carries no workspace', async () => {
    const result = await recordAnonymousSupportCase(h.db, {
      contactEmail: 'locked.out@example.com',
      subject: 'I cannot sign in',
      body: 'The sign-in link never arrives and I need to cancel my subscription. Please help.',
      now: NOW,
    });
    expect(result.ok).toBe(true);
    expect(result.reference).not.toBeNull();

    const row = await supportCases.getForOwner(h.db, result.reference as string);
    expect(row?.workspace_id).toBeNull();
    expect(row?.contact_email).toBe('locked.out@example.com');
    // Readable in the anonymous scope, and by the owner queue. Not in any workspace.
    expect(await supportCases.get(h.db, result.reference as string, null)).not.toBeNull();
    expect(await supportCases.get(h.db, result.reference as string, 'ws_anything')).toBeNull();
  });

  it('CUST-321 the signed-out path redacts and triages exactly as the signed-in one does', async () => {
    // secret-scan:allow synthetic value inside a support-form fixture
    const token = 'token: ' + 'abcdefghijklmnopqrstuvwxyz0123456789';
    const result = await recordAnonymousSupportCase(h.db, {
      contactEmail: 'locked.out@example.com',
      subject: 'Security problem and I cannot sign in',
      body: `There is a security vulnerability letting me see another workspace. My ${token} is above.`,
      now: NOW,
    });
    const id = result.reference as string;
    expect(storedBody(h, id)).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    const row = await supportCases.getForOwner(h.db, id);
    expect(row?.state).toBe('escalated');
  });

  it('CUST-322 a paused service says so without blocking the message', async () => {
    const result = await recordAnonymousSupportCase(h.db, {
      contactEmail: 'locked.out@example.com',
      subject: 'Cancelling',
      body: 'I would like to cancel my subscription please, the service appears to be paused.',
      servicePaused: true,
      now: NOW,
    });
    // A paused service is exactly when people most need to reach us.
    expect(result.ok).toBe(true);
    expect(result.message).toContain('currently paused');
    expect(countRows(h, 'support_cases')).toBe(1);
  });

  it('CUST-323 a message we could never reply to is refused, not silently dropped', async () => {
    const result = await recordAnonymousSupportCase(h.db, {
      contactEmail: 'not-an-address',
      subject: 'Hello',
      body: 'This should not be stored because there is no way to answer it.',
      now: NOW,
    });
    expect(result.ok).toBe(false);
    expect(countRows(h, 'support_cases')).toBe(0);
  });
});

describe('the signed-in path keeps its tenant boundary', () => {
  let h: TestDb;
  let a: SeededWorkspace;
  let b: SeededWorkspace;

  beforeEach(() => {
    h = createTestDb();
    a = seedWorkspace(h, 'alpha');
    b = seedWorkspace(h, 'beta');
  });
  afterEach(() => {
    h.close();
  });

  it('AUTH-470 a support case cannot be made to reference another tenant’s run', async () => {
    seedRun(h, b, 'run_beta_1', { nextCheckAt: null });
    const port = await signedInPort(h, a);
    const result = await port.submitSupportRequest({
      subject: 'Something went wrong',
      body: 'This enquiry never verified and I would like somebody to look at it please.',
      runId: 'run_beta_1',
    });
    expect(result.ok).toBe(true);
    const row = await supportCases.getForOwner(h.db, result.reference as string);
    expect(row?.workspace_id).toBe(a.workspaceId);
    expect(row?.linked_run_id).toBeNull();
  });
});
