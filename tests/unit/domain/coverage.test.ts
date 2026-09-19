import { describe, expect, it } from 'vitest';
import {
  COVERAGE_MODE_REQUIREMENTS,
  COVERAGE_MODE_SUPPORT,
  SELECTABLE_COVERAGE_MODES,
  SUPPORTED_COVERAGE_MODES,
  coverageModeSupport,
  coverageWarningFor,
  describeCoverage,
  detectInactivity,
  effectiveCoverageMode,
  isCoverageModeSupported,
  summariseWorkflowHealth,
} from '@verify/domain';
import { COVERAGE_MODE } from '@verify/contracts';
import { T_EVENT, dateAfter, makeWorkflowRules } from '../../fixtures/index.js';

const EXPECTED_ACTIVITY = { window_seconds: 86_400, minimum_events: 1 } as const;

describe('describeCoverage', () => {
  it('VERIFY-175 a customer-triggered workflow admits it cannot see a run that never started', () => {
    const coverage = describeCoverage(makeWorkflowRules({ coverage_mode: 'customer_triggered' }));
    expect(coverage.mode).toBe('customer_triggered');
    expect(coverage.can_detect_missing_runs).toBe(false);
    expect(coverage.limitation).toContain('we receive nothing');
    expect(coverage.limitation).toContain('not the same as everything passing');
  });

  it('VERIFY-176 an independently sourced workflow degrades to the coverage we actually have', () => {
    const coverage = describeCoverage(makeWorkflowRules({ coverage_mode: 'independently_sourced' }));
    // The mode is not implemented, so the description is of what we really do.
    expect(coverage.requested_mode).toBe('independently_sourced');
    expect(coverage.mode).toBe('customer_triggered');
    expect(coverage.supported).toBe(false);
    expect(coverage.can_detect_missing_runs).toBe(false);
  });

  it('VERIFY-196 no workflow can make us claim we find enquiries ourselves', () => {
    // The sentence that made the promise. While the mode is unimplemented, no input to
    // describeCoverage may produce it.
    for (const mode of COVERAGE_MODE) {
      const coverage = describeCoverage({ coverage_mode: mode });
      expect(coverage.headline).not.toContain('find the enquiries ourselves');
      expect(coverage.can_detect_missing_runs).toBe(false);
    }
  });

  it('VERIFY-197 an unsupported mode carries a critical warning, not a quiet degrade', () => {
    const coverage = describeCoverage({ coverage_mode: 'independently_sourced' });
    expect(coverage.warning).not.toBeNull();
    expect(coverage.warning?.code).toBe('COVERAGE_MODE_UNSUPPORTED');
    expect(coverage.warning?.severity).toBe('critical');
    expect(coverage.warning?.requested_mode).toBe('independently_sourced');
    expect(coverage.warning?.effective_mode).toBe('customer_triggered');
    expect(coverage.warning?.detail).toContain('will not show up here as a problem');
  });

  it('VERIFY-198 a supported mode carries no warning', () => {
    expect(describeCoverage({ coverage_mode: 'customer_triggered' }).warning).toBeNull();
    expect(coverageWarningFor('customer_triggered')).toBeNull();
  });

  it('VERIFY-177 both coverage modes state a limitation rather than implying total coverage', () => {
    for (const mode of COVERAGE_MODE) {
      const coverage = describeCoverage({ coverage_mode: mode });
      expect(coverage.limitation).not.toBeNull();
      expect((coverage.limitation ?? '').length).toBeGreaterThan(20);
    }
  });
});

describe('coverage mode support', () => {
  it('VERIFY-199 customer_triggered is supported and selectable', () => {
    const support = coverageModeSupport('customer_triggered');
    expect(support.supported).toBe(true);
    expect(support.selectable).toBe(true);
    expect(support.unavailable_reason).toBeNull();
    expect(isCoverageModeSupported('customer_triggered')).toBe(true);
  });

  it('VERIFY-200 independently_sourced is neither supported nor selectable', () => {
    const support = coverageModeSupport('independently_sourced');
    expect(support.supported).toBe(false);
    expect(support.selectable).toBe(false);
    expect(isCoverageModeSupported('independently_sourced')).toBe(false);
    expect(SELECTABLE_COVERAGE_MODES).not.toContain('independently_sourced');
    expect(SUPPORTED_COVERAGE_MODES).not.toContain('independently_sourced');
  });

  it('VERIFY-201 the unavailable reason says what we cannot do, in the customer’s words', () => {
    const support = coverageModeSupport('independently_sourced');
    expect(support.unavailable_reason).not.toBeNull();
    expect(support.unavailable_reason ?? '').toContain('we have not built that');
    expect(support.requires.length).toBeGreaterThan(0);
  });

  it('VERIFY-202 the mode stays in the contract even though it cannot be offered', () => {
    // Keeping the enum matters: it is a real planned capability and dropping it would lose
    // the migration path. What must not survive is its selectability.
    expect(COVERAGE_MODE).toContain('independently_sourced');
    expect(Object.keys(COVERAGE_MODE_SUPPORT).sort()).toEqual([...COVERAGE_MODE].sort());
    expect(Object.keys(COVERAGE_MODE_REQUIREMENTS).sort()).toEqual([...COVERAGE_MODE].sort());
  });

  it('VERIFY-203 nothing may be selectable without being supported', () => {
    for (const support of Object.values(COVERAGE_MODE_SUPPORT)) {
      if (support.selectable) expect(support.supported).toBe(true);
    }
  });

  it('VERIFY-204 every mode declares what would have to exist before it could be offered', () => {
    for (const mode of COVERAGE_MODE) {
      const requirement = COVERAGE_MODE_REQUIREMENTS[mode];
      expect(requirement.mode).toBe(mode);
      expect(requirement.scheduler_pass.length).toBeGreaterThan(0);
    }
  });

  it('VERIFY-205 an unsupported mode degrades to the coverage we do have, never the reverse', () => {
    expect(effectiveCoverageMode('independently_sourced')).toBe('customer_triggered');
    expect(effectiveCoverageMode('customer_triggered')).toBe('customer_triggered');
    for (const mode of COVERAGE_MODE) {
      expect(isCoverageModeSupported(effectiveCoverageMode(mode))).toBe(true);
    }
  });
});

