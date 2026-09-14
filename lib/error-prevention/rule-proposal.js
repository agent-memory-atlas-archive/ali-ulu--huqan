'use strict';

const { makeId } = require('./decision');

const ENFORCEMENTS = Object.freeze(['warn', 'require_verify', 'block']);

function cleanString(value) { return typeof value === 'string' ? value.trim() : ''; }
function clampRisk(value, fallback = 20) {
  const score = Number(value);
  return Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : fallback;
}

function buildRuleProposal(failureMemoryId, input, failure, workspaceId) {
  const enforcement = ENFORCEMENTS.includes(input.enforcement) ? input.enforcement : 'require_verify';
  const action = failure.action || {};
  const trigger = {
    actionFingerprint: action.actionFingerprint, tool: action.tool,
    operation: action.operation, repo: action.repo, path: action.path,
  };
  return {
    kind: 'error_prevention_rule', schemaVersion: '1.0.0',
    ruleId: makeId('rule', { failureId: failure.failureId, trigger, constraint: input.constraint, enforcement }),
    status: 'proposed', enforcement, riskScore: clampRisk(input.riskScore, enforcement === 'block' ? 40 : 20), trigger,
    constraint: cleanString(input.constraint) || 'Do not repeat the verified failure pattern.',
    remediation: cleanString(input.remediation), sourceFailureId: failure.failureId,
    sourceFailureMemoryId: failureMemoryId, activationEligible: failure.verificationStatus === 'verified',
    workspaceId, proposedAt: new Date().toISOString(),
  };
}

module.exports = { buildRuleProposal, clampRisk, ENFORCEMENTS };
