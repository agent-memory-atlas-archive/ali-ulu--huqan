'use strict';

/**
 * Deterministic Router tests (#2395, design #2384).
 *
 * Hermetic: no I/O, no storage, no timers. Implements acceptance tests 1-7
 * from the end of #2384's design comment. Acceptance test 8
 * (`check:deterministic-path` failing the build on a fixture that requires
 * llmAdapter.js) is covered separately in
 * test/check-deterministic-path.test.js, against the actual CI script.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { decideRoute, REFUSAL_REASONS } = require('../lib/experience/router');

function candidate(overrides = {}) {
  return {
    capabilityId: 'cap-a',
    preconditions: { fileType: 'js' },
    trustState: 'trusted',
    boundProcedureVersion: 'v1',
    trustSnapshotVersion: 'snap-1',
    ...overrides,
  };
}

describe('Deterministic Router: acceptance tests (#2384)', () => {
  it('1. identical request + snapshot, run twice -> identical routing_decided output', () => {
    const args = {
      requestId: 'req-1',
      request: { declared: { fileType: 'js' } },
      candidates: [candidate()],
      trustSnapshotVersion: 'snap-1',
    };
    const a = decideRoute(args);
    const b = decideRoute(args);
    assert.deepEqual(a.decision, b.decision);
    assert.equal(JSON.stringify(a.decision), JSON.stringify(b.decision));
  });

  it('2. more specific match wins regardless of trust rung', () => {
    const generic = candidate({ capabilityId: 'cap-generic', preconditions: { fileType: 'js' }, trustState: 'trusted' });
    const specific = candidate({
      capabilityId: 'cap-specific',
      preconditions: { fileType: 'js', action: 'replace_text' },
      trustState: 'probationary',
    });
    const res = decideRoute({
      requestId: 'req-2',
      request: { declared: { fileType: 'js', action: 'replace_text' } },
      candidates: [generic, specific],
    });
    assert.equal(res.decision.chosenCapabilityId, 'cap-specific');
  });

  it('3. tied on specificity, different trust rungs -> trusted wins', () => {
    const trusted = candidate({ capabilityId: 'cap-trusted', trustState: 'trusted' });
    const probation = candidate({ capabilityId: 'cap-probation', trustState: 'probationary' });
    const res = decideRoute({
      requestId: 'req-3',
      request: { declared: { fileType: 'js' } },
      candidates: [probation, trusted],
    });
    assert.equal(res.decision.chosenCapabilityId, 'cap-trusted');
  });

  it('4. full tie -> resolved by capabilityId lexicographic order', () => {
    const b = candidate({ capabilityId: 'cap-b', trustState: 'trusted' });
    const a = candidate({ capabilityId: 'cap-a', trustState: 'trusted' });
    const res = decideRoute({
      requestId: 'req-4',
      request: { declared: { fileType: 'js' } },
      candidates: [b, a],
    });
    assert.equal(res.decision.chosenCapabilityId, 'cap-a');
  });

  it('5. zero structural matches -> refusal recorded with no_structural_match, no fallback', () => {
    const res = decideRoute({
      requestId: 'req-5',
      request: { declared: { fileType: 'py' } },
      candidates: [candidate({ preconditions: { fileType: 'js' } })],
    });
    assert.equal(res.decision.chosenCapabilityId, null);
    assert.equal(res.decision.refusalReason, REFUSAL_REASONS.NO_STRUCTURAL_MATCH);
  });

  it('6. all matches demoted -> refusal recorded with no_eligible_match', () => {
    const res = decideRoute({
      requestId: 'req-6',
      request: { declared: { fileType: 'js' } },
      candidates: [candidate({ trustState: 'demoted' })],
    });
    assert.equal(res.decision.chosenCapabilityId, null);
    assert.equal(res.decision.refusalReason, REFUSAL_REASONS.NO_ELIGIBLE_MATCH);
    // demoted candidates are excluded from candidacy, not ranked last.
    assert.equal(res.decision.candidatesConsidered[0].trustRung, null);
  });

  it('7. trust rung changes between requests -> different trustSnapshotVersion, decision may differ', () => {
    const base = {
      requestId: 'req-7',
      request: { declared: { fileType: 'js' } },
      candidates: [candidate({ capabilityId: 'cap-a', trustState: 'probationary' }),
        candidate({ capabilityId: 'cap-b', trustState: 'probationary' })],
    };
    const before = decideRoute({ ...base, trustSnapshotVersion: 'snap-1' });
    const after = decideRoute({
      ...base,
      trustSnapshotVersion: 'snap-2',
      candidates: [candidate({ capabilityId: 'cap-a', trustState: 'probationary', trustSnapshotVersion: 'snap-2' }),
        candidate({ capabilityId: 'cap-b', trustState: 'trusted', trustSnapshotVersion: 'snap-2' })],
    });
    assert.equal(before.decision.trustSnapshotVersion, 'snap-1');
    assert.equal(after.decision.trustSnapshotVersion, 'snap-2');
    // Same request, different snapshot -> a legitimately different winner,
    // attributable to trustSnapshotVersion alone.
    assert.equal(before.decision.chosenCapabilityId, 'cap-a'); // lexicographic tie
    assert.equal(after.decision.chosenCapabilityId, 'cap-b'); // trust rung now decides
  });
});

describe('Deterministic Router: structural matching', () => {
  it('subset preconditions match a superset request', () => {
    const res = decideRoute({
      requestId: 'req-8',
      request: { declared: { fileType: 'js', action: 'replace_text', extra: true } },
      candidates: [candidate({ preconditions: { fileType: 'js' } })],
    });
    assert.equal(res.decision.chosenCapabilityId, 'cap-a');
  });

  it('a precondition value mismatch fails structural match', () => {
    const res = decideRoute({
      requestId: 'req-9',
      request: { declared: { fileType: 'py' } },
      candidates: [candidate({ preconditions: { fileType: 'js' } })],
    });
    assert.equal(res.decision.refusalReason, REFUSAL_REASONS.NO_STRUCTURAL_MATCH);
  });
});
