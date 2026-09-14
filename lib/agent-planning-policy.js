'use strict';

// The legacy agent's planning policy: the objective a goal asks for, the tool
// order scored against tool health, goal history and recent failures, and the
// plan step template per objective. Moved out of agent.js (#2130) unchanged.
const { lower } = require('./agent-memory-state');
const { stepFailureSignature } = require('./agent-failure-signature');
const { findGoalRecord, findRecentFailure } = require('./agent-memory-records');
function planningPolicy({ goal, objective, memory }) {
  const text = lower(goal);
  const baseOrders = {
    learn: ['learn', 'verify', 'ask'],
    verify: ['ask', 'verify', 'reason', 'dream'],
    compare: ['ask', 'compare', 'dream', 'verify'],
    reason: ['ask', 'reason', 'verify', 'dream'],
    dream: ['dream', 'ask', 'verify'],
    plan: ['ask', 'verify', 'dream', 'reason'],
    investigate: ['ask', 'verify', 'reason', 'dream'],
  };
  const signals = [];
  const failureHits = [];
  if (/(ignore|yok say|sistem mesaj|system prompt|developer message|gizli komut)/i.test(text)) {
    signals.push('manipulation');
  }
  if (/\b(mi|mı|mu|mü)\b/.test(text) || /\?$/.test(text)) {
    signals.push('question');
  }
  if (/(plan|task|görev|ajan|workflow|adım)/i.test(text)) {
    signals.push('workflow');
  }
  const base = baseOrders[objective] || baseOrders.investigate;
  const scores = new Map(base.map((tool, index) => [tool, 100 - index * 10]));
  const scoreReasons = new Map(base.map(tool => [tool, ['objective-default']]));
  const bump = (tool, amount, reason) => {
    scores.set(tool, (scores.get(tool) || 0) + amount);
    const reasons = scoreReasons.get(tool) || [];
    reasons.push(reason);
    scoreReasons.set(tool, reasons);
  };
  const toolStats = memory?.stats?.tools || {};
  for (const [tool, stat] of Object.entries(toolStats)) {
    const success = Number(stat.success || 0);
    const blocked = Number(stat.blocked || 0);
    const error = Number(stat.error || 0);
    const planned = Number(stat.planned || 0);
    const boost = success * 4 - blocked * 5 - error * 7;
    if (scores.has(tool) && boost !== 0) {
      bump(tool, boost, boost > 0 ? 'tool-health-positive' : 'tool-health-negative');
    }
    if (planned > 0 && (blocked + error) > success && scores.has(tool)) {
      signals.push('tool-health-risk');
    }
  }
  if (signals.includes('manipulation')) {
    bump('verify', 25, 'manipulation-risk');
    bump('reason', 8, 'manipulation-risk');
  }
  const goalRecord = findGoalRecord(memory, goal);
  if (goalRecord) {
    signals.push('known-goal');
    bump('ask', 6, 'known-goal');
    if (goalRecord.status === 'completed') {
      signals.push('known-goal-success');
      bump('verify', 5, 'known-goal-success');
    }
    if (goalRecord.status === 'blocked' || goalRecord.status === 'error') {
      signals.push('known-goal-risk');
      bump('dream', 10, 'known-goal-risk');
      bump('reason', 6, 'known-goal-risk');
    }
  }
  for (const tool of base) {
    const sig = stepFailureSignature({ tool, action: tool, input: goal }, { goal });
    const failure = findRecentFailure(memory, sig);
    if (failure) {
      failureHits.push({ tool, error: failure.error, attempt: failure.attempt });
      signals.push('recent-failure');
      bump(tool, -35, 'recent-failure');
    }
  }
  const toolScores = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([tool, score]) => ({
      tool,
      score,
      reasons: scoreReasons.get(tool) || [],
    }));
  const ordered = toolScores.map(item => item.tool);
  for (const tool of base) {
    if (!ordered.includes(tool)) ordered.push(tool);
  }
  return {
    objective,
    selectedTools: ordered.slice(0, 4),
    baseTools: base,
    signals,
    failureHits,
    toolScores,
    rationale: signals.includes('manipulation')
      ? 'Risk-aware policy boosted verify and reason first.'
      : signals.includes('recent-failure')
        ? 'Recent failure history reduced repeated tool choices.'
      : signals.includes('tool-health-risk')
        ? 'Tool health history reduced unreliable choices.'
      : goalRecord
        ? 'Known goal found in memory, so the planner keeps a slightly stronger ask/verify mix.'
        : 'Default tool policy selected by objective.',
  };
}

