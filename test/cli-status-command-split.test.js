'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

// #2136 (#2122): the `durum` status command was the only user of two of the
// modules cli.js requires (lib/system-status-report and lib/cli-plugin-status).
// It moves to lib/cli-status-command.js unchanged, so cli.js requires one
// module instead of two and its fan-out drops by one -- the room the next move
// out of cli.js needs without raising the FANOUT ratchet.
//
// Its behaviour is already pinned to a digest recorded on main by
// test/cli-command-dispatch.test.js, and kernel-cli-audit-baseline-contract
// runs it for real; both must stay green. This file pins the move itself.

describe('the status command lives in lib/ (#2136)', () => {
  it('lib/cli-status-command.js exports the handler and the command table delegates to it', () => {
    const { runStatusCommand } = require('../lib/cli-status-command');
    assert.equal(typeof runStatusCommand, 'function');
    assert.equal(runStatusCommand.length, 1);
    const source = fs.readFileSync(path.join(__dirname, '..', 'cli.js'), 'utf8');
    assert.match(source, /'durum': \(cli\) => runStatusCommand\(cli\),/);
  });

  it('cli.js no longer requires the two modules only the status command used', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'cli.js'), 'utf8');
    assert.doesNotMatch(source, /require\('\.\/lib\/system-status-report'\)/);
    assert.doesNotMatch(source, /require\('\.\/lib\/cli-plugin-status'\)/);
  });

  it('cli.js fan-out dropped by one', () => {
    const row = require('../scripts/architecture-snapshot').snapshot().find((item) => item.file === 'cli.js');
    assert.ok(row, 'cli.js is measured');
    assert.equal(row.fanOut, 26, JSON.stringify(row));
  });
});
