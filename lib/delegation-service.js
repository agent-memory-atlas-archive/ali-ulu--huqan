'use strict';

/**
 * DelegationService v0: the single future boundary for multi-task delegation
 * (#2505/E1).
 *
 * v0 validates only. It evaluates a caller-supplied delegation plan with the
 * cascade guard's own plan validation and returns a frozen, receipt-compatible
 * verdict. No execution is rerouted through anything in this slice; existing
 * execution paths are untouched, and the guard's `run()` is not called here.
 *
 * The guard stays a coordinator, never a planner: the plan (task ids, owning
 * agents, dependencies) arrives built, and this service answers whether it is
 * structurally admissible (bounded fan-out, known dependencies, no cycles,
 * no self-dependency, no duplicates). Policy verdicts (allow/review/block),
 * a plan compiler, execution rerouting, and a review/HITL state machine are
 * explicitly deferred slices, in that order.
 */

const { REASONS, validatePlan } = require('./multi-agent-cascade-guard');

const DEFAULT_MAX_FAN_OUT = 4;

function createDelegationService(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options must be an object');
  }
  const maxFanOut = options.maxFanOut === undefined ? DEFAULT_MAX_FAN_OUT : options.maxFanOut;
  if (!Number.isInteger(maxFanOut) || maxFanOut < 1 || maxFanOut > 64) {
    throw new TypeError('maxFanOut must be an integer between 1 and 64');
  }

  return Object.freeze({ evaluatePlan });

  function evaluatePlan(plan) {
    const tasks = Array.isArray(plan) ? plan : plan && plan.tasks;
    let validated;
    try {
      validated = validatePlan(tasks, maxFanOut);
    } catch (error) {
      return Object.freeze({
        ok: false,
        reason: REASONS.INVALID_PLAN,
        error: String((error && error.message) || error),
        tasks: Object.freeze([]),
      });
    }
    const roots = validated.plan.filter((task) => task.dependsOn.length === 0).length;
    return Object.freeze({
      ok: true,
      reason: 'DELEGATION_PLAN_VALID',
      tasks: Object.freeze(validated.plan.map((task) => Object.freeze({
        id: task.id,
        agentId: task.agentId,
        dependsOn: task.dependsOn,
      }))),
      taskCount: validated.plan.length,
      rootCount: roots,
      maxFanOut,
    });
  }
}

module.exports = { createDelegationService, DEFAULT_MAX_FAN_OUT };