function objectiveForGoal(goal) {
  const text = lower(goal);
  if (/(öğren|ekle|kaydet|teach|learn)/i.test(text)) return 'learn';
  if (/(karşılaştır|kıyas|compare|vs)/i.test(text)) return 'compare';
  if (/(neden|niçin|why)/i.test(text)) return 'reason';
  if (/(doğrula|kontrol et|verify|çeliş|risk|manipül)/i.test(text)) return 'verify';
  if (/\b(mi|mı|mu|mü)\b/.test(text) || /\?$/.test(text)) return 'verify';
  if (/(hipotez|öner|dream|rüya|fikir)/i.test(text)) return 'dream';
  if (/(plan|görev|task|ajan|workflow|yap)/i.test(text)) return 'plan';
  return 'investigate';
}

function planSteps(objective, cleanedGoal) {
  const steps = [];
  const pushStep = (id, action, tool, input, rationale) => {
    steps.push({ id, action, tool, input, rationale });
  };

  if (objective === 'learn') {
    pushStep('ingest', 'learn', 'learn', cleanedGoal, 'The request is oriented towards adding knowledge.');
    pushStep('confirm', 'verify', 'verify', cleanedGoal, 'New knowledge is verified where possible.');
  } else if (objective === 'compare') {
    pushStep('context', 'ask', 'ask', cleanedGoal, 'Context is gathered for the comparison.');
    pushStep('compare', 'compare', 'compare', cleanedGoal, 'Differences between the two entities are extracted.');
  } else if (objective === 'reason') {
    pushStep('context', 'ask', 'ask', cleanedGoal, 'Context is gathered for the cause analysis.');
    pushStep('reason', 'reason', 'reason', cleanedGoal, 'A cause-and-effect chain is built.');
  } else if (objective === 'verify') {
    pushStep('context', 'ask', 'ask', cleanedGoal, 'The claim is checked against the graph.');
    pushStep('verify', 'verify', 'verify', cleanedGoal, 'Correctness and contradictions are audited.');
    pushStep('fallback', 'dream', 'dream', {}, 'If the result is unknown, a hypothesis is generated and the gap is flagged.');
  } else if (objective === 'dream') {
    pushStep('dream', 'dream', 'dream', {}, 'A hypothesis and a contextual recommendation are produced.');
    pushStep('context', 'ask', 'ask', cleanedGoal, 'Context is expanded after the hypothesis.');
  } else if (objective === 'plan') {
    pushStep('context', 'ask', 'ask', cleanedGoal, 'The scope of the task is clarified.');
    pushStep('verify', 'verify', 'verify', cleanedGoal, 'Critical claims or constraints are verified.');
    pushStep('dream', 'dream', 'dream', {}, 'Alternative paths and risks are explored.');
  } else {
    pushStep('context', 'ask', 'ask', cleanedGoal, 'General context is gathered.');
    pushStep('verify', 'verify', 'verify', cleanedGoal, 'Mevcut iddia destekleniyor mu kontrol edilir.');
    pushStep('dream', 'dream', 'dream', {}, 'Hypotheses are generated for the missing areas.');
  }
  return steps;
}

module.exports = { planningPolicy, objectiveForGoal, planSteps };
