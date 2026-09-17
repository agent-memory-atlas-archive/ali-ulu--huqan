'use strict';

// DelegationService v0 (#2505/E1): validation-only boundary. A delegation
// plan is evaluated, never executed here: existing execution paths are
// untouched in this slice, and the guard's run() is not called.

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { createDelegationService, DEFAULT_MAX_FAN_OUT } = require('../lib/delegation-service');

const task = (id, agentId = 'agent-a', dependsOn = []) => ({ id, agentId, dependsOn });

describe('DelegationService v0 plan validation', () => {
  it('accepts a well-formed plan and reports its shape', () => {
    const service = createDelegationService();
    const verdict = service.evaluatePlan([
      task('t1'),
      task('t2', 'agent-b', ['t1']),
    ]);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.reason, 'DELEGATION_PLAN_VALID');
    assert.equal(verdict.taskCount, 2);
    assert.equal(verdict.rootCount, 1);
    assert.equal(verdict.maxFanOut, DEFAULT_MAX_FAN_OUT);
    assert.deepEqual(verdict.tasks, [
      { id: 't1', agentId: 'agent-a', dependsOn: [] },
      { id: 't2', agentId: 'agent-b', dependsOn: ['t1'] },
    ]);
    assert.ok(Object.isFrozen(verdict));
  });

  it('rejects root fan-out above the configured bound without executing anything', () => {
    const service = createDelegationService({ maxFanOut: 1 });
    const verdict = service.evaluatePlan([task('t1'), task('t2')]);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'INVALID_PLAN');
    assert.match(verdict.error, /root fan-out exceeds 1/);
    assert.deepEqual(verdict.tasks, []);
  });

  it('rejects cycles, unknown dependencies, duplicates and self-dependency', () => {
    const service = createDelegationService();
    for (const [label, plan] of [
      ['cycle', [task('t1', 'a', ['t2']), task('t2', 'a', ['t1'])]],
      ['unknown', [task('t1', 'a', ['ghost'])]],
      ['duplicate', [task('t1'), task('t1')]],
      ['self', [task('t1', 'a', ['t1'])]],
      ['empty', []],
      ['missing', null],
    ]) {
      const verdict = service.evaluatePlan(plan);
      assert.equal(verdict.ok, false, label);
      assert.equal(verdict.reason, 'INVALID_PLAN', label);
      assert.ok(verdict.error.length > 0, label);
    }
  });

  it('rejects a malformed service configuration up front', () => {
    for (const options of [null, 4, 'x', { maxFanOut: 0 }, { maxFanOut: 65 }, { maxFanOut: 1.5 }]) {
      assert.throws(() => createDelegationService(options), TypeError);
    }
  });

  it('never calls the guard run path: evaluation has no executor', () => {
    const service = createDelegationService();
    assert.equal(typeof service.run, 'undefined');
    assert.equal(typeof service.evaluatePlan, 'function');
  });
});
