'use strict';

// Approved huqan.learn execution, moved verbatim from
// lib/mcp-approval-decision-handler.js (#2207): claim, run through the
// oversight runtime or directly, then finalize with a sealed receipt.
// The dispatcher stays in the handler; only this learn tail lives here.

const { sanitizeToolArgsForStorage } = require('./mcp-input-sanitizers');
const { buildApprovalAdmissionOptions } = require('./mcp-approval-admission');
const { formatApprovalRecord } = require('./mcp-approval-views');
const { decideMcpOversight, oversightSummary } = require('./mcp-human-oversight-adapter');
const { idempotentApprovalDecision, finalizeApprovalExecution } = require('./approval-execution-evidence');

function executeApprovedLearn({
  kernel,
  approvalStore,
  approvalId,
  workspaceId,
  reason,
  decision,
  existing,
  storedArgs,
  oversightRequired,
  runtime,
  oversightCase,
  oversightRuntime,
  identityEvaluation,
  args,
  failApprovalDecision,
}) {
  const cleanArgs = sanitizeToolArgsForStorage(existing.tool, storedArgs);
  const learnOptions = buildApprovalAdmissionOptions(existing, cleanArgs);
  const oversightDecision = oversightRequired
    ? decideMcpOversight({ runtime, oversightCase, approval: existing, args, decision })
    : { enabled: false, ok: true };
  if (oversightRequired && !oversightDecision.ok) {
    return failApprovalDecision('OVERSIGHT_DECISION_FAILED', 'The durable Human Oversight approval could not be recorded; execution is blocked.', {
      approval: existing,
      oversight: oversightSummary(oversightCase.result, oversightDecision.result),
      retrySafe: true,
    });
  }
  if (oversightRequired && decision === 'approved'
      && oversightDecision.result?.case?.status === 'escalated') {
    return failApprovalDecision('OVERSIGHT_QUORUM_PENDING', 'A distinct second approver is required before this high-risk MCP action can execute.', {
      approval: existing,
      oversight: oversightSummary(oversightCase.result, oversightDecision.result),
      retrySafe: true,
    });
  }

  const claim = approvalStore.claimToolApproval(approvalId, reason, workspaceId);
  if (!claim || claim.claimed !== true) {
    const current = formatApprovalRecord(claim?.approval || approvalStore.getToolApprovalById(approvalId, workspaceId));
    if (current?.status === 'approved') {
      return idempotentApprovalDecision(current, decision);
    }
    const code = current?.status === 'failed'
      ? 'APPROVAL_RECONCILIATION_REQUIRED'
      : current?.status === 'executing'
        ? 'APPROVAL_EXECUTION_IN_PROGRESS'
        : 'APPROVAL_DECISION_CONFLICT';
    return failApprovalDecision(
      code,
      current?.status === 'failed'
        ? 'Approval execution outcome is unknown and requires manual reconciliation.'
        : 'Approval execution is already claimed or is not pending.',
      { approval: current, retrySafe: false },
    );
  }
  // #216: both the SQLite and JSON Graph backends now provide a crash-safe
  // durable mutation journal (runMutationOnce), so binding the durable id no
  // longer depends on which backend is active -- runMutationOnce's presence
  // is itself the capability signal now that it is real on both.
  if (kernel.graph && typeof kernel.graph.runMutationOnce === 'function') {
    learnOptions.mutationOperationId = approvalId;
  }
  const completeExecution = (result, oversightExecution = null) => {
    if (!result || result.ok === false) {
      const failure = approvalStore.failToolApproval(approvalId, 'execution_outcome_unknown:result_not_ok', workspaceId);
      const failed = formatApprovalRecord(failure?.approval || approvalStore.getToolApprovalById(approvalId, workspaceId));
      return failApprovalDecision(
        'APPROVAL_EXECUTION_FAILED',
        'Approved MCP action failed; outcome requires manual reconciliation.',
        { approval: failed, result, retrySafe: false },
      );
    }

    let finalization;
    try {
      finalization = finalizeApprovalExecution({ store: approvalStore, approvalId, workspaceId, reason, graph: kernel.graph, result });
    } catch (error) {
      return failApprovalDecision('APPROVAL_FINALIZATION_FAILED', 'Approved MCP action executed but finalizing the approval record threw an error.', {
        approval: formatApprovalRecord(approvalStore.getToolApprovalById(approvalId, workspaceId)), result, retrySafe: false,
        finalizationError: error?.code || error?.name || 'error',
      });
    }
    if (finalization.code) {
      const failure = approvalStore.failToolApproval(approvalId, 'execution_outcome_unknown:receipt_not_materialized', workspaceId);
      return failApprovalDecision(finalization.code, 'Approved MCP action executed but its canonical receipt could not be materialized.',
        { approval: formatApprovalRecord(failure?.approval || approvalStore.getToolApprovalById(approvalId, workspaceId)), result, retrySafe: false },
      );
    }
    const approved = formatApprovalRecord(finalization.approval);
    const executionEvidence = finalization.executionEvidence;
    if (!approved || approved.status !== 'approved') {
      return failApprovalDecision(
        'APPROVAL_FINALIZATION_FAILED',
        'Approved MCP action executed but the approval record could not be finalized.',
        { approval: approved || formatApprovalRecord(approvalStore.getToolApprovalById(approvalId, workspaceId)), result, retrySafe: false },
      );
    }
    return {
      ok: true,
      type: 'approval',
      data: {
        approval: approved,
        decision,
        executed: true,
        idempotent: false,
        result,
        receipt: executionEvidence.receipt,
        refs: executionEvidence.refs,
        ...(oversightRequired ? { oversight: oversightSummary(oversightCase.result, oversightDecision.result, oversightExecution) } : {}),
        ...(identityEvaluation.enabled ? { identity: identityEvaluation.evidence } : {}),
      },
      evidence: result.evidence || [],
      error: null,
      meta: { admissionAware: true },
    };
  };

  if (oversightRequired) {
    return Promise.resolve().then(() => oversightRuntime.executeApproved({
      caseId: oversightCase.input.caseId,
      action: oversightCase.input.action,
      requesterContext: oversightCase.input.requesterContext,
      firewallRequest: oversightCase.input.firewallRequest,
      executor: () => kernel.learn(cleanArgs.text, learnOptions),
    })).then((oversightExecution) => {
      if (!oversightExecution || oversightExecution.ok !== true) {
        const failure = approvalStore.failToolApproval(approvalId, 'execution_outcome_unknown:oversight_runtime_blocked', workspaceId);
        return failApprovalDecision('OVERSIGHT_EXECUTION_BLOCKED', 'Human Oversight revalidation blocked the approved action; outcome requires manual reconciliation.', {
          approval: formatApprovalRecord(failure?.approval || approvalStore.getToolApprovalById(approvalId, workspaceId)),
          oversight: oversightSummary(oversightCase.result, oversightDecision.result, oversightExecution),
          retrySafe: false,
        });
      }
      return completeExecution(oversightExecution.result, oversightExecution);
    }).catch((error) => {
      const failure = approvalStore.failToolApproval(
        approvalId,
        `execution_outcome_unknown:${error?.code || error?.name || 'error'}`,
        workspaceId,
      );
      return failApprovalDecision(
        'APPROVAL_EXECUTION_FAILED',
        'Approved MCP action threw during Human Oversight execution; outcome requires manual reconciliation.',
        { approval: formatApprovalRecord(failure?.approval || approvalStore.getToolApprovalById(approvalId, workspaceId)), retrySafe: false },
      );
    });
  }

  let result;
  try {
    result = kernel.learn(cleanArgs.text, learnOptions);
  } catch (error) {
    const failure = approvalStore.failToolApproval(
      approvalId,
      `execution_outcome_unknown:${error?.code || error?.name || 'error'}`,
    );
    const failed = formatApprovalRecord(failure?.approval || approvalStore.getToolApprovalById(approvalId, workspaceId));
    return failApprovalDecision(
      'APPROVAL_EXECUTION_FAILED',
      'Approved MCP action threw during execution; outcome requires manual reconciliation.',
      { approval: failed, retrySafe: false },
    );
  }
  return completeExecution(result);
}

module.exports = { executeApprovedLearn };
