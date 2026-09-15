'use strict';

// Emergency stop (#2505 F): one durable record that stops an agent, or every
// agent and every MCP tool call in a workspace, and that every enforcement
// point reads before it acts.
//
// Two scopes, per the owner's decision:
//   agent      a workspace and an agent id
//   workspace  every agent in the workspace, and the MCP tool calls, which
//              carry no caller identity
//
// Each stop is one file, named by a hash of its scope, created with the
// exclusive `wx` flag, so a second stop of the same scope keeps the first
// record instead of racing it. Lifting removes the file. Every stop and lift
// appends a hashed receipt to receipts.jsonl in the same directory.
//
// Fail-closed: a check that finds a stop record it cannot read or parse reports
// the scope as stopped. An absent directory means no stop has been issued.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { defaultStateRoot } = require('./huqan-state-root');
const { stableStringify } = require('./receipt/canonical-receipt');
const { normalizeWorkspaceId } = require('./workspace-id');

const EMERGENCY_STOP_SCHEMA_VERSION = 'huqan.emergency-stop.v1';
const EMERGENCY_STOP_REASON = 'agent_emergency_stopped';
const UNREADABLE_REASON = 'emergency_stop_record_unreadable';
const SCOPES = Object.freeze({ AGENT: 'agent', WORKSPACE: 'workspace' });
const RECORD_SUFFIX = '.stop.json';
const RECEIPTS_FILE = 'receipts.jsonl';
const MAX_TEXT = 256;

function text(value) {
  return typeof value === 'string' ? value.trim().slice(0, MAX_TEXT) : '';
}

/**
 * Trim-only shaping for operator argument envelopes (#2505 F-2b).
 *
 * Kept separate from text(): these shapes feed operatorCapabilityBinding on
 * both the HTTP and MCP surfaces, so they must stay byte-identical to what
 * lib/http/emergency-stop-routes.js computed before the move. The ledger
 * applies its own 256-char bound at write time.
 */
function argText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** The argument shapes an operator capability is minted over, per method. */
function checkArguments({ workspaceId, agentId } = {}) {
  return { workspaceId: argText(workspaceId) || 'default', agentId: argText(agentId) };
}

function changeArguments(body = {}) {
  return {
    action: argText(body.action),
    scope: argText(body.scope),
    workspaceId: argText(body.workspaceId) || 'default',
    agentId: argText(body.agentId),
    reason: argText(body.reason),
  };
}

function defaultEmergencyStopDirectory(environment = process.env) {
  const override = text(environment.HUQAN_EMERGENCY_STOP_DIR);
  return override ? path.resolve(override) : path.join(defaultStateRoot(environment), 'emergency-stops');
}

function scopeKey(scope, workspaceId, agentId) {
  const material = scope === SCOPES.WORKSPACE ? `workspace\n${workspaceId}` : `agent\n${workspaceId}\n${agentId}`;
  return crypto.createHash('sha256').update(material, 'utf8').digest('hex');
}

function normalizeTarget({ scope, workspaceId, agentId } = {}) {
  if (scope !== SCOPES.AGENT && scope !== SCOPES.WORKSPACE) throw new TypeError(`unknown emergency stop scope: ${String(scope)}`);
  const workspace = normalizeWorkspaceId(workspaceId);
  const agent = text(agentId);
  if (scope === SCOPES.AGENT && !agent) throw new TypeError('an agent emergency stop needs an agent id');
  return { scope, workspaceId: workspace, agentId: scope === SCOPES.AGENT ? agent : null };
}

