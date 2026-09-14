const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Dream = require('./dream');
const { INTERNAL_TOOLS, evaluateToolPolicy } = require('./toolPolicy');
const { mcpToolPolicy } = require('./lib/mcp-tool-policy');
const { buildFinalSummary } = require('./finalizer');
const { renderRunReport } = require('./lib/agent-report-renderer');
const { emitGateTelemetry } = require('./lib/gate-telemetry');
const { enforceAgentActionStep } = require('./lib/agent-action-firewall');
const { createExecutionScope, evaluateGoalBinding } = require('./lib/goal-binding');
const { prepareGoalIntegrityForPlan } = require('./lib/goal-integrity-gate');
const { initializeBehavioralState, behavioralBlockResult } = require('./lib/agent-behavioral-integrity');
const { stepFailureSignature } = require('./lib/agent-failure-signature');
const {
  cloneValue,
  nowIso,
  normalizeGoal,
  firstWords,
  stripQuestionMarks,
  normalizeSummaryText,
  normalizeMemoryPath,
  defaultMemoryState,
} = require('./lib/agent-memory-state');
const { extractAgentSummary, buildRunRecommendations, suggestNextAction, chooseFollowUp } = require('./lib/agent-run-guidance');
const { noteMemoryFailure, resetMemoryPersistence, runEnvelopeMeta } = require('./lib/agent-memory-persistence');
const { normalizeMemory, goalKey, findGoalRecord, findResumeRun, updateToolStats, updateObjectiveStats, pruneMemory, findRecentFailure } = require('./lib/agent-memory-records');
const { planningPolicy, objectiveForGoal, planSteps } = require('./lib/agent-planning-policy');
const DEFAULT_MAX_STEPS = 4;
const ALLOWED_TOOLS = INTERNAL_TOOLS;
// #2130: one handler per internal tool; a new tool is a row, not a case.
const INTERNAL_TOOL_HANDLERS = Object.freeze(Object.assign(Object.create(null), {
  learn: (agent, step, state, opts) => agent.kernel.learn(step.input, opts.learnOpts || {}),
  ask: (agent, step, state, opts) => agent.kernel.ask(step.input, opts.askOpts || {}),
  verify: (agent, step, state, opts) => agent.kernel.verify(step.input, opts.verifyOpts || {}),
  reason: (agent, step, state, opts) => agent.kernel.reason(stripQuestionMarks(step.input || state.goal), opts.reasonOpts || {}),
  compare: (agent, step, state, opts) => {
    const text = String(step.input || state.goal);
    const parts = text.split('|').map(s => s.trim()).filter(Boolean);
    if (parts.length >= 2) return agent.kernel.compare(parts[0], parts[1], opts.compareOpts || {});
    return agent.kernel.compare(firstWords(text, 2), firstWords(text.split(/\s+/).slice(2).join(' '), 2), opts.compareOpts || {});
  },
  dream: (agent, step, state, opts) => (agent.dream ? agent.dream.dream(opts.dreamOpts || {}) : agent.kernel.dream(opts.dreamOpts || {})),
}));
function unsupportedToolResult(agent, step) {
  return { ok: false, type: 'agent', data: null, evidence: [], error: { code: 'UNSUPPORTED_TOOL', message: `Unsupported tool: ${String(step.tool || 'unknown')}` }, meta: { blocked: true, allowedTools: [...ALLOWED_TOOLS] } };
}
class Agent {
  constructor(opts = {}) {
    this.kernel = opts.kernel;
    this.plugins = this.kernel?.plugins;
    this.dream = opts.dream || (this.kernel ? new Dream(this.kernel) : null);
    this.maxSteps = opts.maxSteps || DEFAULT_MAX_STEPS;
    this.memoryPath = normalizeMemoryPath(opts, this.kernel);
    this.storage = opts.storage || null;
    this.memory = this._loadMemory();
    this.lastPlan = null;
    this.lastRun = null;
    this.activeGoal = null;
  }
  _emit(event, data) {
    try { this.kernel?.observability?.recordLifecycle?.(event, data); } catch (_) {}
    if (this.plugins && typeof this.plugins.emit === 'function') this.plugins.emit(event, data);
    return data;
  }
  ok(type, data = null, evidence = [], meta = {}) {
    if (this.kernel && typeof this.kernel.ok === 'function') {
      return this.kernel.ok(type, data, evidence, meta);
    }
    return {
      ok: true,
      type,
      data,
      evidence: Array.isArray(evidence) ? evidence : [],
      error: null,
      meta,
    };
  }
  fail(type, code, message, evidence = [], meta = {}, data = null) {
    if (this.kernel && typeof this.kernel.fail === 'function') {
      const result = this.kernel.fail(type, code, message, meta);
      result.data = data;
      if (Array.isArray(evidence) && evidence.length) {
        result.evidence = evidence;
      }
      return result;
    }
    return {
      ok: false,
      type,
      data,
      evidence: Array.isArray(evidence) ? evidence : [],
      error: { code, message },
      meta,
    };
  }
  _collectEvidence(items = []) {
    const evidence = [];
    for (const item of items) {
      if (item && Array.isArray(item.evidence)) evidence.push(...item.evidence);
    }
    return evidence.filter(Boolean);
  }
  _isStalledProgress(previousSummary, currentSummary) {
    const prev = normalizeSummaryText(previousSummary);
    const curr = normalizeSummaryText(currentSummary);
    if (!curr) return true;
    if (curr === 'bilmiyorum' || curr === 'unknown' || curr === 'unknown') return true;
    if (!prev) return false;
    return curr === prev;
  }
  _loadMemory() {
    if (!this.memoryPath) return defaultMemoryState();
    if (!fs.existsSync(this.memoryPath)) return defaultMemoryState();
    const serialized = fs.readFileSync(this.memoryPath, 'utf8');
    try {
      const parsed = JSON.parse(serialized);
      return this._normalizeMemory(parsed);
    } catch (error) {
      const backupPath = `${this.memoryPath}.corrupt-${crypto.randomUUID()}`;
      fs.renameSync(this.memoryPath, backupPath);
      const corruptError = new Error(`Agent memory is corrupt; original moved to ${backupPath}`);
      corruptError.cause = error;
      throw corruptError;
    }
  }
  _normalizeMemory(memory = {}) { return normalizeMemory(memory); }

