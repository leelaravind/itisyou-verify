/**
 * Authenticated data export.
 *
 * Three things this file exists to stop:
 *
 *  1. **Another tenant's rows.** Every page is read with an explicit `workspaceId`, and
 *     every customer-scoped section carries `workspace_id` as a real column *so that this
 *     module can check it again after the read*. Checking a tenant predicate twice is not
 *     paranoia here: an export is the one feature whose whole job is to hand a file to a
 *     person, and a cross-tenant row in it is not a bug report, it is a breach.
 *
 *  2. **A credential, even masked.** Engineering rule 7 says stored credentials are never
 *     serialised back out. So the export works from a per-section **column allowlist** —
 *     a column nobody listed is not exported, including one added to the schema next
 *     month — and then re-checks the columns the port actually returned against a list of
 *     forbidden name shapes. A masked secret is still a secret's shape, its length, and
 *     the fact that it exists.
 *
 *  3. **A spreadsheet formula.** Every CSV cell goes through `csvCell` in this directory,
 *     which prefixes *and* quotes in one step. See `csv.ts` for why that is one function.
 *
 * Exports are cursor-paginated and size-capped. When the cap is reached the result says
 * `complete: false` and names the sections that were cut. It never silently truncates.
 */
import { AppError } from '@verify/contracts';
import { toIso } from '../lib/time';
import {
  EXPORT_SECTION,
  type ExportPage,
  type ExportSection,
  type ExportValue,
  type SupportDataPort,
} from '../support/port';
import { csvDocument, csvRow, type CsvValue } from './csv';

/* -------------------------------------------------------------------------- */
/* the column allowlist                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Exactly what each section exports, in order.
 *
 * A02's implementation must return these columns, in this order, and nothing else. This
 * module rejects a page whose columns do not match, so a repository that helpfully adds a
 * column fails loudly instead of leaking quietly.
 */
export const EXPORT_COLUMNS: Readonly<Record<ExportSection, readonly string[]>> = {
  workspace: ['id', 'name', 'status', 'retention_policy_version', 'created_at'],
  members: ['workspace_id', 'user_id', 'user_email', 'role', 'created_at'],
  workflows: ['id', 'workspace_id', 'name', 'status', 'coverage_mode', 'created_at', 'updated_at'],
  runs: [
    'id',
    'workspace_id',
    'workflow_id',
    'status',
    'observation_count',
    'deadline_at',
    'created_at',
    'completed_at',
  ],
  assertions: ['id', 'workspace_id', 'run_id', 'rule_id', 'status', 'reason_code', 'observed_at'],
  evidence: [
    'id',
    'workspace_id',
    'run_id',
    'provider',
    'origin',
    'provider_record_id',
    'observed_at',
    'content_digest',
    'redacted_summary',
    'expires_at',
  ],
  support_cases: [
    'id',
    'workspace_id',
    'subject',
    'body_redacted',
    'category',
    'priority',
    'state',
    'created_at',
    'updated_at',
  ],
  notifications: [
    'id',
    'workspace_id',
    'template',
    'state',
    'provider_status',
    'created_at',
    'sent_at',
  ],
  audit_events: [
    'id',
    'workspace_id',
    'actor_kind',
    'action',
    'target',
    'occurred_at',
    'redacted_metadata',
  ],
  billing: ['id', 'workspace_id', 'kind', 'status', 'amount_minor', 'currency', 'created_at'],
};

/** Sections whose rows must carry the requesting workspace id and are re-checked here. */
const TENANT_CHECKED_SECTIONS: readonly ExportSection[] = EXPORT_SECTION.filter((section) =>
  EXPORT_COLUMNS[section].includes('workspace_id'),
);

/**
 * Column name shapes that must never appear in an export, whatever the allowlist says.
 *
 * A second, independent check. If somebody adds `resend_api_key` to `EXPORT_COLUMNS` in a
 * hurry, this stops it reaching a file.
 */
export const FORBIDDEN_COLUMN_PATTERNS: readonly RegExp[] = [
  /secret/i,
  /credential/i,
  /password/i,
  /passphrase/i,
  /\btoken\b/i,
  /_token$/i,
  /api[_-]?key/i,
  /private[_-]?key/i,
  /cipher/i,
  /envelope/i,
  /\bnonce\b/i,
  /totp/i,
  /_hash$/i,
  /session/i,
];

export function isForbiddenColumn(name: string): boolean {
  return FORBIDDEN_COLUMN_PATTERNS.some((pattern) => pattern.test(name));
}

