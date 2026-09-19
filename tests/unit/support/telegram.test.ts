/**
 * CUST-2xx — the owner's Telegram channel: routing, the content guard, splitting, and the
 * handling of the one secret.
 *
 * Two properties carry most of the weight here.
 *
 * The first is that the bot is **long-polling for somebody else's running system**. A
 * `getUpdates` call from this codebase would consume updates the founder's own automation
 * is waiting for. That is a constraint about a system outside this repository, which is
 * exactly the kind a comment fails to protect and a test does.
 *
 * The second is that a private chat on a phone is the worst place for a credential or a
 * customer record to land — cloud-backed, searchable forever, unrecallable. So the guard
 * **refuses** rather than redacts, and these tests assert refusal specifically. A test
 * that only checked "the token is not in the output" would pass against a redactor, and a
 * redactor's failures are invisible.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GUARD_EXPLANATION,
  MAX_MESSAGE_CHARACTERS,
  MESSAGE_PREFIX,
  OWNER_ALERT_KIND,
  OWNER_ALERT_ROUTING,
  TELEGRAM_FORBIDDEN_METHODS,
  TELEGRAM_METHOD_ALLOWLIST,
  TELEGRAM_PERMITTED_KINDS,
  assertMethodPermitted,
  channelsFor,
  composeOwnerText,
  describeTelegramConfig,
  guardOwnerMessage,
  loadTelegramConfig,
  redactTelegramToken,
  splitMessage,
} from '@app/notifications/telegram';
import { NOTIFICATION_TEMPLATE } from '@app/notifications/templates';

/** A token-shaped string that is not a real token. Never a live credential in a test. */
const FAKE_TOKEN = '1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const FAKE_CHAT = '-1001234567890';

describe('telegram: the method allowlist', () => {
  it('CUST-289 sendMessage is the only permitted Telegram method', () => {
    expect([...TELEGRAM_METHOD_ALLOWLIST]).toEqual(['sendMessage']);
    expect(() => {
      assertMethodPermitted('sendMessage');
    }).not.toThrow();
    for (const method of TELEGRAM_FORBIDDEN_METHODS) {
      expect(() => {
        assertMethodPermitted(method);
      }, method).toThrow(/not permitted/);
    }
  });

  it('CUST-290 the source builds no URL for a method that would break the founder’s poller', () => {
    // A structural check, not a behavioural one: the risk is a future edit adding a second
    // call, and no behavioural test covers the call nobody has written yet.
    const source = readFileSync(
      join(process.cwd(), 'apps', 'app', 'src', 'notifications', 'telegram.ts'),
      'utf8',
    );
    for (const method of ['getUpdates', 'setWebhook', 'deleteWebhook', 'getChat']) {
      expect(source.includes(`/${method}`), method).toBe(false);
    }
  });
});

describe('telegram: routing', () => {
  it('CUST-291 every owner alert kind has a route with a stated reason', () => {
    expect(OWNER_ALERT_ROUTING).toHaveLength(OWNER_ALERT_KIND.length);
    for (const kind of OWNER_ALERT_KIND) {
      const route = OWNER_ALERT_ROUTING.find((r) => r.kind === kind);
      expect(route, kind).toBeDefined();
      expect(route?.channels.length, kind).toBeGreaterThan(0);
      expect(route?.why.length ?? 0, kind).toBeGreaterThan(40);
    }
  });

  it('CUST-292 the routing covers exactly what the founder asked for, and nothing more', () => {
    expect([...TELEGRAM_PERMITTED_KINDS].sort()).toEqual([
      'approval_needed',
      'authentication_required',
      'critical_incident',
      'milestone_reached',
      'provider_outage',
      'spending_decision',
    ]);
    expect(channelsFor('spending_decision')).toContain('email');
  });

  it('CUST-293 not one of the twelve customer templates is permitted on the owner channel', () => {
    for (const template of NOTIFICATION_TEMPLATE) {
      expect(TELEGRAM_PERMITTED_KINDS.has(template), template).toBe(false);
      const verdict = guardOwnerMessage(template, 'Anything at all.');
      expect(verdict.allowed, template).toBe(false);
      if (verdict.allowed) continue;
      expect(verdict.reason).toBe('kind_not_permitted');
    }
  });
});

