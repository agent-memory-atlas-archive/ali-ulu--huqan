'use strict';

/**
 * Experience Phase 6 — procedure compiler tests (#2392).
 *
 * Hermetic: injected fakes only, no I/O, no storage, no timers.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { compile, qualify } = require('../lib/experience/compiler');

function candidate(overrides = {}) {
  return {
    status: 'candidate',
    runId: 'run-1',
    trace: { sources: ['hash-abc'], scope: { workspaceId: 'ws' }, revision: 'e1' },
    ...overrides,
  };
}

function params(overrides = {}) {
  return { path: 'a.txt', oldText: 'foo', newText: 'bar', ...overrides };
}

// Fake file world: apply replaces when exactly one site matches.
function fakeWorld(files) {
  return {
    observe: (input) => {
      if (!(input in files)) throw new Error('missing file');
      return files[input];
    },
    apply: (procedure, input) => {
      const content = files[input];
      const sites = content.split(procedure.params.oldText).length - 1;
      return { sites, after: content.split(procedure.params.oldText).join(procedure.params.newText) };
    },
  };
}

describe('Phase 6: compilation is typed and versioned', () => {
  it('compiles a traced candidate with immutable version and hash', () => {
    const res = compile({ candidate: candidate(), kind: 'replace_text', params: params() });
    assert.equal(res.ok, true);
    assert.equal(res.procedure.version, 1);
    assert.match(res.procedure.hash, /^[0-9a-f]{64}$/u);
    assert.deepEqual(res.procedure.evidenceRefs, ['hash-abc']);
    assert.ok(Object.isFrozen(res.procedure));
  });

  it('new versions chain without touching the old', () => {
    const v1 = compile({ candidate: candidate(), kind: 'replace_text', params: params() }).procedure;
    const v2 = compile({
      candidate: candidate(), kind: 'replace_text', params: params({ newText: 'baz' }),
      parentVersion: 1,
    });
    // parentHash binds the chain; here the candidate carries no hash yet.
    assert.equal(v2.ok, true);
    assert.equal(v2.procedure.version, 2);
    assert.notEqual(v2.procedure.hash, v1.hash);
    assert.equal(v1.version, 1);
  });

  it('non-candidates, missing traces, bad params and kinds are refused', () => {
    assert.deepEqual(compile({ candidate: { status: 'draft' }, kind: 'replace_text', params: params() }),
      { ok: false, code: 'not_a_candidate' });
    assert.deepEqual(
      compile({ candidate: candidate({ trace: null }), kind: 'replace_text', params: params() }),
      { ok: false, code: 'missing_trace' });
    assert.deepEqual(compile({ candidate: candidate(), kind: 'replace_text', params: params({ oldText: '' }) }),
      { ok: false, code: 'bad_params' });
    assert.deepEqual(compile({ candidate: candidate(), kind: 'teleport', params: params() }),
      { ok: false, code: 'unknown_kind' });
  });
});

describe('Phase 6: qualification runs new inputs, never the source copy', () => {
  it('qualifies on held-out inputs that satisfy pre and postconditions', () => {
    const { procedure } = compile({ candidate: candidate(), kind: 'replace_text', params: params() });
    const world = fakeWorld({ 'new-1.txt': 'foo x', 'new-2.txt': 'y foo' });
    const res = qualify({ procedure, inputs: ['new-1.txt', 'new-2.txt'], ...world });
    assert.equal(res.ok, true);
    assert.equal(res.qualified, true);
    assert.equal(res.procedureHash, procedure.hash);
  });

  it('ambiguous matches reject instead of guessing', () => {
    const { procedure } = compile({ candidate: candidate(), kind: 'replace_text', params: params() });
    const world = fakeWorld({ 'amb.txt': 'foo foo' });
    const res = qualify({ procedure, inputs: ['amb.txt'], ...world });
    assert.equal(res.ok, false);
    assert.match(res.code, /^qualify_rejected:ambiguous$/u);
  });

  it('environment drift rejects instead of forcing', () => {
    const { procedure } = compile({ candidate: candidate(), kind: 'replace_text', params: params() });
    const world = fakeWorld({ 'drift.txt': 'nothing here' });
    const res = qualify({ procedure, inputs: ['drift.txt'], ...world });
    assert.equal(res.ok, false);
    assert.match(res.code, /^qualify_rejected:drift$/u);
  });

  it('postcondition failures on held-out inputs reject', () => {
    const { procedure } = compile({ candidate: candidate(), kind: 'replace_text', params: params() });
    const world = {
      observe: () => 'foo here',
      apply: () => ({ sites: 1, after: 'foo here' }),
    };
    const res = qualify({ procedure, inputs: ['stubborn.txt'], ...world });
    assert.equal(res.ok, false);
    assert.match(res.code, /^qualify_rejected:postcondition$/u);
  });

  it('throwing injectors become labelled rejections', () => {
    const { procedure } = compile({ candidate: candidate(), kind: 'replace_text', params: params() });
    const res = qualify({
      procedure,
      inputs: ['x.txt'],
      observe: () => { throw new Error('disk gone'); },
      apply: () => ({}),
    });
    assert.deepEqual(res, { ok: false, code: 'injector_failed', reason: 'observe' });
  });
});
