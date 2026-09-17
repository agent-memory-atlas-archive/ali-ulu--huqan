const { DEFAULT_SEMANTIC_THRESHOLDS, normalizeSemanticClassification } = require('./semantic-score');
const { decomposeClaim } = require('./claim-decomposition');
const { aggregateSubclaimVerdicts, buildReasoningTrace } = require('./reasoning-trace');
const {
  detectAbsoluteClaim,
  detectAliasNormalization,
  detectDoubleNegation,
  detectHighRiskDomain,
  detectMultilingualAmbiguity,
  detectStrawmanAttribution,
  detectWeakPartialMatch,
  detectWeaselWords,
} = require('./risk-rules');
const { runContradictionRules } = require('./contradiction-rules');
const { partitionSignalsByKind } = require('./verify-contradiction-evidence');
const { analyzeFuzzyOverlap } = require('./fuzzy-normalization');
const { runSemanticSignals } = require('./semantic-signals');
const { detectTypeLatticeConflict } = require('./type-lattice');
const { resolveEntity } = require('./entity-resolution');

function edgeClaim(edge = {}) {
  return {
    text: `${edge.from || ''} ${edge.relation || ''} ${edge.to || ''}`.trim(),
    subject: edge.from || '',
    relation: edge.relation || '',
    object: edge.to || '',
    to: edge.to || '',
  };
}

function buildCausalPreventionConflict(subject, directEdge, statement, incomingPrevents) {
  if (directEdge?.relation !== 'CAUSES' || !incomingPrevents) return null;
  const confidence = Math.min(0.95, (directEdge.strength ?? directEdge.confidence ?? directEdge.weight ?? 0.5) + 0.3);
  return {
    data: { status: 'contradicted', confidence },
    evidence: [{
      kind: 'contradiction',
      text: `${subject} --[CAUSES]--> ${directEdge.to} conflicts with prevention claim: "${statement}"`,
      confidence,
      nodes: [subject, directEdge.to],
      edges: [{ from: subject, to: directEdge.to, relation: 'CAUSES' }],
    }],
  };
}

function uniqueFlags(signals = []) {
  return [...new Set([].concat(...signals.map(signal => Array.isArray(signal?.flags) ? signal.flags : [])))].filter(Boolean);
}

function maxSignalScore(signals = []) {
  return signals.reduce((max, signal) => Math.max(
    max,
    Number(signal?.severity) || 0,
    Number(signal?.confidence) || 0,
  ), 0);
}