describe('telegram: the content guard', () => {
  const kind = 'approval_needed';

  it('CUST-294 a message with no kind is refused — the channel is default-deny', () => {
    for (const missing of [undefined, '', '   ']) {
      const verdict = guardOwnerMessage(missing, 'A perfectly ordinary sentence.');
      expect(verdict.allowed, JSON.stringify(missing)).toBe(false);
      if (verdict.allowed) continue;
      expect(verdict.reason).toBe('kind_missing');
    }
  });

  it('CUST-295 an email address is REFUSED, not masked', () => {
    const verdict = guardOwnerMessage(kind, 'Approval needed from ada@example.com.');
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) return;
    expect(verdict.reason).toBe('contains_email_address');
    // The refusal names the rule and never echoes the value — otherwise the guard
    // becomes the leak it exists to prevent.
    expect(verdict.explanation).not.toContain('ada@example.com');
    expect(verdict.explanation).toBe(GUARD_EXPLANATION.contains_email_address);
  });

  it('CUST-296 a credential shape is REFUSED, not masked', () => {
    const shapes = [
      're_ABCDEFGH12345678901234',
      'sk_live_abcdefghijklmnopqrst',
      'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      'api_key: 8f4c2a9d1e7b3f6a55',
      FAKE_TOKEN,
      'AbCdEf0123456789AbCdEf0123456789',
    ];
    for (const shape of shapes) {
      const verdict = guardOwnerMessage(kind, `Approval needed. ${shape}`);
      expect(verdict.allowed, shape).toBe(false);
      if (verdict.allowed) continue;
      expect(verdict.reason, shape).toBe('contains_credential_shape');
      // Nothing about the refusal carries the value forward.
      expect(verdict.explanation.includes(shape), shape).toBe(false);
    }
  });

  it('CUST-297 a card-like number and a raw payload are REFUSED', () => {
    const card = guardOwnerMessage(kind, 'Approval needed for card 4111 1111 1111 1111.');
    expect(card.allowed).toBe(false);
    if (!card.allowed) expect(card.reason).toBe('contains_card_number');

    const payload = guardOwnerMessage(kind, 'Approval needed: {"email": "a@b.co", "id": 7}');
    expect(payload.allowed).toBe(false);
    // The email rule fires first on this one; either refusal is correct, and neither
    // sends. What matters is that a structured record never goes to a phone.
    if (!payload.allowed) {
      expect(['contains_raw_payload', 'contains_email_address']).toContain(payload.reason);
    }

    const array = guardOwnerMessage(kind, 'Approval needed: [{"status": "FAILED"}]');
    expect(array.allowed).toBe(false);
    if (!array.allowed) expect(array.reason).toBe('contains_raw_payload');
  });

  it('CUST-298 an opaque workspace reference is allowed — it is a pointer, not content', () => {
    const verdict = guardOwnerMessage(
      kind,
      'Approval needed for workspace ws_01J8ABCDEFGH23456789012345. Open the dashboard to review it.',
    );
    expect(verdict.allowed).toBe(true);
    if (!verdict.allowed) return;
    expect(verdict.messages).toHaveLength(1);
  });

  it('CUST-299 an empty message, and one too long to send in a few parts, are both refused', () => {
    const empty = guardOwnerMessage(kind, '   ');
    expect(empty.allowed).toBe(false);
    if (!empty.allowed) expect(empty.reason).toBe('empty_message');

    // Lines of plain words, so only the length rule can fire.
    const enormous = Array.from({ length: 4_000 }, () => 'alpha beta gamma delta').join('\n');
    const tooLong = guardOwnerMessage(kind, enormous);
    expect(tooLong.allowed).toBe(false);
    if (!tooLong.allowed) expect(tooLong.reason).toBe('too_many_messages');
  });
});