/** A ledger over one directory. */
function createEmergencyStop({ directory, environment = process.env, now = () => new Date().toISOString() } = {}) {
  const root = path.resolve(directory || defaultEmergencyStopDirectory(environment));
  const recordPath = (target) => path.join(root, `${scopeKey(target.scope, target.workspaceId, target.agentId)}${RECORD_SUFFIX}`);

  function appendReceipt(action, record, actor, reason) {
    const payload = {
      receiptKind: 'emergency_stop_receipt',
      schemaVersion: EMERGENCY_STOP_SCHEMA_VERSION,
      action,
      scope: record.scope,
      workspaceId: record.workspaceId,
      agentId: record.agentId,
      actor: text(actor),
      reason: text(reason),
      createdAt: now(),
    };
    const receipt = Object.freeze({
      ...payload,
      receiptHash: crypto.createHash('sha256').update(stableStringify(payload), 'utf8').digest('hex'),
    });
    fs.appendFileSync(path.join(root, RECEIPTS_FILE), `${JSON.stringify(receipt)}\n`, 'utf8');
    return receipt;
  }

  function readRecord(target) {
    let raw;
    try {
      raw = fs.readFileSync(recordPath(target), 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return { present: false };
      return { present: true, unreadable: true };
    }
    try {
      const record = JSON.parse(raw);
      const valid = record && record.schemaVersion === EMERGENCY_STOP_SCHEMA_VERSION
        && record.scope === target.scope && record.workspaceId === target.workspaceId
        && (record.agentId ?? null) === target.agentId;
      return valid ? { present: true, record } : { present: true, unreadable: true };
    } catch (_) {
      return { present: true, unreadable: true };
    }
  }

  /** Stop a scope. A scope already stopped keeps its first record. */
  function stop({ scope, workspaceId, agentId, reason, actor } = {}) {
    const target = normalizeTarget({ scope, workspaceId, agentId });
    if (!text(actor)) throw new TypeError('an emergency stop needs the operator who issued it');
    fs.mkdirSync(root, { recursive: true });
    const record = {
      schemaVersion: EMERGENCY_STOP_SCHEMA_VERSION,
      ...target,
      reason: text(reason),
      actor: text(actor),
      stoppedAt: now(),
    };
    try {
      fs.writeFileSync(recordPath(target), JSON.stringify(record), { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      const existing = readRecord(target);
      return Object.freeze({ ok: true, created: false, record: existing.record || null, receipt: null });
    }
    return Object.freeze({ ok: true, created: true, record, receipt: appendReceipt('stop', record, actor, reason) });
  }

  /** Lift a stop. Lifting a scope that is not stopped records nothing. */
  function lift({ scope, workspaceId, agentId, reason, actor } = {}) {
    const target = normalizeTarget({ scope, workspaceId, agentId });
    if (!text(actor)) throw new TypeError('lifting an emergency stop needs the operator who lifted it');
    try {
      fs.unlinkSync(recordPath(target));
    } catch (error) {
      if (error && error.code === 'ENOENT') return Object.freeze({ ok: true, lifted: false, receipt: null });
      throw error;
    }
    return Object.freeze({ ok: true, lifted: true, receipt: appendReceipt('lift', target, actor, reason) });
  }

  /**
   * Whether an action by `agentId` in `workspaceId` is stopped. The workspace
   * scope is checked first; without an agent id only the workspace scope
   * applies. An unreadable record reports the scope as stopped.
   */
  function check({ workspaceId, agentId } = {}) {
    const workspace = normalizeWorkspaceId(workspaceId);
    const agent = text(agentId);
    const targets = [{ scope: SCOPES.WORKSPACE, workspaceId: workspace, agentId: null }];
    if (agent) targets.push({ scope: SCOPES.AGENT, workspaceId: workspace, agentId: agent });
    for (const target of targets) {
      const found = readRecord(target);
      if (!found.present) continue;
      return Object.freeze({
        stopped: true,
        scope: target.scope,
        reason: found.unreadable ? UNREADABLE_REASON : EMERGENCY_STOP_REASON,
        record: found.record || null,
      });
    }
    return Object.freeze({ stopped: false, scope: null, reason: null, record: null });
  }

  return Object.freeze({ directory: root, stop, lift, check });
}

/**
 * The ledger an enforcement point should consult: an injected one
 * (`options.emergencyStop` with a `check`), or one over the configured
 * directory. Never taken from agent input.
 */
function emergencyStopLedger(options = {}) {
  const supplied = options && options.emergencyStop;
  if (supplied && typeof supplied.check === 'function') return supplied;
  return createEmergencyStop({
    directory: supplied && typeof supplied.directory === 'string' ? supplied.directory : undefined,
    environment: (options && options.environment) || process.env,
  });
}

module.exports = {
  EMERGENCY_STOP_REASON,
  EMERGENCY_STOP_SCHEMA_VERSION,
  EMERGENCY_STOP_SCOPES: SCOPES,
  EMERGENCY_STOP_UNREADABLE_REASON: UNREADABLE_REASON,
  changeArguments,
  checkArguments,
  createEmergencyStop,
  defaultEmergencyStopDirectory,
  emergencyStopLedger,
};
