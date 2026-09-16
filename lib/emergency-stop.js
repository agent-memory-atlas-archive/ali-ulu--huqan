'use strict';

// Emergency stop (#2505 F + #2584 tamper-evidence): durable ledger that stops an
// agent or every agent/MCP call in a workspace, and that every enforcement point
// reads before it acts.
//
// v1 (2505F): one file per scope (wx create / unlink) + receipts.jsonl append.
// v2 (2584): hash-chained append-only ledger (ledger.jsonl) is authoritative.
//   - Each stop/lift/integrity_violation is one ledger entry chained by prevHash.
//   - check() replays the ledger, not a single mutable file — rm of .stop.json
//     alone no longer erases the stop.
//   - Mismatch between ledger and filesystem files => integrity_violation (fail-closed).
//   - Workspace lift requires a distinct operator from the stop author (quorum).
//
// Fail-closed: unreadable record OR ledger integrity violation => stopped:true.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { defaultStateRoot } = require('./huqan-state-root');
const { stableStringify } = require('./receipt/canonical-receipt');
const { normalizeWorkspaceId } = require('./workspace-id');

const EMERGENCY_STOP_SCHEMA_VERSION = 'huqan.emergency-stop.v1';
const EMERGENCY_STOP_REASON = 'agent_emergency_stopped';
const UNREADABLE_REASON = 'emergency_stop_record_unreadable';
const INTEGRITY_VIOLATION_REASON = 'emergency_stop_integrity_violation';
const QUORUM_REASON = 'emergency_stop_quorum_distinct_approver_required';
const SCOPES = Object.freeze({ AGENT: 'agent', WORKSPACE: 'workspace' });
const RECORD_SUFFIX = '.stop.json';
const RECEIPTS_FILE = 'receipts.jsonl';
const LEDGER_FILE = 'ledger.jsonl';
const MAX_TEXT = 256;

function text(value) {
  return typeof value === 'string' ? value.trim().slice(0, MAX_TEXT) : '';
}

/**
 * Trim-only shaping for operator argument envelopes (#2505 F-2b).
 * Kept separate from text(): feeds operatorCapabilityBinding, must stay byte-identical.
 */
function argText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

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

function ledgerPath(root) {
  return path.join(root, LEDGER_FILE);
}

function computeEntryHash(payload, prevHash) {
  return crypto.createHash('sha256').update(stableStringify({ ...payload, prevHash }), 'utf8').digest('hex');
}

function readLedgerEntries(root) {
  const file = ledgerPath(root);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    // Unreadable ledger file itself is a violation signal, but caller decides.
    // Return a sentinel that verify will treat as violation.
    return [{ __unreadable: true, __error: error }];
  }
  if (!raw.trim()) return [];
  const entries = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch (_) {
      entries.push({ __corrupt: true, __raw: trimmed });
    }
  }
  return entries;
}

function verifyLedgerEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return { ok: true, entries: [] };
  // Sentinel unreadable/corrupt
  for (const e of entries) {
    if (e.__unreadable || e.__corrupt) return { ok: false, reason: 'ledger_unreadable_or_corrupt', entries };
  }
  let prevHash = null;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (typeof entry.seq !== 'number' || entry.seq !== i) {
      return { ok: false, reason: 'ledger_seq_gap', index: i, entries };
    }
    if ((entry.prevHash ?? null) !== prevHash) {
      return { ok: false, reason: 'ledger_prevhash_mismatch', index: i, entries };
    }
    const { hash, seq, prevHash: storedPrev, ...payload } = entry;
    const expected = computeEntryHash(payload, prevHash);
    if (hash !== expected) {
      return { ok: false, reason: 'ledger_hash_mismatch', index: i, entries, expected, actual: hash };
    }
    // Payload schema sanity
    if (!entry.action || !['stop', 'lift', 'integrity_violation'].includes(entry.action)) {
      return { ok: false, reason: 'ledger_invalid_action', index: i, entries };
    }
    prevHash = hash;
  }
  return { ok: true, entries };
}