describe('telegram: splitting and composition', () => {
  it('CUST-262 a long message is split at a line boundary and nothing is lost', () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${String(i)} of the report`);
    const text = lines.join('\n');
    const chunks = splitMessage(text, 200);

    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(200);
    // Every line survives, in order, exactly once. Nothing truncated.
    expect(chunks.join('\n')).toBe(text);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('CUST-263 a single over-long line is broken at a word boundary, still without loss', () => {
    const line = Array.from({ length: 200 }, () => 'word').join(' ');
    const chunks = splitMessage(line, 50);

    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(50);
    // Rejoining with the space that was consumed at each break gives the original back.
    expect(chunks.join(' ')).toBe(line);
    // And no chunk starts or ends mid-word.
    for (const chunk of chunks) expect(chunk.startsWith(' ')).toBe(false);
  });

  it('CUST-264 an unbroken run longer than the limit is split rather than truncated', () => {
    const blob = 'x'.repeat(250);
    const chunks = splitMessage(blob, 100);
    expect(chunks).toHaveLength(3);
    expect(chunks.join('')).toBe(blob);
  });

  it('CUST-265 text within the limit is one message, unchanged', () => {
    expect(splitMessage('short', MAX_MESSAGE_CHARACTERS)).toEqual(['short']);
  });

  it('CUST-266 every message is prefixed so the founder can tell ours from their own', () => {
    const text = composeOwnerText({
      to: 'owner:telegram',
      subject: 'Approval needed',
      text: 'One campaign is waiting.',
      html: '',
    });
    expect(text.startsWith(`${MESSAGE_PREFIX} — Approval needed`)).toBe(true);
    expect(text).toContain('One campaign is waiting.');

    // Even with no headline at all, the prefix is still there.
    const bare = composeOwnerText({ to: 'x', subject: '  ', text: '  ', html: '' });
    expect(bare).toBe(MESSAGE_PREFIX);
  });
});

describe('telegram: the secret', () => {
  it('CUST-267 a missing or malformed binding is a typed problem, never a thrown secret', () => {
    expect(loadTelegramConfig({})).toEqual({ ok: false, problem: 'token_missing' });
    expect(loadTelegramConfig({ TELEGRAM_BOT_TOKEN: '   ' })).toEqual({
      ok: false,
      problem: 'token_missing',
    });
    expect(loadTelegramConfig({ TELEGRAM_BOT_TOKEN: 'not-a-token' })).toEqual({
      ok: false,
      problem: 'token_malformed',
    });
    expect(loadTelegramConfig({ TELEGRAM_BOT_TOKEN: FAKE_TOKEN })).toEqual({
      ok: false,
      problem: 'owner_chat_missing',
    });
    expect(
      loadTelegramConfig({ TELEGRAM_BOT_TOKEN: FAKE_TOKEN, TELEGRAM_OWNER_CHAT_ID: 'abc' }),
    ).toEqual({ ok: false, problem: 'owner_chat_malformed' });

    const good = loadTelegramConfig({
      TELEGRAM_BOT_TOKEN: FAKE_TOKEN,
      TELEGRAM_OWNER_CHAT_ID: FAKE_CHAT,
    });
    expect(good.ok).toBe(true);
  });

  it('CUST-268 the loggable description carries neither the token nor the chat id', () => {
    const loaded = loadTelegramConfig({
      TELEGRAM_BOT_TOKEN: FAKE_TOKEN,
      TELEGRAM_OWNER_CHAT_ID: FAKE_CHAT,
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const described = describeTelegramConfig(loaded.config);
    const printed = JSON.stringify(described);
    expect(printed).not.toContain(FAKE_TOKEN);
    expect(printed).not.toContain(FAKE_CHAT);
    // Not even a length, which narrows a search space for no benefit.
    expect(printed).not.toMatch(/length/i);
    expect(described).toEqual({
      apiBase: 'https://api.telegram.org',
      tokenPresent: true,
      ownerChatConfigured: true,
    });
  });

  it('CUST-269 a token is removed from any string, including a request URL in an error', () => {
    const failure = `request to https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage failed`;
    const redacted = redactTelegramToken(failure);
    expect(redacted).not.toContain(FAKE_TOKEN);
    expect(redacted).toContain('[REDACTED-TOKEN]');
    // The pattern matches a shape, so it catches a token this code did not put there.
    expect(redactTelegramToken('9876543210:ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ')).toBe(
      '[REDACTED-TOKEN]',
    );
    expect(redactTelegramToken('nothing secret here')).toBe('nothing secret here');
  });
});
