/**
 * The test that would have caught it.
 *
 * `independently_sourced` shipped as a selectable coverage mode, with a confident headline
 * — "We find the enquiries ourselves." — and nothing behind it. No connector can enumerate
 * records it was never told about; no scheduler pass reconciles anything. A customer could
 * choose it and be told that silence meant nothing had gone wrong.
 *
 * The defect was not the wording. It was that a *claim* in one package had no *implementation*
 * in another, and nothing in the build tied the two together. So this file ties them: it takes
 * each coverage mode's declared requirements and checks them against the real connector
 * capabilities and the real list of scheduler passes.
 *
 * It fails in both directions, which is what makes it useful:
 *  - mark a mode selectable without building it, and this fails;
 *  - build it and forget to mark it supported, and this fails too.
 */
import { describe, expect, it } from 'vitest';
import { COVERAGE_MODE, type CoverageMode } from '@verify/contracts';
import {
  COVERAGE_MODE_REQUIREMENTS,
  COVERAGE_MODE_SUPPORT,
  SELECTABLE_COVERAGE_MODES,
  describeCoverage,
} from '@verify/domain';
import { SUPPORTED_PROVIDERS, getConnector, type ConnectorCapabilities } from '@verify/connectors';
import { IMPLEMENTED_SCHEDULER_PASSES } from '@app/scheduler';

/** Every capability flag any shipped connector actually declares as true. */
function declaredCapabilities(): ReadonlySet<string> {
  const declared = new Set<string>();
  for (const provider of SUPPORTED_PROVIDERS) {
    const capabilities = getConnector(provider).capabilities() as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(capabilities)) {
      if (value === true) declared.add(key);
    }
  }
  return declared;
}

/** Can anything in this codebase actually deliver this mode, computed from scratch? */
function deliverable(mode: CoverageMode): boolean {
  const requirement = COVERAGE_MODE_REQUIREMENTS[mode];
  const passExists = (IMPLEMENTED_SCHEDULER_PASSES as readonly string[]).includes(requirement.scheduler_pass);
  const capabilityExists =
    requirement.connector_capability === null || declaredCapabilities().has(requirement.connector_capability);
  return passExists && capabilityExists;
}

describe('coverage modes are bound to real capabilities', () => {
  it('VERIFY-206 every selectable coverage mode has a scheduler pass that exists', () => {
    for (const mode of SELECTABLE_COVERAGE_MODES) {
      const requirement = COVERAGE_MODE_REQUIREMENTS[mode];
      expect(
        (IMPLEMENTED_SCHEDULER_PASSES as readonly string[]).includes(requirement.scheduler_pass),
        `coverage mode "${mode}" is offered but its scheduler pass "${requirement.scheduler_pass}" does not exist`,
      ).toBe(true);
    }
  });

  it('VERIFY-207 every selectable coverage mode has a connector capability that exists', () => {
    const declared = declaredCapabilities();
    for (const mode of SELECTABLE_COVERAGE_MODES) {
      const required = COVERAGE_MODE_REQUIREMENTS[mode].connector_capability;
      if (required === null) continue;
      expect(
        declared.has(required),
        `coverage mode "${mode}" is offered but no connector declares "${required}"`,
      ).toBe(true);
    }
  });

  it('VERIFY-208 declared support matches what the code can actually deliver, in both directions', () => {
    for (const mode of COVERAGE_MODE) {
      expect(
        COVERAGE_MODE_SUPPORT[mode].supported,
        `coverage mode "${mode}" claims supported=${COVERAGE_MODE_SUPPORT[mode].supported} but the code says ${deliverable(mode)}`,
      ).toBe(deliverable(mode));
    }
  });

  it('VERIFY-209 no connector can enumerate records it was never told about', () => {
    // The specific, load-bearing absence. HubSpot has three read operations and the closest,
    // contact_search, answers "is this specific record there" — never "what exists".
    expect(declaredCapabilities().has('can_enumerate_records')).toBe(false);
    for (const provider of SUPPORTED_PROVIDERS) {
      const capabilities = getConnector(provider).capabilities();
      expect(capabilities.can_search_by_correlation || capabilities.can_read_by_id).toBe(true);
      // A correlation search is a lookup, not enumeration. If a connector ever gains real
      // enumeration it must say so with a new flag, and VERIFY-208 will then demand the
      // scheduler pass before the mode can be offered.
      expect(Object.keys(capabilities)).not.toContain('can_enumerate_records');
    }
  });

  it('VERIFY-210 no connector writes to a customer system, as a type and as a value', () => {
    for (const provider of SUPPORTED_PROVIDERS) {
      const capabilities: ConnectorCapabilities = getConnector(provider).capabilities();
      expect(capabilities.writes_to_customer_system).toBe(false);
    }
  });

  it('VERIFY-211 there is no enumeration pass in the scheduler', () => {
    expect(IMPLEMENTED_SCHEDULER_PASSES).not.toContain('enumeration');
    expect(IMPLEMENTED_SCHEDULER_PASSES).toContain('due_job');
  });

  it('VERIFY-212 a workflow carrying the unsupported mode is described honestly, not as configured', () => {
    // The restored-backup case: the row exists even though onboarding can no longer produce it.
    const coverage = describeCoverage({ coverage_mode: 'independently_sourced' });
    expect(coverage.supported).toBe(false);
    expect(coverage.can_detect_missing_runs).toBe(false);
    expect(coverage.warning?.severity).toBe('critical');
  });
});
