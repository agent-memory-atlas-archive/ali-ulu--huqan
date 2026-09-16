'use strict';

/**
 * Experience Phase 6 — limited Procedure Compiler (#2392, design #2382).
 *
 * The narrow core of compilation: a procedure candidate (Phase 4 shape)
 * becomes an immutable, versioned procedure for the pilot `replace_text`
 * family. The compiler grants nothing — no trust, no activation, no
 * registry writes. A procedure is data with a version and a hash; running
 * it is someone else's delivery.
 *
 * ## What the compiler owns
 *
 * - Typed parameters: `replace_text` takes `{ path, oldText, newText }`,
 *   all non-empty strings. Anything else fails to compile.
 * - Preconditions/postconditions as data: the procedure records what must
 *   hold before (`oldText` present exactly once) and what must hold after
 *   (`newText` present, `oldText` absent). Checking them is `qualify`,
 *   not compile.
 * - Versions never change: compiling from a candidate with a
 *   `parentVersion` yields `parentVersion + 1` and a new hash. The old
 *   version object is never touched.
 * - Qualification on new inputs: `qualify` runs the procedure against
 *   caller-supplied held-out inputs through an injected `apply` — never
 *   the source run copied over. Held-out failures, ambiguous matches
 *   (more than one site) and environment drift (precondition unmet)
 *   reject the procedure with a reason instead of weakening it.
 *
 * ## Injection, not execution
 *
 * The compiler never touches the filesystem, the graph or any store. The
 * caller injects `apply(procedure, input)` and `observe(input)`; tests
 * inject fakes, production will inject the seam adapters. A failing
 * injection surfaces as a rejection, never as an exception escaping
 * `qualify` unlabelled.
 */

const crypto = require('node:crypto');

const KINDS = Object.freeze({ REPLACE_TEXT: 'replace_text' });

const CODES = Object.freeze({
  NOT_A_CANDIDATE: 'not_a_candidate',
  MISSING_TRACE: 'missing_trace',
  BAD_PARAMS: 'bad_params',
  UNKNOWN_KIND: 'unknown_kind',
  QUALIFY_REJECTED: qualifyRejectedCode(''),
  INJECTOR_FAILED: 'injector_failed',
});

function qualifyRejectedCode(reason) {
  return `qualify_rejected${reason ? `:${reason}` : ''}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function stableKey(value) {
  if (value === undefined) return '';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableKey(value[k])}`).join(',')}}`;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function validReplaceTextParams(params) {
  if (!isRecord(params)) return false;
  const keys = Object.keys(params);
  return keys.length === 3
    && nonEmptyString(params.path) !== null
    && nonEmptyString(params.oldText) !== null
    && nonEmptyString(params.newText) !== null;
}

/**
 * Compile a candidate into an immutable versioned procedure. Pure:
 * no execution, no I/O. `parentVersion` (integer >= 0) chains versions.
 */
function compile({ candidate, kind, params, parentVersion = 0 } = {}) {
  if (!isRecord(candidate) || candidate.status !== 'candidate') {
    return { ok: false, code: CODES.NOT_A_CANDIDATE };
  }
  if (!isRecord(candidate.trace) || !Array.isArray(candidate.trace.sources)
    || candidate.trace.sources.length === 0 || !isRecord(candidate.trace.scope)) {
    return { ok: false, code: CODES.MISSING_TRACE };
  }
  if (kind !== KINDS.REPLACE_TEXT) return { ok: false, code: CODES.UNKNOWN_KIND };
  if (!validReplaceTextParams(params)) return { ok: false, code: CODES.BAD_PARAMS };
  if (!Number.isInteger(parentVersion) || parentVersion < 0) {
    return { ok: false, code: CODES.BAD_PARAMS };
  }
  const version = parentVersion + 1;
  const body = {
    kind, version, params: { path: params.path, oldText: params.oldText, newText: params.newText },
    preconditions: Object.freeze({ oldTextPresent: true, singleMatchSite: true }),
    postconditions: Object.freeze({ oldTextAbsent: true, newTextPresent: true }),
    evidenceRefs: candidate.trace.sources,
    scope: candidate.trace.scope,
    revision: candidate.trace.revision || 'unknown',
    parentHash: nonEmptyString(candidate.procedureHash) || null,
  };
  const procedure = Object.freeze({ ...body, hash: sha256(stableKey(body)) });
  return { ok: true, procedure };
}

/**
 * Qualify a compiled procedure against held-out inputs. `apply` runs the
 * procedure against one input and returns `{ sites, after }`; `observe`
 * reads the current content of an input for the drift check. Every
 * rejection names its reason; injections that throw become rejections.
 */
function qualify({ procedure, inputs, apply, observe } = {}) {
  if (!isRecord(procedure) || !nonEmptyString(procedure.hash)
    || !Array.isArray(inputs) || inputs.length === 0
    || typeof apply !== 'function' || typeof observe !== 'function') {
    return { ok: false, code: CODES.BAD_PARAMS };
  }
  const details = [];
  for (const input of inputs) {
    let current;
    try {
      current = observe(input);
    } catch (_) {
      return { ok: false, code: CODES.INJECTOR_FAILED, reason: 'observe' };
    }
    // Drift: the precondition no longer holds in this environment —
    // the text is gone entirely. Multiple sites are not drift; they
    // reach `apply`, which reports them as ambiguous below.
    if (typeof current !== 'string' || !current.includes(procedure.params.oldText)) {
      return {
        ok: false, code: qualifyRejectedCode('drift'),
        reason: 'precondition unmet: oldText absent in this environment',
      };
    }
    let result;
    try {
      result = apply(procedure, input);
    } catch (_) {
      return { ok: false, code: CODES.INJECTOR_FAILED, reason: 'apply' };
    }
    if (!isRecord(result)) {
      return { ok: false, code: qualifyRejectedCode('malformed-result'), reason: 'apply returned no record' };
    }
    // Ambiguous match: more than one site would change.
    if (Number(result.sites) !== 1) {
      return {
        ok: false, code: qualifyRejectedCode('ambiguous'),
        reason: `expected exactly one match site, saw ${String(result.sites)}`,
      };
    }
    if (typeof result.after !== 'string'
      || result.after.includes(procedure.params.oldText)
      || !result.after.includes(procedure.params.newText)) {
      details.push({ input, passed: false });
      return {
        ok: false, code: qualifyRejectedCode('postcondition'),
        reason: 'postcondition unmet on a held-out input', details: Object.freeze(details),
      };
    }
    details.push({ input, passed: true });
  }
  return { ok: true, qualified: true, procedureHash: procedure.hash, details: Object.freeze(details) };
}

module.exports = Object.freeze({ compile, qualify, KINDS, CODES });