describe('detectInactivity', () => {
  it('VERIFY-178 never having received an enquiry is a distinct warning, not silence', () => {
    const report = detectInactivity({
      lastEventAt: null,
      expectedActivity: EXPECTED_ACTIVITY,
      now: T_EVENT,
    });
    expect(report.inactive).toBe(true);
    expect(report.severity).toBe('warning');
    expect(report.seconds_since_last_event).toBeNull();
    expect(report.detail).toContain('no result here should be read as a pass');
  });

  it('VERIFY-179 a quiet period longer than expected raises an inactivity warning', () => {
    const report = detectInactivity({
      lastEventAt: T_EVENT,
      expectedActivity: EXPECTED_ACTIVITY,
      now: dateAfter(T_EVENT, 86_401),
    });
    expect(report.inactive).toBe(true);
    expect(report.severity).toBe('warning');
    expect(report.headline).toContain('longer than expected');
  });

  it('VERIFY-180 the inactivity warning does not claim to know why it went quiet', () => {
    const report = detectInactivity({
      lastEventAt: T_EVENT,
      expectedActivity: EXPECTED_ACTIVITY,
      now: dateAfter(T_EVENT, 200_000),
    });
    expect(report.detail).toContain('We cannot tell which from here');
  });

  it('VERIFY-181 activity inside the expected window is not a warning', () => {
    const report = detectInactivity({
      lastEventAt: T_EVENT,
      expectedActivity: EXPECTED_ACTIVITY,
      now: dateAfter(T_EVENT, 600),
    });
    expect(report.inactive).toBe(false);
    expect(report.severity).toBe('none');
    expect(report.seconds_since_last_event).toBe(600);
  });

  it('VERIFY-182 fewer events than expected inside the window is its own warning', () => {
    const report = detectInactivity({
      lastEventAt: T_EVENT,
      expectedActivity: { window_seconds: 86_400, minimum_events: 5 },
      now: dateAfter(T_EVENT, 600),
      eventsInWindow: 2,
    });
    expect(report.inactive).toBe(true);
    expect(report.detail).toContain('Missing events are not visible as failures');
  });

  it('VERIFY-183 the boundary second of the expected window is still considered active', () => {
    const report = detectInactivity({
      lastEventAt: T_EVENT,
      expectedActivity: EXPECTED_ACTIVITY,
      now: dateAfter(T_EVENT, 86_400),
    });
    expect(report.inactive).toBe(false);
  });
});

describe('summariseWorkflowHealth', () => {
  it('VERIFY-184 zero received runs is its own state and never renders as a perfect score', () => {
    const health = summariseWorkflowHealth({ verified: 0, failed: 0, unverified: 0, pending: 0 });
    expect(health.state).toBe('no_runs_received');
    expect(health.verified_percentage).toBeNull();
    expect(health.verified_percentage).not.toBe(100);
    expect(health.headline).toBe('No runs received yet');
    expect(health.detail).toContain('An empty workflow is not a passing workflow');
  });

  it('VERIFY-185 runs that are all still pending do not count as passes', () => {
    const health = summariseWorkflowHealth({ verified: 0, failed: 0, unverified: 0, pending: 7 });
    expect(health.state).toBe('awaiting_first_result');
    expect(health.verified_percentage).toBeNull();
    expect(health.total_runs).toBe(7);
    expect(health.decided_runs).toBe(0);
  });

  it('VERIFY-186 a clean workflow reports 100% only when decided runs actually verified', () => {
    const health = summariseWorkflowHealth({ verified: 12, failed: 0, unverified: 0, pending: 3 });
    expect(health.state).toBe('healthy');
    expect(health.verified_percentage).toBe(100);
    expect(health.decided_runs).toBe(12);
    expect(health.total_runs).toBe(15);
  });

  it('VERIFY-187 any failure degrades the workflow regardless of the pass rate', () => {
    const health = summariseWorkflowHealth({ verified: 99, failed: 1, unverified: 0, pending: 0 });
    expect(health.state).toBe('degraded');
    expect(health.verified_percentage).toBe(99);
    expect(health.headline).toContain('1 run failed');
  });

  it('VERIFY-188 unverified runs raise attention without being reported as failures', () => {
    const health = summariseWorkflowHealth({ verified: 8, failed: 0, unverified: 2, pending: 0 });
    expect(health.state).toBe('attention');
    expect(health.detail).toContain('not that your automation failed');
  });

  it('VERIFY-189 the pass rate is computed over decided runs, never over pending ones', () => {
    const health = summariseWorkflowHealth({ verified: 1, failed: 1, unverified: 0, pending: 98 });
    expect(health.decided_runs).toBe(2);
    expect(health.verified_percentage).toBe(50);
  });
});
