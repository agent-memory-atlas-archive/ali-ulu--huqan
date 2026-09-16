'use strict';

/**
 * Permitted Fallback tests (#2398, R3 Phase 9, design comment on #2385).
 *
 * Implements the 9 acceptance tests listed at the end of the #2385 design
 * comment, in order. Hermetic: no I/O, no model call, no timers beyond
 * ordinary Date usage. Test 4 deliberately follows one fallback-sourced
 * answer through receipt -> Experience run_closed payload -> memory
 * admission record in a single test, per the design comment's explicit
 * instruction not to split it into three isolated unit tests that could
 * each pass while the field drops in the gaps between them.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  PROVENANCE_SOURCES, FALLBACK_REFUSAL_REASONS,
  createStandingGrant, createPermittedFallbackRegistry,
  buildFallbackReceiptPayload, buildFallbackRunClosedPayload,
  evaluateFallbackAction,
} = require('../lib/experience/permitted-fallback');
const {
  applyFallbackPreferredOverCount, assertParanoidDeterministicProof,
  promoteDerivedProcedureFromFallback,
} = require('../lib/experience/permitted-fallback-trust');
const { REFUSAL_REASONS, decideRoute } = require('../lib/experience/router');
const { resolveLearningEligibility } = require('../lib/experience/contract');
const { createLearningPool, CODES } = require('../lib/experience/learning');
const { createCapabilityTrustRegistry, TRUST_STATES } = require('../lib/experience/capability-trust');
const { evaluateAgentActionFirewall } = require('../lib/agent-action-firewall');
const { evaluateMemoryAdmission, isPermittedFallbackSignal } = require('../lib/memory-admission-gate');
const { checkDeterministicPath } = require('../scripts/check-deterministic-path');

const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 60 * 60 * 1000).toISOString();

describe('Permitted Fallback: acceptance tests (#2385/#2398)', () => {
  it('1. no grant -> fallback refused before any model call, recorded with fallback_not_permitted', () => {
    const registry = createPermittedFallbackRegistry();
    let modelCalled = false;
    const attemptModelCall = () => { modelCalled = true; };

    const result = registry.evaluateFallbackPermission({
      workspaceId: 'ws-1',
      capabilityClass: 'read',
      riskTier: 'low',
      runId: 'run-1',
      priorRefusalReason: REFUSAL_REASONS.NO_STRUCTURAL_MATCH,
    });
    // Only a caller that saw allowed:true would ever proceed to a model call.
    if (result.allowed) attemptModelCall();

    assert.equal(result.ok, false);
    assert.equal(result.allowed, false);
    assert.equal(result.refusalReason, FALLBACK_REFUSAL_REASONS.FALLBACK_NOT_PERMITTED);
    assert.equal(result.code, 'no_grant');
    assert.equal(modelCalled, false);

    // Out-of-sequence call (no prior refusal at all) is refused identically,
    // not with a different vocabulary -- the structural default-deny.
    const outOfSequence = registry.evaluateFallbackPermission({
      workspaceId: 'ws-1', capabilityClass: 'read', riskTier: 'low', runId: 'run-1',
    });
    assert.equal(outOfSequence.refusalReason, FALLBACK_REFUSAL_REASONS.FALLBACK_NOT_PERMITTED);
    assert.equal(outOfSequence.code, 'fallback_checked_without_prior_refusal');
  });

  it('2. standing grant scoped to workspace A permits there, refuses identical request in workspace B', () => {
    const registry = createPermittedFallbackRegistry();
    const granted = registry.registerStandingGrant({
      workspaceId: 'ws-A', capabilityClass: 'read', maxRiskTier: 'medium',
      grantedBy: 'operator-1', expiresAt: FUTURE,
    });
    assert.equal(granted.ok, true);

    const inA = registry.evaluateFallbackPermission({
      workspaceId: 'ws-A', capabilityClass: 'read', riskTier: 'medium', runId: 'run-a',
      priorRefusalReason: REFUSAL_REASONS.NO_ELIGIBLE_MATCH,
    });
    assert.equal(inA.allowed, true);
    assert.equal(inA.grantKind, 'standing');

    const inB = registry.evaluateFallbackPermission({
      workspaceId: 'ws-B', capabilityClass: 'read', riskTier: 'medium', runId: 'run-b',
      priorRefusalReason: REFUSAL_REASONS.NO_ELIGIBLE_MATCH,
    });
    assert.equal(inB.allowed, false);
    assert.equal(inB.code, 'no_grant');
  });

  it('3. per-run token consumed after one use; second use in same run refused, not re-granted', () => {
    const registry = createPermittedFallbackRegistry();
    const built = registry.registerPerRunToken({
      workspaceId: 'ws-1', capabilityClass: 'read', maxRiskTier: 'high',
      runId: 'run-once', grantedBy: 'operator-1',
    });
    assert.equal(built.ok, true);
    const tokenId = built.token.tokenId;

    const first = registry.evaluateFallbackPermission({
      workspaceId: 'ws-1', capabilityClass: 'read', riskTier: 'high', runId: 'run-once',
      priorRefusalReason: REFUSAL_REASONS.NO_STRUCTURAL_MATCH, tokenId,
    });
    assert.equal(first.allowed, true);
    assert.equal(first.grantKind, 'per_run');

    const second = registry.evaluateFallbackPermission({
      workspaceId: 'ws-1', capabilityClass: 'read', riskTier: 'high', runId: 'run-once',
      priorRefusalReason: REFUSAL_REASONS.NO_STRUCTURAL_MATCH, tokenId,
    });
    assert.equal(second.allowed, false);
    assert.equal(second.code, 'token_already_consumed');
  });

  it('4. provenanceSource survives receipt -> Experience run_closed payload -> memory admission record', () => {
    // One fallback-sourced answer, followed through all three hops.
    const baseReceipt = {
      receiptId: 'madm_receipt_fallback_1',
      receiptKind: 'memory_admission_receipt',
      decision: 'allow',
      status: 'admitted',
      admissionId: 'madm_fallback_1',
      workspaceId: 'ws-1',
      provenanceId: 'prov-fallback-1',
      trustPolicyVersion: 'V3-PR4-v0.1.0',
      createdAt: new Date().toISOString(),
    };

    // Hop 1: receipt.
    const receiptPayload = buildFallbackReceiptPayload(baseReceipt, {
      verdict: 'allow',
      provenanceSource: PROVENANCE_SOURCES.PERMITTED_FALLBACK,
    });
    assert.equal(receiptPayload.provenanceSource, PROVENANCE_SOURCES.PERMITTED_FALLBACK);

    // Hop 2: Experience run_closed payload.
    const runClosedPayload = buildFallbackRunClosedPayload(
      { runId: 'run-1', modelId: 'pem-model-hash' },
      PROVENANCE_SOURCES.PERMITTED_FALLBACK,
    );
    assert.equal(runClosedPayload.provenanceSource, PROVENANCE_SOURCES.PERMITTED_FALLBACK);

    // Hop 3: memory admission record.
    const admission = evaluateMemoryAdmission({
      admissionId: 'madm_fallback_1',
      workspaceId: 'ws-1',
      actor: 'agent-1',
      agentId: 'agent-1',
      memoryDraftId: 'draft-1',
      proposedMemory: { content: 'discovered fact' },
      provenanceId: 'prov-fallback-1',
      trustPolicyVersion: 'V3-PR4-v0.1.0',
      reason: 'permitted fallback discovery',
      createdAt: new Date().toISOString(),
      riskScore: 10,
      provenanceSource: PROVENANCE_SOURCES.PERMITTED_FALLBACK,
    });
    assert.equal(admission.ok, true);
    assert.equal(isPermittedFallbackSignal(admission.request), true);
    assert.equal(admission.receipt.metadata.provenanceSource, PROVENANCE_SOURCES.PERMITTED_FALLBACK);

    // The field is the same string at every hop -- nothing re-derives it.
    assert.equal(receiptPayload.provenanceSource, runClosedPayload.provenanceSource);
    assert.equal(runClosedPayload.provenanceSource, admission.receipt.metadata.provenanceSource);
  });

  it('5. fallback-sourced mutation without risk-tier approval is blocked exactly as a deterministic action would be', () => {
    const request = {
      surface: 'agent',
      tool: 'git',
      input: { action: 'deploy', target: 'prod' },
      context: { workspaceId: 'ws-1', actor: 'agent-1' },
    };
    const deterministicDecision = evaluateAgentActionFirewall(request);
    const fallbackDecision = evaluateFallbackAction({
      ...request, provenanceSource: PROVENANCE_SOURCES.PERMITTED_FALLBACK,
    });

    // No fallback-specific bypass: the underlying decision is identical.
    assert.equal(fallbackDecision.decision, deterministicDecision.decision);
    assert.equal(fallbackDecision.reason, deterministicDecision.reason);
    assert.notEqual(fallbackDecision.decision, 'allow');
    assert.equal(fallbackDecision.metadata.provenanceSource, PROVENANCE_SOURCES.PERMITTED_FALLBACK);
  });

  it('6. an unverified fallback Experience is ineligible for learning -- existing rejection code, none invented', () => {
    const eligibility = resolveLearningEligibility({
      executionStatus: 'completed',
      outcomeStatus: 'unknown',
    });
    assert.equal(eligibility.eligibility, 'ineligible');

    const pool = createLearningPool();
    const admitted = pool.admit({
      runId: 'run-fallback-unverified',
      sourceHashes: ['hash-1'],
      scope: { workspaceId: 'ws-1' },
      learningEligibility: eligibility.eligibility,
      // provenanceSource is an extra attribute the pool never inspects --
      // LLM usage is provenance, never an automatic rejection (contract.js's
      // own rule) -- so its presence changes nothing about the verdict.
      provenanceSource: PROVENANCE_SOURCES.PERMITTED_FALLBACK,
    });
    assert.equal(admitted.decision, 'rejected');
    assert.equal(admitted.code, CODES.REJECTED_INELIGIBLE);
  });

  it('7. verified fallback Experience still needs a separate paranoidMode deterministic-execution proof to promote past insufficient-data', () => {
    const trustRegistry = createCapabilityTrustRegistry();
    trustRegistry.createCapability({
      workspaceId: 'ws-1', capabilityId: 'discovered-cap', boundProcedureVersion: 'v0',
    });
    assert.equal(trustRegistry.get('ws-1', 'discovered-cap').trustState, TRUST_STATES.INSUFFICIENT_DATA);

    // Verification alone (paranoidMode absent) does not shortcut promotion.
    const withoutParanoid = promoteDerivedProcedureFromFallback({
      trustRegistry, workspaceId: 'ws-1', capabilityId: 'discovered-cap', newProcedureVersion: 'v1',
      paranoidMode: false, deterministicPathCheck: { ok: true },
    });
    assert.equal(withoutParanoid.ok, false);
    assert.equal(withoutParanoid.code, 'paranoid_mode_required');
    assert.equal(trustRegistry.get('ws-1', 'discovered-cap').trustState, TRUST_STATES.INSUFFICIENT_DATA);

    // paranoidMode true but a failing deterministic-path check still refuses.
    const failingProof = assertParanoidDeterministicProof({
      paranoidMode: true, deterministicPathCheck: { ok: false, violations: [{ modelModule: 'llmAdapter.js' }] },
    });
    assert.equal(failingProof.ok, false);
    assert.equal(failingProof.code, 'deterministic_path_check_failed');

    // Both paranoidMode AND a clean check:deterministic-path result (reused,
    // not reimplemented) are required together before promotion proceeds.
    const cleanCheck = checkDeterministicPath();
    assert.equal(cleanCheck.ok, true);
    const promoted = promoteDerivedProcedureFromFallback({
      trustRegistry, workspaceId: 'ws-1', capabilityId: 'discovered-cap', newProcedureVersion: 'v1',
      paranoidMode: true, deterministicPathCheck: cleanCheck,
    });
    assert.equal(promoted.ok, true);
    assert.notEqual(trustRegistry.get('ws-1', 'discovered-cap').trustState, TRUST_STATES.INSUFFICIENT_DATA);
  });

  it('8. fallbackPreferredOverCount increments only when a structurally-matching capability existed', () => {
    const trustRegistry = createCapabilityTrustRegistry();
    trustRegistry.createCapability({ workspaceId: 'ws-1', capabilityId: 'cap-a', boundProcedureVersion: 'v1' });

    // Case A: no structural match at all -- nothing was bypassed.
    const noMatchRouting = decideRoute({
      requestId: 'req-a',
      request: { declared: { fileType: 'unknown-ext' } },
      candidates: [{
        capabilityId: 'cap-a', preconditions: { fileType: 'js' }, trustState: 'trusted', boundProcedureVersion: 'v1',
      }],
    });
    assert.equal(noMatchRouting.decision.refusalReason, REFUSAL_REASONS.NO_STRUCTURAL_MATCH);
    const resultA = applyFallbackPreferredOverCount(trustRegistry, {
      workspaceId: 'ws-1', routingDecision: noMatchRouting.decision,
    });
    assert.deepEqual(resultA.incremented, []);
    assert.equal(trustRegistry.get('ws-1', 'cap-a').fallbackPreferredOverCount, 0);

    // Case B: structural match, but excluded (demoted) -- fallback bypassed
    // a candidate that did exist.
    const matchButIneligibleRouting = decideRoute({
      requestId: 'req-b',
      request: { declared: { fileType: 'js' } },
      candidates: [{
        capabilityId: 'cap-a', preconditions: { fileType: 'js' }, trustState: 'demoted', boundProcedureVersion: 'v1',
      }],
    });
    assert.equal(matchButIneligibleRouting.decision.refusalReason, REFUSAL_REASONS.NO_ELIGIBLE_MATCH);
    const resultB = applyFallbackPreferredOverCount(trustRegistry, {
      workspaceId: 'ws-1', routingDecision: matchButIneligibleRouting.decision,
    });
    assert.deepEqual(resultB.incremented, ['cap-a']);
    assert.equal(trustRegistry.get('ws-1', 'cap-a').fallbackPreferredOverCount, 1);
  });

  it('9. a standing grant past its mandatory expiry refuses, not warns', () => {
    // Mandatory expiry: cannot even build a grant without one.
    const noExpiry = createStandingGrant({
      workspaceId: 'ws-1', capabilityClass: 'read', maxRiskTier: 'low', grantedBy: 'operator-1',
    });
    assert.equal(noExpiry.ok, false);
    assert.equal(noExpiry.code, 'invalid_standing_grant');

    const registry = createPermittedFallbackRegistry();
    registry.registerStandingGrant({
      workspaceId: 'ws-1', capabilityClass: 'read', maxRiskTier: 'low', grantedBy: 'operator-1', expiresAt: PAST,
    });

    const result = registry.evaluateFallbackPermission({
      workspaceId: 'ws-1', capabilityClass: 'read', riskTier: 'low', runId: 'run-1',
      priorRefusalReason: REFUSAL_REASONS.NO_STRUCTURAL_MATCH,
    });
    // Refused, not a degraded "allowed with warning" shape.
    assert.equal(result.allowed, false);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'no_grant');
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'warning'), false);
  });
});