function buildVerifySemanticTrust({
  statement = '',
  result = {},
  evidence = [],
  subject = '',
  predicate = '',
  edges = [],
  workspaceId = 'default',
  pathSearch = null,
  fuzzy = null,
  typeConflict = null,
  contradictionSignals: seedContradictionSignals = [],
}) {
  const evidenceList = Array.isArray(evidence) ? evidence : [];
  const evidenceKinds = [...new Set(evidenceList.map(item => String(item?.kind || '').trim()).filter(Boolean))];
  const rawConfidence = Number(result?.confidence) || 0;
  const hasPartialEvidence = evidenceKinds.includes('partial_match');
  const hasPathEvidence = evidenceKinds.includes('path');
  const hasDirectEvidence = evidenceKinds.includes('direct_edge');

  let supportScore = 0;
  if (result?.status === 'verified') {
    if (hasPartialEvidence) {
      supportScore = Math.min(rawConfidence || 0.35, 0.49);
    } else if (hasPathEvidence) {
      supportScore = rawConfidence;
    } else if (hasDirectEvidence) {
      supportScore = rawConfidence;
    } else {
      supportScore = rawConfidence;
    }
  } else if (result?.status === 'contradicted') {
    supportScore = 0;
  } else {
    supportScore = hasPartialEvidence ? Math.min(rawConfidence || 0.35, 0.49) : rawConfidence;
  }

  const riskSignals = [];
  const contradictionSignals = Array.isArray(seedContradictionSignals) ? [...seedContradictionSignals] : [];

  if (typeConflict) contradictionSignals.push(typeConflict);

  const weakPartial = result?.status !== 'contradicted' && (evidenceList.length > 0 || result?.status === 'verified')
    ? detectWeakPartialMatch({ confidence: supportScore, evidence: evidenceList }, {})
    : null;
  if (weakPartial) riskSignals.push(weakPartial);

  const highRisk = detectHighRiskDomain(statement, {});
  if (highRisk) riskSignals.push(highRisk);

  const absolute = detectAbsoluteClaim(statement, {});
  if (absolute) riskSignals.push(absolute);

  const doubleNegation = detectDoubleNegation(statement, {});
  if (doubleNegation) riskSignals.push(doubleNegation);

  const weaselWords = detectWeaselWords(statement, {});
  if (weaselWords) riskSignals.push(weaselWords);

  const strawman = detectStrawmanAttribution(statement, {});
  if (strawman) riskSignals.push(strawman);

  const aliasNormalization = detectAliasNormalization(statement, {});
  if (aliasNormalization) riskSignals.push(aliasNormalization);

  const multilingual = detectMultilingualAmbiguity(statement, {});
  if (multilingual) riskSignals.push(multilingual);

  if (result?.status !== 'verified' && Array.isArray(edges) && edges.length > 0) {
    const incoming = {
      text: statement,
      subject,
      relation: predicate,
      object: predicate,
      to: predicate,
    };
    for (const edge of edges) {
      const signals = runContradictionRules(edgeClaim(edge), incoming, {});
      // #1619: route by the signal's own `kind`. PREDICATE_DRIFT declares
      // itself `risk` -- "not a refutation" -- yet was scored as one here,
      // which turned every differently-worded fact about a known subject into
      // an evidence-free `contradicted` at 0.6.
      const { contradictions, risks } = partitionSignalsByKind(signals);
      contradictionSignals.push(...contradictions);
      riskSignals.push(...risks);
    }
  }

  if (result?.status === 'contradicted' && contradictionSignals.length === 0) {
    contradictionSignals.push({
      rule: 'VERIFY_CONTRADICTION',
      kind: 'contradiction',
      severity: 0.9,
      confidence: Math.max(0.7, rawConfidence),
      flags: ['VERIFY_CONTRADICTION'],
      detail: 'Verify returned contradiction.',
      evidence: evidenceList,
      meta: { statement, subject, predicate },
    });
  }

  const contradictionScore = maxSignalScore(contradictionSignals);
  const riskScore = maxSignalScore(riskSignals);

  let status = ['verified', 'contradicted', 'unknown'].includes(result?.status) ? result.status : 'unknown';
  if ((hasPartialEvidence || hasPathEvidence || hasDirectEvidence) && status === 'verified' && supportScore < DEFAULT_SEMANTIC_THRESHOLDS.supportVerified) {
    status = 'unknown';
  } else if (status !== 'verified' && contradictionScore >= DEFAULT_SEMANTIC_THRESHOLDS.contradictionConflict) {
    status = 'contradicted';
  }

  const matchType = hasPartialEvidence
    ? 'partial_match'
    : hasPathEvidence
      ? 'path'
      : hasDirectEvidence
        ? 'direct_edge'
        : contradictionSignals.length > 0
          ? 'contradiction'
          : 'unknown';

  const signals = [...contradictionSignals, ...riskSignals];
  const warnings = uniqueFlags(signals);
  const semanticTrust = normalizeSemanticClassification({
    status,
    supportScore,
    contradictionScore,
    riskScore,
    matchType,
    warnings,
    risk: {
      flags: warnings,
      domain: highRisk?.meta?.domain || null,
      manipulation: false,
      absoluteClaim: Boolean(absolute),
      relationDrift: warnings.includes('RELATION_DRIFT'),
      highRisk: Boolean(highRisk),
    },
    signals,
      meta: {
        statement,
        subject,
        predicate,
        workspaceId,
        evidenceKinds,
        pathSearch,
        fuzzy,
        thresholds: { ...DEFAULT_SEMANTIC_THRESHOLDS },
      },
    });

  return {
    ...semanticTrust,
    confidence: Math.max(rawConfidence, semanticTrust.supportScore || 0, semanticTrust.contradictionScore || 0),
    thresholds: { ...DEFAULT_SEMANTIC_THRESHOLDS },
  };
}

function pathSupportConfidence(graph, path, workspaceId) {
  const weights = [];
  for (let index = 0; index < path.length - 1; index += 1) {
    const from = path[index];
    const to = path[index + 1];
    const edge = graph.getEdges(from, workspaceId).find(candidate => candidate.to === to)
      || graph.getEdges(to, workspaceId).find(candidate => candidate.to === from);
    const weight = edge?.confidence ?? edge?.weight;
    if (typeof weight === 'number' && Number.isFinite(weight)) weights.push(weight);
  }
  const weakestWeight = weights.length > 0 ? Math.min(...weights) : 0.5;
  return Number(Math.min(0.95, weakestWeight + 0.3).toFixed(6));
}

module.exports = {
  edgeClaim,
  buildCausalPreventionConflict,
  uniqueFlags,
  maxSignalScore,
  pathSupportConfidence,
  buildVerifySemanticTrust,
};

