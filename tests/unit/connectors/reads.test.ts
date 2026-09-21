/**
 * The list of calls the connections screen shows, against the allowlists it is drawn from.
 *
 * "We only ever read" is a claim. The screen now shows the list behind it: every call this
 * application can make with a customer's credential, with what each one is for. The list is
 * only worth showing if it cannot drift from the code, so it is derived from the frozen
 * operation tables the connectors build their URLs from, and this case is what stops a new
 * operation being added without appearing there.
 *
 * Case ids `CONN-524`, `CONN-525`.
 */
import { describe, expect, it } from 'vitest';
import {
  HUBSPOT_READS,
  RESEND_READS,
  readsFor,
} from '../../../packages/connectors/src/reads.js';
import { HUBSPOT_OPERATIONS } from '../../../packages/connectors/src/hubspot.js';
import { RESEND_OPERATIONS } from '../../../packages/connectors/src/resend.js';

describe('the calls we tell a customer we can make', () => {
  it('CONN-524 every allowlisted operation appears, with a purpose, and nothing else does', () => {
    const cases = [
      ['hubspot', HUBSPOT_OPERATIONS, HUBSPOT_READS],
      ['resend', RESEND_OPERATIONS, RESEND_READS],
    ] as const;

    for (const [provider, operations, reads] of cases) {
      const declared = Object.values(operations)
        .map((operation) => `${operation.method} ${operation.path}`)
        .sort();
      const shown = reads.map((read) => read.call).sort();
      expect(
        shown,
        `${provider}: the screen and the allowlist disagree about which calls exist`,
      ).toEqual(declared);

      for (const read of reads) {
        expect(read.purpose, `${provider}: ${read.call} has no purpose`).not.toBe(
          'no purpose recorded',
        );
        expect(read.purpose.length, `${provider}: ${read.call} purpose is too thin`).toBeGreaterThan(
          20,
        );
      }
    }
  });

  it('CONN-525 no write path is in the list, because none exists to be in it', () => {
    const everything = [...HUBSPOT_READS, ...RESEND_READS].map((read) => read.call);

    // The one that matters most: Resend's send endpoint. It is not in the operation table,
    // is not imported, and cannot be constructed, so it must not appear here either.
    expect(everything, 'a send path is on the connections screen').not.toContain('POST /emails');
    for (const call of everything) {
      expect(
        /^(GET|POST) /.test(call),
        `${call} is neither a GET nor an allowlisted POST`,
      ).toBe(true);
      expect(call, `${call} looks like a mutation`).not.toMatch(/\b(delete|update|create|send)\b/i);
    }

    // A provider we do not connect gets an empty list rather than an invented one.
    expect(readsFor('salesforce')).toEqual([]);
  });
});
