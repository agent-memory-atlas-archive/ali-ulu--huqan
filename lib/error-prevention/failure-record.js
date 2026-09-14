'use strict';

const { buildActionFingerprint, buildFailureFingerprint } = require('./fingerprint');
const { makeId } = require('./decision');

function buildFailureRecord({ input, action, observed, evidence, trust, verification }) {
  const failureFingerprint = buildFailureFingerprint(input);
  return {
    kind: 'failure_record', schemaVersion: '1.0.0',
    failureId: makeId('failure', { failureFingerprint }),
    source: trust.source, verificationStatus: trust.verificationStatus, trust: trust.trust,
    verificationReason: verification.reason,
    action: { ...action, actionFingerprint: buildActionFingerprint(input) },
    expected: typeof input.expected === 'string' ? input.expected.trim() : '', observed, evidence, failureFingerprint,
    workspaceId: action.workspaceId, recordedAt: new Date().toISOString(),
  };
}

module.exports = { buildFailureRecord };
