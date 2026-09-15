'use strict';

// Routes one MCP tool call: resolves the legacy alias, authorises the operator
// tools, evaluates the gate, and hands the call to its handler or to the
// refusal response (#2142).

const { evaluateMcpGate } = require('../mcp-gate-adapter');
const { emitGateTelemetry } = require('../gate-telemetry');
const { applyHumanApprovalToggle } = require('../human-approval-toggle');
const { parseJsonObject } = require('../json-object');
const {
  canonicalMcpToolName,
  isLegacyMcpToolName,
  withMcpToolDeprecationSurface,
} = require('../mcp-tool-names');
const { MCP_MAX_SHORT, sanitizeMcpString } = require('../mcp-input-sanitizers');
const { executeMcpAgentContinuation } = require('../mcp-agent-continuation');
const { createMcpApprovalDecisionHandler } = require('../mcp-approval-decision-handler');
const { withMcpToolVerdictSurface } = require('./response-builders');
const { OPERATOR_TOOL_NAMES } = require('./tool-surface');
const { operatorCapabilityAuthorized, OPERATOR_AUTHORIZED_VERDICT } = require('./operator-authorization');
const { createMcpToolHandlers, createReadOnlyDryRun } = require('./tool-handlers');
const { respondToGateRefusal } = require('./gate-refusal');

function failApprovalDecision(code, message, meta = {}) {
  return {
    ok: false,
    type: 'approval',
    data: null,
    evidence: [],
    error: { code, message },
    meta,
  };
}

const handleMcpApprovalDecision = createMcpApprovalDecisionHandler({ failApprovalDecision });

function dispatchOperatorTool(kernel, name, args, safeParams, runtime, withTransientAgent) {
  if (!operatorCapabilityAuthorized(runtime, name, args, safeParams.operatorCapability, safeParams.operatorToken)) {
    return withMcpToolVerdictSurface(
      failApprovalDecision(
        'OPERATOR_AUTH_REQUIRED',
        name === 'huqan.agent_resume'
          // Not an approval operation, and saying so matters: the operator
          // reading this needs to know which capability was demanded of them.
          ? 'A scoped operator capability is required to resume an agent run.'
          : 'A scoped operator capability is required for this MCP approval operation.',
      ),
      name,
      args,
      { decision: 'block', reason: 'operator_auth_required', requiredReview: false },
    );
  }
  if (name === 'huqan.agent_resume') {
    const continuation = withTransientAgent(kernel, agent => executeMcpAgentContinuation(agent, args));
    return withMcpToolVerdictSurface(continuation, name, args, OPERATOR_AUTHORIZED_VERDICT);
  }
  if (name === 'huqan.approve') {
    const approvalDecision = handleMcpApprovalDecision(kernel, args, runtime);
    const projectDecision = (result) => withMcpToolVerdictSurface(
      result,
      name,
      args,
      OPERATOR_AUTHORIZED_VERDICT,
    );
    return approvalDecision && typeof approvalDecision.then === 'function'
      ? approvalDecision.then(projectDecision)
      : projectDecision(approvalDecision);
  }
  // huqan.approvals and huqan.approval_detail continue to the gate and their handlers.
  return undefined;
}

function createMcpToolDispatch({ withTransientAgent }) {
  const handlers = createMcpToolHandlers({ withTransientAgent });
  const executeReadOnlyDryRun = createReadOnlyDryRun({ withTransientAgent });

  function dispatchMcpTool(kernel, name, safeParams, runtime = {}) {
    const args = parseJsonObject(safeParams.arguments, {});

    if (OPERATOR_TOOL_NAMES.includes(name)) {
      const operatorOutcome = dispatchOperatorTool(kernel, name, args, safeParams, runtime, withTransientAgent);
      if (operatorOutcome !== undefined) return operatorOutcome;
    }

    const gate = applyHumanApprovalToggle(evaluateMcpGate({ tool: name, args, metadata: {} }));
    emitGateTelemetry(kernel, 'mcp-tool-call', { tool: name, decision: gate.decision, reason: gate.reason, findings: gate.findings, metadata: gate.metadata });

    if (!gate.canExecute) {
      return respondToGateRefusal({ kernel, name, args, gate, runtime, executeReadOnlyDryRun });
    }

    const handler = Object.hasOwn(handlers, name) ? handlers[name] : null;
    if (!handler) throw new Error(`Unknown tool: ${name}`);
    return handler({ kernel, name, args, gate, runtime });
  }

  /**
   * RFC-001 reader half: accept both spellings, resolve to one handler.
   *
   * The requested name is canonicalized once, here, and every downstream
   * consumer — gate evaluation, approval persistence, dispatch, dry-run — sees
   * only the canonical `huqan.*` name. That is what makes "both names resolve to
   * the same handler" structural rather than a pair of parallel switch arms that
   * could drift.
   */
  function callTool(kernel, params = {}, runtime = {}) {
    const safeParams = params && typeof params === 'object' ? params : {};
    const requestedName = sanitizeMcpString(safeParams.name, MCP_MAX_SHORT);
    const outcome = dispatchMcpTool(kernel, canonicalMcpToolName(requestedName), safeParams, runtime);
    if (!isLegacyMcpToolName(requestedName)) return outcome;
    if (outcome && typeof outcome.then === 'function') {
      return outcome.then((value) => withMcpToolDeprecationSurface(value, requestedName));
    }
    return withMcpToolDeprecationSurface(outcome, requestedName);
  }

  return { callTool, executeReadOnlyDryRun };
}

module.exports = {
  createMcpToolDispatch,
};