function replayLedgerState(entries) {
  // Map scopeKey -> { stopped:boolean, lastStopActor:string|null, record:object|null }
  const state = new Map();
  for (const entry of entries) {
    const key = scopeKey(entry.scope, entry.workspaceId, entry.agentId ?? null);
    if (entry.action === 'stop') {
      state.set(key, { stopped: true, lastStopActor: entry.actor, record: { schemaVersion: entry.schemaVersion || EMERGENCY_STOP_SCHEMA_VERSION, scope: entry.scope, workspaceId: entry.workspaceId, agentId: entry.agentId ?? null, actor: entry.actor, stoppedAt: entry.createdAt, reason: entry.reason } });
    } else if (entry.action === 'lift') {
      state.set(key, { stopped: false, lastStopActor: null, record: null });
    } else if (entry.action === 'integrity_violation') {
      // Integrity violation itself is a fail-closed stop at the violated scope
      state.set(key, { stopped: true, lastStopActor: 'system:integrity-violation', record: null, violation: true });
    }
  }
  return state;
}

function scanFileState(root) {
  const state = new Map();
  let files = [];
  try {
    files = fs.readdirSync(root).filter((n) => n.endsWith(RECORD_SUFFIX));
  } catch (error) {
    if (error && error.code === 'ENOENT') return { state, unreadable: false };
    return { state, unreadable: true };
  }
  for (const file of files) {
    const full = path.join(root, file);
    let raw;
    try {
      raw = fs.readFileSync(full, 'utf8');
    } catch (_) {
      // Unreadable .stop.json is itself a fail-closed signal, but scan marks it
      const key = file.replace(RECORD_SUFFIX, '');
      state.set(key, { stopped: true, unreadable: true, record: null });
      continue;
    }
    try {
      const record = JSON.parse(raw);
      if (!record || record.schemaVersion !== EMERGENCY_STOP_SCHEMA_VERSION || !record.scope || !record.workspaceId) {
        const key = file.replace(RECORD_SUFFIX, '');
        state.set(key, { stopped: true, unreadable: true, record: null });
        continue;
      }
      const key = scopeKey(record.scope, record.workspaceId, record.agentId ?? null);
      state.set(key, { stopped: true, unreadable: false, record });
    } catch (_) {
      const key = file.replace(RECORD_SUFFIX, '');
      state.set(key, { stopped: true, unreadable: true, record: null });
    }
  }
  return { state, unreadable: false };
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
    fs.mkdirSync(root, { recursive: true });
    fs.appendFileSync(path.join(root, RECEIPTS_FILE), `${JSON.stringify(receipt)}\n`, 'utf8');
    return receipt;
  }

  function appendLedgerEntry({ action, scope, workspaceId, agentId, actor, reason }) {
    fs.mkdirSync(root, { recursive: true });
    const entries = readLedgerEntries(root);
    // If ledger is currently unreadable/corrupt, we still append a violation marker after verification
    // but for normal stop/lift we compute prevHash from last valid entry if possible.
    // For simplicity, if verification fails, prevHash is derived from last entry's hash anyway — mismatch will remain detectable.
    let prevHash = null;
    let seq = 0;
    if (entries.length > 0 && !entries[0].__unreadable && !entries[0].__corrupt) {
      const last = entries[entries.length - 1];
      if (last && typeof last.hash === 'string') {
        prevHash = last.hash;
        seq = entries.length;
      } else {
        // Last entry malformed — chain already broken, still append with null prev to make gap explicit
        seq = entries.length;
        prevHash = null;
      }
    }
    const payload = {
      schemaVersion: EMERGENCY_STOP_SCHEMA_VERSION,
      action,
      scope,
      workspaceId,
      agentId: agentId ?? null,
      actor: text(actor),
      reason: text(reason),
      createdAt: now(),
    };
    const hash = computeEntryHash(payload, prevHash);
    const entry = { seq, prevHash, hash, ...payload };
    fs.appendFileSync(ledgerPath(root), `${JSON.stringify(entry)}\n`, 'utf8');
    return Object.freeze(entry);
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

  function verifyIntegrity() {
    const entries = readLedgerEntries(root);
    const verified = verifyLedgerEntries(entries);
    if (!verified.ok) {
      return Object.freeze({ ok: false, reason: INTEGRITY_VIOLATION_REASON, details: { ledgerReason: verified.reason, index: verified.index ?? null } });
    }
    // Compare ledger replay vs filesystem files (only when ledger non-empty — empty ledger is legacy, trust files)
    if (entries.length > 0) {
      const ledgerState = replayLedgerState(entries);
      const { state: fileState, unreadable: fileUnreadable } = scanFileState(root);
      if (fileUnreadable) {
        return Object.freeze({ ok: false, reason: INTEGRITY_VIOLATION_REASON, details: { ledgerReason: 'stop_record_unreadable' } });
      }
      // Every ledger-stopped scope must have a corresponding file, and vice versa.
      // File-only stops with no ledger entry => tamper (hand-crafted file). Ledger-only stops with no file => rm tamper.
      for (const [key, ledgerVal] of ledgerState.entries()) {
        const fileVal = fileState.get(key);
        if (ledgerVal.stopped && !fileVal) {
          return Object.freeze({ ok: false, reason: INTEGRITY_VIOLATION_REASON, details: { ledgerReason: 'ledger_stopped_but_file_missing', scopeKey: key } });
        }
        if (!ledgerVal.stopped && fileVal) {
          return Object.freeze({ ok: false, reason: INTEGRITY_VIOLATION_REASON, details: { ledgerReason: 'ledger_not_stopped_but_file_present', scopeKey: key } });
        }
        if (fileVal && fileVal.unreadable) {
          return Object.freeze({ ok: false, reason: INTEGRITY_VIOLATION_REASON, details: { ledgerReason: 'stop_record_unreadable', scopeKey: key } });
        }
      }
      for (const [key] of fileState.entries()) {
        if (!ledgerState.has(key)) {
          return Object.freeze({ ok: false, reason: INTEGRITY_VIOLATION_REASON, details: { ledgerReason: 'file_without_ledger_entry', scopeKey: key } });
        }
      }
    } else {
      // Ledger empty: check for unreadable files even in legacy mode
      const { state: fileState, unreadable } = scanFileState(root);
      if (unreadable) {
        return Object.freeze({ ok: false, reason: INTEGRITY_VIOLATION_REASON, details: { ledgerReason: 'stop_record_unreadable' } });
      }
      for (const [, v] of fileState.entries()) {
        if (v.unreadable) return Object.freeze({ ok: false, reason: INTEGRITY_VIOLATION_REASON, details: { ledgerReason: 'stop_record_unreadable' } });
      }
    }
    return Object.freeze({ ok: true, reason: null, details: {} });
  }

  function handleIntegrityViolation({ workspaceId, agentId, violationReason }) {
    // Append a ledger marker so the violation is itself tamper-evident and survives restarts.
    // Scope is workspace if agentId unknown, otherwise the specific agent. Fail-closed wider when ambiguous.
    let scope = SCOPES.WORKSPACE;
    let targetWorkspace = workspaceId || 'default';
    let targetAgent = null;
    try { targetWorkspace = normalizeWorkspaceId(workspaceId || 'default'); } catch (_) { targetWorkspace = 'default'; }
    if (agentId && text(agentId)) {
      scope = SCOPES.AGENT;
      targetAgent = text(agentId);
    }
    try {
      appendLedgerEntry({ action: 'integrity_violation', scope, workspaceId: targetWorkspace, agentId: targetAgent, actor: 'system:integrity-violation', reason: String(violationReason || 'ledger_tamper_detected') });
    } catch (_) {
      // Best-effort: ledger append failure should not hide the violation signal
    }
    // Also ensure a .stop.json exists for the violated scope so check() remains stopped even if ledger is later truncated
    try {
      fs.mkdirSync(root, { recursive: true });
      const target = { scope, workspaceId: targetWorkspace, agentId: targetAgent };
      const record = { schemaVersion: EMERGENCY_STOP_SCHEMA_VERSION, ...target, reason: INTEGRITY_VIOLATION_REASON, actor: 'system:integrity-violation', stoppedAt: now() };
      fs.writeFileSync(recordPath(target), JSON.stringify(record), { encoding: 'utf8', flag: 'wx' });
    } catch (_) {
      // If file already exists or write fails, the ledger entry above is still authoritative
    }
  }

  /** Stop a scope. A scope already stopped keeps its first record. */
  function stop({ scope, workspaceId, agentId, reason, actor } = {}) {
    const target = normalizeTarget({ scope, workspaceId, agentId });
    if (!text(actor)) throw new TypeError('an emergency stop needs the operator who issued it');
    // Integrity check first — if chain is broken, fail-closed and auto-contain
    const integrity = verifyIntegrity();
    if (!integrity.ok) {
      handleIntegrityViolation({ workspaceId: target.workspaceId, agentId: target.agentId, violationReason: integrity.details?.ledgerReason || 'pre_stop_integrity_failed' });
      // Still proceed to record the requested stop if not already stopped, but caller sees violation
    }
    fs.mkdirSync(root, { recursive: true });
    const record = {
      schemaVersion: EMERGENCY_STOP_SCHEMA_VERSION,
      ...target,
      reason: text(reason),
      actor: text(actor),
      stoppedAt: now(),
    };
    let created = true;
    try {
      fs.writeFileSync(recordPath(target), JSON.stringify(record), { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      created = false;
      const existing = readRecord(target);
      if (!created) {
        // Deduplicate ledger: if same scope already has a stop entry as last action, don't append duplicate
        const entries = readLedgerEntries(root);
        const ledgerState = replayLedgerState(entries.filter((e) => !e.__unreadable && !e.__corrupt));
        const key = scopeKey(target.scope, target.workspaceId, target.agentId);
        const state = ledgerState.get(key);
        if (state && state.stopped) {
          return Object.freeze({ ok: true, created: false, record: existing.record || null, receipt: null, ledgerEntry: null, integrityViolation: !integrity.ok });
        }
      }
    }
    const ledgerEntry = appendLedgerEntry({ action: 'stop', scope: target.scope, workspaceId: target.workspaceId, agentId: target.agentId, actor, reason });
    const receipt = appendReceipt('stop', record, actor, reason);
    return Object.freeze({ ok: true, created, record, receipt, ledgerEntry, integrityViolation: !integrity.ok });
  }

  /** Lift a stop. Lifting a scope that is not stopped records nothing. */
  function lift({ scope, workspaceId, agentId, reason, actor } = {}) {
    const target = normalizeTarget({ scope, workspaceId, agentId });
    if (!text(actor)) throw new TypeError('lifting an emergency stop needs the operator who lifted it');
    const integrity = verifyIntegrity();
    if (!integrity.ok) {
      handleIntegrityViolation({ workspaceId: target.workspaceId, agentId: target.agentId, violationReason: integrity.details?.ledgerReason || 'pre_lift_integrity_failed' });
      return Object.freeze({ ok: false, lifted: false, reason: INTEGRITY_VIOLATION_REASON, details: integrity.details, integrityViolation: true });
    }
    // Quorum for workspace lift: must be distinct operator from the stop author
    if (target.scope === SCOPES.WORKSPACE) {
      const entries = readLedgerEntries(root).filter((e) => !e.__unreadable && !e.__corrupt);
      const ledgerState = replayLedgerState(entries);
      const key = scopeKey(target.scope, target.workspaceId, target.agentId);
      const state = ledgerState.get(key);
      if (!state || !state.stopped) {
        return Object.freeze({ ok: true, lifted: false, receipt: null, ledgerEntry: null });
      }
      const stopActor = state.lastStopActor;
      if (stopActor && text(actor) === stopActor) {
        return Object.freeze({ ok: false, lifted: false, reason: QUORUM_REASON, details: { scope: target.scope, workspaceId: target.workspaceId, actor: text(actor), stopActor } });
      }
    }
    try {
      fs.unlinkSync(recordPath(target));
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        // File missing but ledger says stopped => this is the tamper case already handled above (integrity would have been false)
        // If here, ledger also says not stopped, so nothing to do.
        return Object.freeze({ ok: true, lifted: false, receipt: null, ledgerEntry: null });
      }
      throw error;
    }
    const ledgerEntry = appendLedgerEntry({ action: 'lift', scope: target.scope, workspaceId: target.workspaceId, agentId: target.agentId, actor, reason });
    const receipt = appendReceipt('lift', target, actor, reason);
    return Object.freeze({ ok: true, lifted: true, receipt, ledgerEntry });
  }

  /**
   * Whether an action by `agentId` in `workspaceId` is stopped. The workspace
   * scope is checked first; without an agent id only the workspace scope
   * applies. An unreadable record OR ledger integrity violation reports stopped.
   */
  function check({ workspaceId, agentId } = {}) {
    const workspace = normalizeWorkspaceId(workspaceId);
    const agent = text(agentId);
    const integrity = verifyIntegrity();
    if (!integrity.ok) {
      // Auto-contain: record violation so it is loud and survives restart
      handleIntegrityViolation({ workspaceId: workspace, agentId: agent || null, violationReason: integrity.details?.ledgerReason || 'check_integrity_failed' });
      return Object.freeze({
        stopped: true,
        scope: integrity.details?.scopeKey ? null : (agent ? SCOPES.AGENT : SCOPES.WORKSPACE),
        reason: INTEGRITY_VIOLATION_REASON,
        record: null,
        integrityViolation: true,
        details: integrity.details,
      });
    }
    // Ledger authoritative when non-empty; otherwise fall back to files (legacy)
    const entries = readLedgerEntries(root).filter((e) => !e.__unreadable && !e.__corrupt);
    if (entries.length > 0) {
      const ledgerState = replayLedgerState(entries);
      const workspaceKey = scopeKey(SCOPES.WORKSPACE, workspace, null);
      const wsState = ledgerState.get(workspaceKey);
      if (wsState && wsState.stopped) {
        return Object.freeze({ stopped: true, scope: SCOPES.WORKSPACE, reason: EMERGENCY_STOP_REASON, record: wsState.record || null });
      }
      if (agent) {
        const agentKey = scopeKey(SCOPES.AGENT, workspace, agent);
        const agState = ledgerState.get(agentKey);
        if (agState && agState.stopped) {
          return Object.freeze({ stopped: true, scope: SCOPES.AGENT, reason: EMERGENCY_STOP_REASON, record: agState.record || null });
        }
      }
      return Object.freeze({ stopped: false, scope: null, reason: null, record: null });
    }
    // Legacy path: no ledger yet, trust files
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

  return Object.freeze({ directory: root, stop, lift, check, verifyIntegrity, _readLedgerEntries: () => readLedgerEntries(root), _verifyLedgerEntries: (e) => verifyLedgerEntries(e) });
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
  EMERGENCY_STOP_INTEGRITY_VIOLATION_REASON: INTEGRITY_VIOLATION_REASON,
  EMERGENCY_STOP_QUORUM_REASON: QUORUM_REASON,
  changeArguments,
  checkArguments,
  createEmergencyStop,
  defaultEmergencyStopDirectory,
  emergencyStopLedger,
};
