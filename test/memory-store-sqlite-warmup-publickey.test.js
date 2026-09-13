'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const MemoryStore = require('../lib/memory-store');
const { warmup } = require('../lib/memory-store-sqlite-warmup');

function memoryStoreRow(overrides = {}) {
  return {
    memory_id: 'mem-1',
    workspace_id: 'WS-1',
    content_json: JSON.stringify({ text: 'hello' }),
    created_at: '2026-01-01T00:00:00.000Z',
    status: 'active',
    metadata_json: '{}',
    provenance_json: JSON.stringify({
      provenanceId: 'prov-1',
      sourceRef: 'test',
      sourceTitle: 'Test',
      sourceType: 'agent',
      actor: 'agent-a',
      timestamp: '2026-01-01T00:00:00.000Z',
      trustPolicyVersion: 'test',
      confidence: 0.9,
    }),
    trust_policy_version: 'test',
    ...overrides,
  };
}

function fakeStore(rows, keyBuilder) {
  return {
    _memories: new Map(),
    _events: [],
    _links: [],
    corruptRows: [],
    _strictWarmup: false,
    _stmts: {
      allMemories: { all: () => rows },
      allEvents: { all: () => [] },
      allLinks: { all: () => [] },
    },
    makeMemoryKey: keyBuilder,
  };
}

test('2348: memory store exposes a documented public makeMemoryKey', () => {
  assert.equal(typeof MemoryStore.prototype.makeMemoryKey, 'function', 'makeMemoryKey must be public surface');
  assert.equal(typeof MemoryStore.prototype._makeMemoryKey, 'function', 'private delegate retained for legacy callers');
});

test('2348: makeMemoryKey trims both parts and preserves the workspace case', () => {
  const makeMemoryKey = MemoryStore.prototype.makeMemoryKey;
  assert.equal(makeMemoryKey.call({}, ' WS-1 ', '  mem-1  '), 'WS-1:mem-1');
});

test('2348: warmup loads SQLite rows through the public key builder', () => {
  let spy = '';
  const store = fakeStore(
    [memoryStoreRow()],
    (workspaceId, memoryId) => {
      spy = `${workspaceId}:${memoryId}`;
      return `${workspaceId}:${memoryId}`;
    },
  );
  warmup(store);
  assert.equal(store._memories.size, 1);
  assert.equal(spy, 'WS-1:mem-1', 'warmup must call store.makeMemoryKey, not the private underscore method');
  assert.equal(store._memories.get('WS-1:mem-1').memoryId, 'mem-1');
});