'use strict';

// kernel.learn orchestration over built provenance, moved verbatim from
// lib/provenance-ingest.js (#2246): collect input text/provenance, build it,
// project safe learn opts (caller-supplied mutationOperationId survives,
// provenance/trust fields are replaced by built values), run kernel.learn
// and package the admission envelope. Pure building stays in
// lib/provenance-ingest.js; this module is the only direction of the edge.

const { loadTrustPolicy } = require('./trust-policy');
const { buildProvenance } = require('./provenance-ingest');
const { sanitize } = require('./provenance-record-utils');

async function ingestWithProvenance(kernel, input = {}, opts = {}) {
  if (!kernel || typeof kernel.learn !== 'function') {
    throw new Error('kernel.learn gerekli');
  }

  const strictProvenance = Boolean(kernel.strictProvenance || opts.strictProvenance);
  const trustPolicyPath = opts.trustPolicyPath;
  const trustPolicy = opts.trustPolicy || loadTrustPolicy(trustPolicyPath);
  const text = sanitize(input.text || input.statement || opts.text || opts.statement, '');
  if (!text) {
    throw new Error('text veya statement gerekli');
  }

  const provenanceInput = input.provenance || opts.provenance || {
    provenanceId: input.provenanceId || opts.provenanceId || '',
    sourceRef: input.sourceRef || opts.sourceRef || '',
    sourceTitle: input.sourceTitle || opts.sourceTitle || '',
    sourceType: input.sourceType || opts.sourceType || '',
    sourceSubType: input.sourceSubType || opts.sourceSubType || '',
    actor: input.actor || opts.actor || '',
    timestamp: input.timestamp || opts.timestamp || '',
    confidence: input.confidence ?? opts.confidence,
    workspaceId: input.workspaceId || opts.workspaceId || '',
  };

  const built = buildProvenance(provenanceInput, {
    strictProvenance,
    trustPolicy,
    trustPolicyPath,
    sourceType: provenanceInput.sourceType,
    sourceSubType: provenanceInput.sourceSubType,
    sourceRef: provenanceInput.sourceRef,
    sourceTitle: provenanceInput.sourceTitle,
    actor: provenanceInput.actor,
    timestamp: provenanceInput.timestamp,
    workspaceId: provenanceInput.workspaceId,
  });

  const learnOpts = { ...opts };
  for (const key of [
    'provenance',
    'trustPolicy',
    'trustPolicyPath',
    'sourceRef',
    'sourceTitle',
    'actor',
    'timestamp',
    'confidence',
  ]) {
    delete learnOpts[key];
  }
  learnOpts.provenance = built.provenance;
  learnOpts.sourceType = built.provenance.sourceType;
  if (built.provenance.sourceSubType) learnOpts.sourceSubType = built.provenance.sourceSubType;
  learnOpts.workspaceId = built.provenance.workspaceId;

  const learnResult = kernel.learn(text, learnOpts);
  const learnedCount = Number(learnResult?.data?.learned || 0);
  const skippedCount = Number(learnResult?.data?.skipped || 0);
  const admissionOutcome = learnedCount > 0 ? 'admitted' : 'skipped';

  return {
    ...learnResult,
    provenance: built.provenance,
    provenanceWarnings: built.warnings,
    admission: {
      outcome: admissionOutcome,
      targetType: 'learn',
      targetId: text,
      workspaceId: built.provenance.workspaceId,
      provenanceId: built.provenance.provenanceId,
      sourceRef: built.provenance.sourceRef,
      graphWrite: learnedCount > 0,
      learned: learnedCount,
      skipped: skippedCount,
    },
  };
}

module.exports = { ingestWithProvenance };