  _saveMemory() {
    if (!this.memoryPath) return;
    let tempPath;
    try {
      const dir = path.dirname(this.memoryPath);
      if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
      tempPath = path.join(dir, `.${path.basename(this.memoryPath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
      fs.writeFileSync(tempPath, JSON.stringify(this.memory, null, 2));
      fs.renameSync(tempPath, this.memoryPath);
    } catch (error) {
      if (tempPath) {
        try { fs.unlinkSync(tempPath); } catch (_) { /* best-effort cleanup */ }
      }
      noteMemoryFailure(this, 'saveMemory', error);
    }
  }

  _goalKey(goal) { return goalKey(goal); }

  _findGoalRecord(goal) { return findGoalRecord(this.memory, goal); }

  _findResumeRun(goal) { return findResumeRun(this.memory, goal); }

  _updateToolStats(tool, status) { updateToolStats(this.memory, tool, status); }

  _updateObjectiveStats(objective, status) { updateObjectiveStats(this.memory, objective, status); }

  _pruneMemory() { pruneMemory(this.memory); }

  _recordGoal(goal, objective, status, meta = {}) {
    const key = this._goalKey(goal);
    const entry = {
      key,
      goal: normalizeGoal(goal),
      objective,
      status,
      updatedAt: nowIso(),
      ...meta,
    };
    this.memory.goals.push(entry);
    this._pruneMemory();
    if (this.storage && typeof this.storage.saveGoalMemory === 'function') {
      try {
        this.storage.saveGoalMemory({
          goal: entry.goal,
          objective,
          status,
          completedSteps: meta.completedSteps || 0,
          finalAnswer: meta.finalAnswer || '',
          resumed: Boolean(meta.resumed),
          selectedTools: meta.selectedTools || [],
        });
      } catch (error) { noteMemoryFailure(this, 'saveGoalMemory', error); }
    }
  }

  _stepSignature(step = {}, state = {}) {
    return stepFailureSignature(step, state);
  }

  _findRecentFailure(signature) { return findRecentFailure(this.memory, signature); }

  _recordFailure(step, state, result, attempt = 1) {
    const signature = this._stepSignature(step, state);
    const entry = {
      signature,
      tool: step.tool,
      action: step.action,
      goal: normalizeGoal(state.goal),
      error: result?.error?.message || result?.error?.code || result?.error || 'unknown',
      attempt,
      updatedAt: nowIso(),
    };
    this.memory.failures.push(entry);
    this._pruneMemory();
    this._saveMemory();
    return entry;
  }

  _rememberPlan(plan, meta = {}) {
    const entry = {
      id: crypto.randomUUID?.() || `plan-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      goal: plan.goal,
      key: this._goalKey(plan.goal),
      objective: plan.objective,
      selectedTools: Array.isArray(plan.selectedTools) ? [...plan.selectedTools] : [],
      steps: Array.isArray(plan.steps) ? cloneValue(plan.steps) : [],
      status: plan.status || 'planned',
      confidence: plan.confidence,
      rationale: plan.rationale,
      policy: plan.policy ? cloneValue(plan.policy) : undefined,
      memory: plan.memory ? cloneValue(plan.memory) : undefined,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      ...meta,
    };
    this.memory.plans.push(entry);
    this._recordGoal(plan.goal, plan.objective, 'planned', {
      selectedTools: entry.selectedTools,
    });
    this._pruneMemory();
    this._saveMemory();
    return entry;
  }

  _rememberRun(state) {
    const entry = {
      id: state.memoryId || state.id || `run-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      goal: state.goal,
      key: this._goalKey(state.goal),
      objective: state.objective,
      selectedTools: Array.isArray(state.selectedTools) ? [...state.selectedTools] : [],
      steps: cloneValue(state.steps || []),
      queuedSteps: cloneValue(state.queuedSteps || []),
      evidence: cloneValue(state.evidence || []),
      notes: cloneValue(state.notes || []),
      plan: state.plan ? cloneValue(state.plan) : null,
      status: state.status,
      finalAnswer: state.finalAnswer,
      completedSteps: state.completedSteps || 0,
      remainingSteps: state.remainingSteps || 0,
      report: state.report || '',
      resumed: Boolean(state.resumed),
      resumedFrom: state.resumedFrom || null,
      progress: state.progress ? cloneValue(state.progress) : { stalledCount: 0, lastSummary: '' },
      startedAt: state.startedAt || nowIso(),
      updatedAt: nowIso(),
    };
    const index = this.memory.runs.findIndex(run => run.id === entry.id);
    if (index >= 0) this.memory.runs[index] = entry;
    else this.memory.runs.push(entry);
    this._updateObjectiveStats(entry.objective, state.status);
    this._recordGoal(entry.goal, entry.objective, state.status, {
      selectedTools: entry.selectedTools,
      finalAnswer: entry.finalAnswer,
      resumed: entry.resumed,
      completedSteps: entry.completedSteps,
    });
    this._pruneMemory();
    this._saveMemory();
    if (this.storage && typeof this.storage.saveRun === 'function') {
      try {
        this.storage.saveRun({
          ...entry,
          checkpointId: state.checkpointId || state.resumeToken || null,
          resumeToken: state.resumeToken || null,
          iteration: state.steps ? state.steps.length : 0,
          budgetRemaining: state.budgetRemaining || 0,
        });
      } catch (error) { noteMemoryFailure(this, 'saveRun', error); }
    }
    return entry;
  }

  _policy(goal, objective) { return planningPolicy({ goal, objective, memory: this.memory }); }

  _objective(goal) { return objectiveForGoal(goal); }

  _buildPlan(goal, opts = {}) {
    const objective = this._objective(goal);
    const cleanedGoal = normalizeGoal(goal);
    const goalIntegrity = prepareGoalIntegrityForPlan(this, cleanedGoal, opts); if (!goalIntegrity.ok) return goalIntegrity.result;
    const policy = this._policy(cleanedGoal, objective);
    const steps = planSteps(objective, cleanedGoal);

    const limitedSteps = steps.slice(0, Math.max(1, opts.maxSteps || this.maxSteps));
    const memorySummary = {
      knownGoals: this.memory.goals.length,
      previousRuns: this.memory.runs.filter(run => run && run.key === this._goalKey(cleanedGoal)).length,
      resumed: Boolean(this._findResumeRun(cleanedGoal)),
    };
    const plan = {
      goal: cleanedGoal,
      objective,
      shortGoal: firstWords(cleanedGoal, 5),
      steps: limitedSteps,
      selectedTools: [...policy.selectedTools],
      maxSteps: Math.max(1, opts.maxSteps || this.maxSteps),
      status: 'planned',
      confidence: objective === 'investigate' ? 0.58 : 0.74,
      policy,
      goalIntegrity: goalIntegrity.scope,
      memory: memorySummary,
      rationale: objective === 'investigate'
        ? 'The overall objective is unclear; gather context first, then decide.'
        : 'The objective signal is clear; the relevant tools were ordered.',
    };

    this.lastPlan = plan;
    this.activeGoal = cleanedGoal;
    this._emit('beforePlan', plan);
    this._emit('afterPlan', plan);
    this._rememberPlan(plan);
    return this.ok('plan', plan, [], { objective });
  }

  plan(goal, opts = {}) {
    return this._buildPlan(goal, opts);
  }

  _extractAgentSummary(result) {
    return extractAgentSummary(result);
  }

  _buildRunRecommendations(state) {
    return buildRunRecommendations(state, this.memory);
  }

  _suggestNextAction(state) {
    return suggestNextAction(state);
  }

  inspectToolPolicy(tool, input = '', context = {}) {
    // MCP tools answer from lib/mcp-tool-policy.js, where the gate adapter is
    // the authority for what calling one does; everything else falls through.
    const policy = mcpToolPolicy(String(tool || '').trim().toLowerCase())
      || evaluateToolPolicy({ tool, input, context, internalTools: ALLOWED_TOOLS });
    const approval = this._queueToolApproval(policy, input, context);
    policy.approvalId = approval ? approval.id : null;
    policy.approvalStatus = approval ? approval.status : null;
    return this.ok('policy', policy, [], {
      tool: policy.tool,
      category: policy.category,
      action: policy.action,
      approvalId: approval ? approval.id : null,
      approvalStatus: approval ? approval.status : null,
    });
  }

  _queueToolApproval(policy, input, context = {}) {
    if (!this.storage || typeof this.storage.saveToolApproval !== 'function') return null;
    if (!policy || policy.category !== 'external') return null;
    const status = policy.action === 'review' ? 'pending' : 'blocked';
    const decision = policy.action === 'review' ? '' : 'blocked';
    const reason = Array.isArray(policy.reasons) ? policy.reasons[0] || '' : '';
    try {
      return this.storage.saveToolApproval({
        tool: policy.tool,
        input,
        context,
        policy,
        status,
        decision,
        reason,
      });
    } catch (_) {
      return null;
    }
  }

  listPendingToolApprovals(limit = 20) {
    if (!this.storage || typeof this.storage.listPendingToolApprovals !== 'function') return [];
    return this.storage.listPendingToolApprovals(limit);
  }

  countPendingToolApprovals() {
    if (!this.storage || typeof this.storage.countPendingToolApprovals !== 'function') return 0;
    return this.storage.countPendingToolApprovals();
  }

  _chooseFollowUp(step, summary, state) {
    return chooseFollowUp(step, summary, state);
  }

  _isRepeatFailure(step, state) {
    const signature = this._stepSignature(step, state);
    return Boolean(this._findRecentFailure(signature));
  }

  _isRetryableStepReport(report = {}) {
    const result = report.result || {};
    const rawError = String(result?.error?.message || result?.error?.code || result?.error || report.summary || '').toLowerCase();
    return /abort|timeout|fetch|network|econn|enotfound|etimedout|eai_again|503|502|504|429|temporarily|closed|ollama/.test(rawError);
  }

  _executeStepWithRetry(step, state, opts = {}) {
    const maxRetries = Number.isInteger(opts.stepRetries) ? Math.max(0, opts.stepRetries) : 2;
    let lastReport = null;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const report = this._executeStep({ ...step, attempt: attempt + 1 }, state, opts);
      lastReport = report;
      if (report.status !== 'error') return report;
      this._recordFailure(step, state, report.result, attempt + 1);
      if (!this._isRetryableStepReport(report) || attempt >= maxRetries) break;
    }
    return lastReport;
  }

  _executeStep(step, state, opts = {}) {
    const goalBinding = state.executionScope ? evaluateGoalBinding(state.executionScope, step) : { ok: true, receipt: null };
    if (!goalBinding.ok) {
      return { id: step.id, action: step.action, tool: step.tool, input: step.input, rationale: step.rationale, status: 'blocked', summary: '', result: { ok: false, type: 'agent', data: null, evidence: [], error: { code: goalBinding.reason, message: 'Step attempted to change the trusted execution scope.' }, meta: { blocked: true, goalBinding: goalBinding.receipt } }, policy: null, actionFirewall: null, goalBinding: goalBinding.receipt };
    }
    const beforeTaskData = this._emit('beforeTask', { step, state, opts });
    let result;
    let toolPolicy = null;
    let firewallDecision = null;

    // Evaluate the action firewall before behavioral containment so the
    // observation includes the same workspace/approval metadata that governs
    // execution. Neither gate executes the step; both must pass before a tool
    // call is reached.
    const firewallResult = enforceAgentActionStep({
      step,
      state,
      opts,
      kernel: this.kernel,
      allowedTools: ALLOWED_TOOLS,
    });
    firewallDecision = firewallResult.firewallDecision;
    result = behavioralBlockResult(state, step, { firewallDecision });
    if (result) {
    } else if (beforeTaskData && beforeTaskData.blocked === true) {
      result = {
        ok: false,
        type: 'agent',
        data: null,
        evidence: [],
        error: {
          code: 'BEFORE_TASK_BLOCKED',
          message: beforeTaskData.blockReason || 'A beforeTask plugin blocked this step.',
        },
        meta: {
          blocked: true,
          blockedBy: beforeTaskData.blockedBy || null,
        },
      };
    } else if (firewallResult.result) {
      result = firewallResult.result;
    } else {
      toolPolicy = evaluateToolPolicy({
          tool: step.tool,
        input: step.input,
        context: {
          goal: state.goal,
          objective: state.objective,
          action: step.action,
        },
        internalTools: ALLOWED_TOOLS,
      });

        if (toolPolicy.category !== 'internal') {
        emitGateTelemetry(this.kernel, 'agent-tool-policy', {
          decision: toolPolicy.action,
          reason: toolPolicy.reasons[0] || '',
          metadata: {
            tool: toolPolicy.tool,
            category: toolPolicy.category,
            riskScore: toolPolicy.riskScore,
            blocked: toolPolicy.blocked,
            review: toolPolicy.review,
          },
        });

        const code = toolPolicy.blocked ? 'EXTERNAL_TOOL_BLOCKED' : 'EXTERNAL_TOOL_REVIEW_REQUIRED';
        result = {
          ok: false,
          type: 'agent',
          data: null,
          evidence: [],
          error: {
            code,
            message: toolPolicy.reasons[0] || `External tool ${toolPolicy.action} required.`,
          },
          meta: {
            blocked: true,
            allowedTools: [...ALLOWED_TOOLS],
            policy: toolPolicy,
          },
        };
        } else {
          const handler = Object.hasOwn(INTERNAL_TOOL_HANDLERS, step.tool) ? INTERNAL_TOOL_HANDLERS[step.tool] : unsupportedToolResult;
          result = handler(this, step, state, opts);
        }
      }

    const summary = this._extractAgentSummary(result);
    const blocked = result?.error?.code === 'UNSUPPORTED_TOOL' || result?.meta?.blocked === true;
    const stepReport = {
      id: step.id,
      action: step.action,
      tool: step.tool,
      input: step.input,
      rationale: step.rationale,
      status: blocked ? 'blocked' : (result?.ok === false ? 'error' : 'done'),
      summary: summary.text || '',
      result,
      policy: toolPolicy,
      actionFirewall: firewallDecision, goalBinding: goalBinding.receipt,
    };
    this._emit('afterTask', { step: stepReport, state, opts });
    return stepReport;
  }

  run(goal, opts = {}) {
    const scopeResult = createExecutionScope(goal, opts);
    if (!scopeResult.ok) return this.fail('agent', scopeResult.reason, 'Untrusted content cannot define an execution goal.', [], { goalBinding: scopeResult.receipt });
    const planResult = this.plan(goal, opts);
    if (!planResult || planResult.ok === false) return planResult; const freshPlan = planResult.data;
    const resumeCandidate = opts.resume === false ? null : this._findResumeRun(goal);
    const activePlan = resumeCandidate && resumeCandidate.plan ? resumeCandidate.plan : freshPlan;
    const state = resumeCandidate ? {
      goal: activePlan.goal,
      objective: activePlan.objective,
      selectedTools: [...(activePlan.selectedTools || [])],
      plan: cloneValue(activePlan),
      steps: Array.isArray(resumeCandidate.steps) ? cloneValue(resumeCandidate.steps) : [],
      evidence: Array.isArray(resumeCandidate.evidence) ? cloneValue(resumeCandidate.evidence) : [],
      status: 'running',
      notes: Array.isArray(resumeCandidate.notes) ? cloneValue(resumeCandidate.notes) : [],
      queuedSteps: Array.isArray(resumeCandidate.queuedSteps) && resumeCandidate.queuedSteps.length
        ? cloneValue(resumeCandidate.queuedSteps)
        : cloneValue(activePlan.steps || []),
      resumed: true,
      resumedFrom: resumeCandidate.id,
      startedAt: resumeCandidate.startedAt || nowIso(),
      progress: resumeCandidate.progress ? cloneValue(resumeCandidate.progress) : { stalledCount: 0, lastSummary: '' },
    } : {
      goal: freshPlan.goal,
      objective: freshPlan.objective,
      selectedTools: [...freshPlan.selectedTools],
      plan: cloneValue(freshPlan),
      steps: [],
      evidence: [],
      status: 'running',
      notes: [],
      queuedSteps: cloneValue(freshPlan.steps || []),
      resumed: false,
      resumedFrom: null,
      startedAt: nowIso(),
      progress: { stalledCount: 0, lastSummary: '' },
    };
    state.completedSteps = state.steps.length;
    state.remainingSteps = Array.isArray(state.queuedSteps) ? state.queuedSteps.length : 0;
    state.workspaceId = typeof opts.workspaceId === 'string' && opts.workspaceId.trim()
      ? opts.workspaceId.trim()
      : (resumeCandidate?.workspaceId || state.workspaceId || 'default');
    state.agentId = String(opts.agentId || resumeCandidate?.agentId || state.agentId || 'agent-v1');
    state.executionScope = scopeResult.scope; state.behavioralManifest = resumeCandidate?.behavioralManifest;
    state.behavioralFindings = resumeCandidate?.behavioralFindings ? cloneValue(resumeCandidate.behavioralFindings) : [];
    initializeBehavioralState(state, {
      ...state,
      agentId: state.agentId,
      selectedTools: [...(state.selectedTools || []), 'dream'],
      capabilities: (activePlan.steps || []).map(step => step.action),
    });
    this._emit('beforeAgentRun', state);
    resetMemoryPersistence(this);

    const queued = Array.isArray(state.queuedSteps) ? [...state.queuedSteps] : [];
    this._rememberRun(state);
    while (queued.length > 0 && state.steps.length < activePlan.maxSteps) {
      const step = queued.shift();
      const report = this._executeStepWithRetry(step, state, opts);
      state.steps.push(report);
      state.evidence.push(...this._collectEvidence([report.result]));
      this._updateToolStats(report.tool, report.status);
      state.notes.push({
        step: report.action,
        summary: report.summary,
      });

      const summary = this._extractAgentSummary(report.result);
      const previousSummary = state.progress?.lastSummary || '';
      const stalled = this._isStalledProgress(previousSummary, summary.text);
      state.progress = {
        stalledCount: stalled ? (state.progress?.stalledCount || 0) + 1 : 0,
        lastSummary: normalizeSummaryText(summary.text),
      };

      const followUp = this._chooseFollowUp(step, summary, state);
      const shouldForceDream =
        state.progress.stalledCount >= 2 &&
        state.steps.length < activePlan.maxSteps &&
        !queued.some(s => s.tool === 'dream');

      if (shouldForceDream) {
        queued.unshift({
          id: `dream-${state.steps.length + 1}`,
          action: 'dream',
          tool: 'dream',
          input: {},
          rationale: 'Progress stalled; switching to hypothesis mode.',
        });
      } else if (followUp && state.steps.length < activePlan.maxSteps) {
        const nextSignature = this._stepSignature(followUp, state);
        if (this._findRecentFailure(nextSignature)) {
          const fallback = followUp.action === 'dream' ? null : { action: 'dream', tool: 'dream', input: {}, rationale: 'The same error repeated, so a safe fallback was chosen.' };
          if (fallback && !this._findRecentFailure(this._stepSignature(fallback, state))) {
            queued.unshift({
              id: `${fallback.action}-${state.steps.length + 1}`,
              action: fallback.action,
              tool: fallback.tool,
              input: fallback.input,
              rationale: fallback.rationale,
            });
          }
        } else {
          queued.unshift({
            id: `${followUp.action}-${state.steps.length + 1}`,
            action: followUp.action,
            tool: followUp.tool,
            input: followUp.input,
            rationale: 'The result of the previous step required an additional step.',
          });
        }
      }
      state.queuedSteps = [...queued];
      state.completedSteps = state.steps.length;
      state.remainingSteps = queued.length;
      this._rememberRun(state);
    }

    const finalStep = state.steps[state.steps.length - 1];
    const finalSummary = finalStep ? this._extractAgentSummary(finalStep.result) : { text: '' };
    const finalAnswer = finalSummary.text || 'The agent completed the task but could not produce a short summary.';
    state.status = finalStep && finalStep.result && finalStep.result.ok === false ? 'blocked' : (queued.length > 0 ? 'paused' : 'completed'); // #756
    state.finalSummary = buildFinalSummary({
      goal: state.goal,
      objective: activePlan.objective,
      status: state.status,
      steps: state.steps,
      evidence: state.evidence,
      finalAnswer,
      selectedTools: activePlan.selectedTools,
    });
    state.finalAnswer = state.finalSummary.conclusion || finalAnswer;
    state.completedSteps = state.steps.length;
    state.remainingSteps = queued.length;
    state.recommendations = this._buildRunRecommendations(state);
    state.nextAction = this._suggestNextAction(state);
    state.report = this._renderReport(state);
    state.memory = {
      path: this.memoryPath,
      goals: this.memory.goals.length,
      runs: this.memory.runs.length,
    };
    this.lastRun = state;
    this._rememberRun(state);
    this._emit('afterAgentRun', state);

    if (state.status === 'blocked') {
      return this.fail('agent', 'AGENT_BLOCKED', finalAnswer, state.evidence, {
        objective: activePlan.objective,
        selectedTools: activePlan.selectedTools,
        resumed: state.resumed,
        report: state.report,
        ...runEnvelopeMeta(this, state.steps),
      }, state);
    }

    return this.ok('agent', state, state.evidence, {
      objective: activePlan.objective,
      selectedTools: activePlan.selectedTools,
      resumed: state.resumed,
      ...runEnvelopeMeta(this, state.steps),
    });
  }

  /**
   * The step-execution operations AgentV3 drives this agent through.
   *
   * These twelve used to be called as `baseAgent._executeStepWithRetry()` and
   * the like from agent.v3.js: a contract in everything but its marking, with
   * no name, no documentation and no stability promise, so changing one broke
   * a caller its author had no reason to open. Naming them here makes the
   * contract one thing that can be seen, stubbed and changed deliberately.
   *
   * Not promoted individually: arch-4 requires AgentV3 to expose every public
   * method Agent has, and `stepSignature` or `updateToolStats` are not
   * promises this package should make to the outside. One seam is.
   */
  stepRuntime() {
    return {
      emit: (event, data) => this._emit(event, data),
      executeStepWithRetry: (step, state, opts) => this._executeStepWithRetry(step, state, opts),
      collectEvidence: (items) => this._collectEvidence(items),
      updateToolStats: (tool, status) => this._updateToolStats(tool, status),
      extractAgentSummary: (result) => this._extractAgentSummary(result),
      isStalledProgress: (previous, current) => this._isStalledProgress(previous, current),
      chooseFollowUp: (step, summary, state) => this._chooseFollowUp(step, summary, state),
      stepSignature: (step, state) => this._stepSignature(step, state),
      findRecentFailure: (signature) => this._findRecentFailure(signature),
      buildRunRecommendations: (state) => this._buildRunRecommendations(state),
      suggestNextAction: (state) => this._suggestNextAction(state),
      renderReport: (state) => this._renderReport(state),
    };
  }

  _renderReport(state) {
    return renderRunReport(state, {
      recommendations: this._buildRunRecommendations(state),
      nextAction: state.nextAction || this._suggestNextAction(state),
    });
  }
}

module.exports = Agent;
