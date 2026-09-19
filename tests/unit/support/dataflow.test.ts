/**
 * API-3xx — the machine-readable data-flow inventory.
 *
 * The privacy page renders this. If it drifts from A01's published prose, or from the
 * system as built, the page becomes a statement of intent — and a privacy page that is a
 * statement of intent is the thing regulators and customers both call a lie.
 */
import { describe, expect, it } from 'vitest';
import { DATA_FLOW, SUBPROCESSORS } from '@verify/ui';
import {
  CUSTOMER_REQUESTS,
  DATA_FLOW_EDGES,
  DATA_FLOW_NODES,
  nodeById,
  publishedDataFlow,
  publishedSubprocessors,
} from '@app/privacy/dataflow';

describe('data-flow inventory', () => {
  it('API-320 every stage A01 published has a structured node', () => {
    expect(DATA_FLOW.length).toBeGreaterThan(0);
    for (const paired of publishedDataFlow()) {
      expect(paired.node, `no node for published stage: ${paired.stage}`).toBeDefined();
    }
  });

  it('API-321 every subprocessor A01 published has a structured node', () => {
    expect(SUBPROCESSORS.length).toBeGreaterThan(0);
    for (const paired of publishedSubprocessors()) {
      expect(paired.node, `no node for subprocessor: ${paired.name}`).toBeDefined();
    }
  });

  it('API-322 the optional model provider is off by default and is the only optional node', () => {
    const optional = DATA_FLOW_NODES.filter((n) => !n.enabledByDefault);
    expect(optional.map((n) => n.id)).toEqual(['model_provider']);
    expect(nodeById('model_provider')?.kind).toBe('optional_subprocessor');
  });

  it('API-323 no node claims a certification, an approval or a guarantee', () => {
    const banned = /\b(iso ?27001|soc ?2|certified|accredited|approved by|guarantee)\b/i;
    for (const node of DATA_FLOW_NODES) {
      const text = `${node.purpose} ${node.whatWeSend} ${node.whatWeReceive}`;
      expect(banned.test(text), node.id).toBe(false);
    }
  });

  it('API-324 a third party’s processing region is stated as provider-determined, not invented', () => {
    for (const node of DATA_FLOW_NODES) {
      if (node.kind === 'subprocessor' || node.kind === 'optional_subprocessor') {
        expect(node.region, node.id).toBe('provider_determined');
      }
    }
    expect(nodeById('workers_d1')?.region).toBe('eu_west');
  });

  it('API-325 every edge joins two declared nodes over HTTPS', () => {
    for (const edge of DATA_FLOW_EDGES) {
      expect(nodeById(edge.from), edge.from).toBeDefined();
      expect(nodeById(edge.to), edge.to).toBeDefined();
      expect(edge.transport).toBe('https');
      expect(edge.trigger.length).toBeGreaterThan(10);
    }
  });

  it('API-326 the customer-request list covers a copy of the data, deletion and a complaint', () => {
    const ids = CUSTOMER_REQUESTS.map((r) => r.id);
    expect(ids).toContain('copy_of_data');
    expect(ids).toContain('deletion');
    expect(ids).toContain('complain');
    for (const request of CUSTOMER_REQUESTS) {
      expect(request.howToAsk.length, request.id).toBeGreaterThan(10);
      expect(request.whatHappens.length, request.id).toBeGreaterThan(30);
    }
  });

  it('API-327 the export request promises no credential, in any form', () => {
    const copy = CUSTOMER_REQUESTS.find((r) => r.id === 'copy_of_data');
    expect(copy?.whatHappens).toMatch(/never contains a stored provider credential/i);
  });
});
