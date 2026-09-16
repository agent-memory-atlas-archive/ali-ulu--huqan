'use strict';

/**
 * Experience — Permitted Fallback: trust-ladder consequences (#2398, design
 * comment on #2385, R3 Phase 9).
 *
 * Split out of `./permitted-fallback.js` to stay under the ~400-line module
 * budget; this half owns everything that touches `capability-trust.js`
 * (#2394): the anti-erosion counter and the paranoid-mode deterministic-
 * execution gate a derived procedure must pass before it may promote past
 * `insufficient-data`.
 *
 * ## Anti-erosion
 *
 * `fallbackPreferredOverCount` lives on the Capability Trust record and is
 * incremented only for capabilities the router's own `candidatesConsidered`
 * marked `structuralMatch: true` in the refusal that triggered a fallback
 * check — never for every fallback use. `applyFallbackPreferredOverCount()`
 * reads that list directly off the router's `decision` object rather than
 * asking the caller to recompute "did a matching capability exist." A
 * `no_structural_match` refusal yields an empty `incremented` list by
 * construction (every considered row has `structuralMatch: false`); a
 * `no_eligible_match` refusal (something matched but was ineligible, e.g.
 * `demoted` or risk-gated) increments exactly the matched rows.
 *
 * ## Learning admission — no relaxation, plus a separate proof
 *
 * Learning admission itself is unchanged: `lib/experience/contract.js`'s
 * `resolveLearningEligibility()` and #2389's verifier bar (`verifier.js`)
 * apply to fallback-sourced Experience exactly as they do to any other —
 * this file adds no new eligibility code and does not import or wrap
 * either. What it adds is a second, independent gate that sits *after*
 * verification passes and a procedure candidate exists: the derived
 * procedure must separately prove deterministic execution on held-out
 * inputs with model access disabled (`paranoidMode: true`) before
 * `promoteDerivedProcedureFromFallback()` will call `capability-trust.js`'s
 * existing `rebindProcedure()` on its behalf. `deterministicPathCheck` is
 * the caller-supplied result of running
 * `scripts/check-deterministic-path.js`'s exported `checkDeterministicPath()`
 * — reused, not reimplemented — against an entry point that covers the
 * derived procedure's execution path, with `PARANOID=1` set so
 * `paranoidMode` is true end to end (same environment-fingerprint mechanism
 * #2396's PEM already uses). Passing verification on the source fallback
 * answer is necessary before a caller would attempt this at all, but it is
 * not sufficient by itself — source execution and learned-procedure
 * execution carry distinct claims, per the design comment, and neither
 * inherits the other's trust.
 */

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Increment `fallbackPreferredOverCount` only for capabilities the router's
 * own `candidatesConsidered` marked `structuralMatch: true`.
 */
function applyFallbackPreferredOverCount(trustRegistry, { workspaceId, routingDecision } = {}) {
  if (!trustRegistry || typeof trustRegistry.incrementFallbackPreferredOverCount !== 'function') {
    return { ok: false, code: 'invalid_trust_registry' };
  }
  if (!isRecord(routingDecision) || !Array.isArray(routingDecision.candidatesConsidered)) {
    return { ok: false, code: 'invalid_routing_decision' };
  }
  const matchedIds = [...new Set(
    routingDecision.candidatesConsidered
      .filter((c) => isRecord(c) && c.structuralMatch === true)
      .map((c) => c.capabilityId),
  )];
  const results = matchedIds.map((capabilityId) => (
    trustRegistry.incrementFallbackPreferredOverCount({ workspaceId, capabilityId })
  ));
  return { ok: true, incremented: matchedIds, results };
}

/**
 * The separate deterministic-execution proof a derived procedure needs
 * before it may promote past `insufficient-data`, on top of (not instead
 * of) #2389's independent-verification bar.
 */
function assertParanoidDeterministicProof({ paranoidMode, deterministicPathCheck } = {}) {
  if (paranoidMode !== true) return { ok: false, code: 'paranoid_mode_required' };
  if (!isRecord(deterministicPathCheck) || deterministicPathCheck.ok !== true) {
    return { ok: false, code: 'deterministic_path_check_failed' };
  }
  return { ok: true };
}

/**
 * Promote a derived procedure past `insufficient-data` for a fallback
 * capability. Requires `assertParanoidDeterministicProof()` to pass before
 * it will call `capability-trust.js`'s existing `rebindProcedure()` — no
 * shortcut through that requirement exists here, regardless of how the
 * source Experience's verification came out.
 */
function promoteDerivedProcedureFromFallback({
  trustRegistry, workspaceId, capabilityId, newProcedureVersion,
  paranoidMode, deterministicPathCheck, reason = 'fallback_procedure_promotion_after_verification',
  atEventId, at,
} = {}) {
  const proof = assertParanoidDeterministicProof({ paranoidMode, deterministicPathCheck });
  if (!proof.ok) return proof;
  if (!trustRegistry || typeof trustRegistry.rebindProcedure !== 'function') {
    return { ok: false, code: 'invalid_trust_registry' };
  }
  return trustRegistry.rebindProcedure({
    workspaceId, capabilityId, newProcedureVersion, reason, atEventId, at,
  });
}

module.exports = Object.freeze({
  applyFallbackPreferredOverCount,
  assertParanoidDeterministicProof,
  promoteDerivedProcedureFromFallback,
});
