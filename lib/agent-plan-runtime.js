'use strict';

const { normalizeGoal, firstWords } = require('./agent-memory-state');
const { prepareGoalIntegrityForPlan } = require('./goal-integrity-gate');
const { planningPolicy, objectiveForGoal, planSteps } = require('./agent-planning-policy');

function buildAgentPlan(agent, goal, opts = {}) {
  const objective = objectiveForGoal(goal);
  const cleanedGoal = normalizeGoal(goal);
  const goalIntegrity = prepareGoalIntegrityForPlan(agent, cleanedGoal, opts);
  if (!goalIntegrity.ok) return goalIntegrity.result;
  const policy = planningPolicy({ goal: cleanedGoal, objective, memory: agent.memory });
  const steps = planSteps(objective, cleanedGoal);
  const plan = {
    goal: cleanedGoal,
    objective,
    shortGoal: firstWords(cleanedGoal, 5),
    steps: steps.slice(0, Math.max(1, opts.maxSteps || agent.maxSteps)),
    selectedTools: [...policy.selectedTools],
    maxSteps: Math.max(1, opts.maxSteps || agent.maxSteps),
    status: 'planned',
    confidence: objective === 'investigate' ? 0.58 : 0.74,
    policy,
    goalIntegrity: goalIntegrity.scope,
    memory: {
      knownGoals: agent.memory.goals.length,
      previousRuns: agent.memory.runs.filter(run => run?.key === agent._goalKey(cleanedGoal)).length,
      resumed: Boolean(agent._findResumeRun(cleanedGoal)),
    },
    rationale: objective === 'investigate'
      ? 'The overall objective is unclear; gather context first, then decide.'
      : 'The objective signal is clear; the relevant tools were ordered.',
  };
  agent.lastPlan = plan;
  agent.activeGoal = cleanedGoal;
  agent._emit('beforePlan', plan);
  agent._emit('afterPlan', plan);
  agent._rememberPlan(plan);
  return agent.ok('plan', plan, [], { objective });
}

module.exports = { buildAgentPlan };