/** Provider key shapes, for a value-level assertion in the tests. */
const CREDENTIAL_VALUE_SHAPES: readonly RegExp[] = [
  /\b(?:sk|rk|pk|re|ghp|gho|xoxb|xoxp)_[A-Za-z0-9]{12,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
];

/** True when a value looks like a credential. Used by the export tests as a tripwire. */
export function containsCredentialShape(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return CREDENTIAL_VALUE_SHAPES.some((pattern) => pattern.test(value));
}

/* -------------------------------------------------------------------------- */
/* options and result                                                         */
/* -------------------------------------------------------------------------- */

export const EXPORT_LIMITS = {
  /** Rows per page. Small enough that one page is one bounded, indexed query. */
  PAGE_SIZE: 500,
  MAX_PAGE_SIZE: 1_000,
  /** Whole-export ceiling. Beyond this we stop and say the export is incomplete. */
  MAX_TOTAL_BYTES: 8 * 1024 * 1024,
  /** Per-section page ceiling, so one enormous table cannot spin the worker. */
  MAX_PAGES_PER_SECTION: 200,
} as const;

export type ExportFormat = 'json' | 'csv';

export interface ExportOptions {
  readonly workspaceId: string;
  readonly format: ExportFormat;
  /** Defaults to every section. */
  readonly sections?: readonly ExportSection[];
  readonly pageSize?: number;
  readonly maxTotalBytes?: number;
  readonly now?: Date;
}

export interface ExportFile {
  readonly name: string;
  readonly contentType: string;
  readonly body: string;
  readonly byteSize: number;
}

export interface SectionOutcome {
  readonly section: ExportSection;
  readonly rows: number;
  readonly complete: boolean;
}

export interface ExportResult {
  readonly workspaceId: string;
  readonly format: ExportFormat;
  readonly generatedAt: string;
  readonly files: readonly ExportFile[];
  readonly sections: readonly SectionOutcome[];
  readonly totalBytes: number;
  /** False when any section was cut short by a cap. */
  readonly complete: boolean;
  /** One sentence for the customer. Says "incomplete" when it is. */
  readonly statement: string;
}

const encoder = new TextEncoder();

function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/* -------------------------------------------------------------------------- */
/* page validation                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Prove a page is safe to write into a file the customer will open.
 *
 * Throws rather than filtering. A page that does not match the allowlist means the data
 * layer and this module disagree about what an export is, and guessing which one is right
 * is exactly the decision that ships a leak.
 */
export function assertPageIsExportable(
  page: ExportPage,
  section: ExportSection,
  workspaceId: string,
): void {
  if (page.section !== section) {
    throw new AppError(500, 'EXPORT_SECTION_MISMATCH', 'We could not build your export.');
  }

  const expected = EXPORT_COLUMNS[section];
  const sameColumns =
    page.columns.length === expected.length &&
    expected.every((name, index) => page.columns[index] === name);
  if (!sameColumns) {
    throw new AppError(500, 'EXPORT_COLUMNS_UNEXPECTED', 'We could not build your export.');
  }

  for (const name of page.columns) {
    if (isForbiddenColumn(name)) {
      throw new AppError(500, 'EXPORT_COLUMN_FORBIDDEN', 'We could not build your export.');
    }
  }

  const tenantIndex = page.columns.indexOf('workspace_id');
  for (const row of page.rows) {
    if (row.length !== page.columns.length) {
      throw new AppError(500, 'EXPORT_ROW_SHAPE', 'We could not build your export.');
    }
    if (tenantIndex >= 0 && row[tenantIndex] !== workspaceId) {
      // The one that matters. A row from another workspace reached us; refuse the whole
      // export rather than dropping the row and continuing as if nothing happened.
      throw new AppError(500, 'EXPORT_CROSS_TENANT_ROW', 'We could not build your export.');
    }
  }
}

/* -------------------------------------------------------------------------- */
/* the export                                                                 */
/* -------------------------------------------------------------------------- */

interface CollectedSection {
  readonly section: ExportSection;
  readonly rows: readonly (readonly ExportValue[])[];
  readonly complete: boolean;
}

async function collectSection(
  port: SupportDataPort,
  section: ExportSection,
  options: {
    readonly workspaceId: string;
    readonly pageSize: number;
    readonly remainingBytes: number;
  },
): Promise<CollectedSection> {
  const rows: (readonly ExportValue[])[] = [];
  let cursor: string | null = null;
  let pages = 0;
  let bytes = 0;

  while (pages < EXPORT_LIMITS.MAX_PAGES_PER_SECTION) {
    const page: ExportPage = await port.readExportPage({
      workspaceId: options.workspaceId,
      section,
      cursor,
      limit: options.pageSize,
    });
    assertPageIsExportable(page, section, options.workspaceId);
    pages += 1;

    for (const row of page.rows) {
      const rowBytes = byteLength(csvRow(row as readonly CsvValue[]));
      if (bytes + rowBytes > options.remainingBytes) {
        return { section, rows, complete: false };
      }
      bytes += rowBytes;
      rows.push(row);
    }

    if (page.nextCursor === null) return { section, rows, complete: true };
    cursor = page.nextCursor;
  }

  return { section, rows, complete: false };
}

/**
 * NEW WORDING (A09): A01 wrote no export copy. Flagged in the handoff.
 */
const COMPLETE_STATEMENT =
  'This is everything we hold for this workspace, apart from stored provider credentials, which are never exported in any form, not even masked.';
const INCOMPLETE_STATEMENT =
  'This export reached its size limit before everything was written, so it is not complete. The sections that were cut short are named above. Ask us and we will send the rest.';

/**
 * Build an export for one workspace.
 *
 * `workspaceId` must already have been resolved from the session by the caller. This
 * function never takes a workspace id from a request.
 */
export async function buildExport(
  port: SupportDataPort,
  options: ExportOptions,
): Promise<ExportResult> {
  if (typeof options.workspaceId !== 'string' || options.workspaceId.length === 0) {
    throw new AppError(400, 'EXPORT_WORKSPACE_REQUIRED', 'We could not build your export.');
  }

  const now = options.now ?? new Date();
  const generatedAt = toIso(now);
  const pageSize = Math.min(
    EXPORT_LIMITS.MAX_PAGE_SIZE,
    Math.max(1, Math.trunc(options.pageSize ?? EXPORT_LIMITS.PAGE_SIZE)),
  );
  const maxTotalBytes = Math.max(
    1_024,
    Math.trunc(options.maxTotalBytes ?? EXPORT_LIMITS.MAX_TOTAL_BYTES),
  );
  const sections = options.sections ?? EXPORT_SECTION;

  const collected: CollectedSection[] = [];
  let usedBytes = 0;

  for (const section of sections) {
    const result = await collectSection(port, section, {
      workspaceId: options.workspaceId,
      pageSize,
      remainingBytes: Math.max(0, maxTotalBytes - usedBytes),
    });
    collected.push(result);
    usedBytes += result.rows.reduce(
      (sum, row) => sum + byteLength(csvRow(row as readonly CsvValue[])),
      0,
    );
  }

  const files =
    options.format === 'csv'
      ? toCsvFiles(collected)
      : [toJsonFile(collected, options.workspaceId, generatedAt)];

  const totalBytes = files.reduce((sum, file) => sum + file.byteSize, 0);
  const complete = collected.every((c) => c.complete);

  return {
    workspaceId: options.workspaceId,
    format: options.format,
    generatedAt,
    files,
    sections: collected.map((c) => ({
      section: c.section,
      rows: c.rows.length,
      complete: c.complete,
    })),
    totalBytes,
    complete,
    statement: complete ? COMPLETE_STATEMENT : INCOMPLETE_STATEMENT,
  };
}

function toCsvFiles(collected: readonly CollectedSection[]): readonly ExportFile[] {
  return collected.map((c) => {
    const header = EXPORT_COLUMNS[c.section];
    const body = csvDocument([header, ...(c.rows as readonly (readonly CsvValue[])[])]);
    return {
      name: `${c.section}.csv`,
      contentType: 'text/csv; charset=utf-8',
      body,
      byteSize: byteLength(body),
    };
  });
}

function toJsonFile(
  collected: readonly CollectedSection[],
  workspaceId: string,
  generatedAt: string,
): ExportFile {
  const sections: Record<string, unknown> = {};
  for (const c of collected) {
    const columns = EXPORT_COLUMNS[c.section];
    sections[c.section] = {
      complete: c.complete,
      rows: c.rows.map((row) => {
        const object: Record<string, ExportValue> = {};
        columns.forEach((name, index) => {
          object[name] = row[index] ?? null;
        });
        return object;
      }),
    };
  }
  const body = `${JSON.stringify(
    {
      export_version: 1,
      workspace_id: workspaceId,
      generated_at: generatedAt,
      note: COMPLETE_STATEMENT,
      sections,
    },
    null,
    2,
  )}\n`;
  return {
    name: 'export.json',
    contentType: 'application/json; charset=utf-8',
    body,
    byteSize: byteLength(body),
  };
}

/** Exported for the tenant-scope tests, which assert the list is not empty. */
export const TENANT_CHECKED = TENANT_CHECKED_SECTIONS;
