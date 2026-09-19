/**
 * The two D1 ports the money path needs.
 *
 * These implementations used to live here, because `SEC-201` forbids SQL outside
 * `apps/app/src/db/` and their author did not own that directory. On 19 September 2026
 * they moved there verbatim, which is what closed the gap this file used to document:
 * the algorithms were proved against the real schema, but production implemented the
 * port nowhere, so "the reconciliation runs in production" was false.
 *
 * This file is now a re-export and nothing else. It exists so the money tests keep their
 * import path, and so that anyone who opens it looking for the SQL is told where it went
 * rather than finding a second copy to drift against the first.
 */
export { D1AllowanceRepair } from '@app/db/allowanceRepair';
export { D1WorkflowSigningKeys, createWorkflowSigningKeyStore } from '@app/db/workflowSigningKeys';
