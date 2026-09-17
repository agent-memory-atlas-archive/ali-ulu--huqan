'use strict';

// A session's cumulative blast radius, from the receipt history the external
// action guard already reads for graduated autonomy (#2505).
//
// Recorded, not enforced. The owner's decision is to record the session total
// on every receipt first, and to enforce a threshold only after it has been
// calibrated against those records.
//
// The history is the tail of the persisted receipt trail
// (autonomy-receipt-history.js). Only admission receipts of this session that
// pass hash verification count. A receipt with no blast radius score (written
// before #2530) is unscored, never 0. A receipt that fails verification is not
// counted, and the summary says so. When the history window was cut and its
// oldest admission receipt belongs to this session, earlier actions of the
// session may lie outside the window, and the summary says that too.

const { hasValidReceiptHash, isAdmissionReceipt } = require('./autonomy-receipt-history');

function unknownSummary(sessionId, reason) {
  return Object.freeze({
    sessionId,
    priorActions: null,
    scoredActions: null,
    unscoredActions: null,
    recordedScoreTotal: null,
    maxScore: null,
    // No escape stream was read for this summary: null (not read), never 0.
    sandboxEscapeAttempts: null,
    // Refusals come from the history itself, so no history means no count.
    refusedActions: null,
    status: 'unknown',
    reasons: Object.freeze([reason]),
  });
}

/**
 * The recorded blast radius of this session's earlier actions, plus the
 * sandbox-escape signal (#2505/G, restoring #1945): an explicit
 * `options.sandboxEscapes` list (as read by `readSandboxEscapes`) is counted
 * per session summary and named in the reasons. Absent input reads as null
 * (not read), an empty list as a measured 0. Rejection receipts in the
 * session history itself are counted as refused actions. Recorded only,
 * never enforced.
 */
function summarizeSessionImpact(receipts, sessionId, options = {}) {
  const session = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!session) return unknownSummary('', 'the action names no session');
  if (!Array.isArray(receipts)) return unknownSummary(session, 'the session receipt history was not read');
  try {
    const admissions = receipts.filter(isAdmissionReceipt);
    const claimed = admissions.filter((receipt) => receipt.metadata?.sessionId === session);
    const verified = claimed.filter(hasValidReceiptHash);
    let recordedScoreTotal = 0;
    let maxScore = null;
    let scoredActions = 0;
    for (const receipt of verified) {
      const score = receipt.metadata?.justification?.blastRadius?.score;
      if (!Number.isFinite(score)) continue;
      scoredActions += 1;
      recordedScoreTotal += score;
      maxScore = maxScore === null ? score : Math.max(maxScore, score);
    }
    const unscoredActions = verified.length - scoredActions;
    const reasons = [];
    if (unscoredActions > 0) {
      reasons.push(`${unscoredActions} earlier action(s) in the session carry no blast radius score`);
    }
    if (claimed.length > verified.length) {
      reasons.push(`${claimed.length - verified.length} receipt(s) in the session failed hash verification and were not counted`);
    }
    if (receipts.truncated === true && admissions[0]?.metadata?.sessionId === session) {
      reasons.push('the history window was cut and begins inside this session, so earlier actions may be outside it');
    }
    const escapes = Array.isArray(options.sandboxEscapes) ? options.sandboxEscapes : null;
    const sandboxEscapeAttempts = escapes === null ? null : escapes.length;
    if (sandboxEscapeAttempts !== null && sandboxEscapeAttempts > 0) {
      const scopes = [...new Set(escapes.map((entry) => (entry && typeof entry.workspaceId === 'string' && entry.workspaceId.trim()) || 'default'))];
      reasons.push(`${sandboxEscapeAttempts} sandbox escape attempt(s) recorded in workspace(s) ${scopes.join(', ')}`);
    }
    // Bypass signal (#2505/I): rejection receipts in this session are refused
    // actions. Review receipts stay out of this count -- held-for-review is a
    // legitimate flow, not a bypass attempt. Same-session retried-same-action
    // detection needs argument fingerprinting and stays a follow-up.
    const refusedActions = verified.filter((receipt) => receipt.receiptKind === 'external_action_rejection_receipt').length;
    if (refusedActions > 0) {
      reasons.push(`${refusedActions} refused action(s) in the session (rejection receipts)`);
    }
    return Object.freeze({
      sessionId: session,
      priorActions: verified.length,
      scoredActions,
      unscoredActions,
      recordedScoreTotal,
      maxScore,
      sandboxEscapeAttempts,
      refusedActions,
      status: reasons.length > 0 ? 'partial' : 'computed',
      reasons: Object.freeze(reasons),
    });
  } catch (error) {
    return unknownSummary(session, `the session history could not be summarized: ${String(error?.message || error)}`);
  }
}

module.exports = { summarizeSessionImpact };
