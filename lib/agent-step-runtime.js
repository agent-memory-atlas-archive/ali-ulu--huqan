'use strict';

const { renderRunReport } = require('./agent-report-renderer');

function createStepRuntime(agent) {
  return {
    emit: (event, data) => agent._emit(event, data),
    executeStepWithRetry: (step, state, opts) => agent._executeStepWithRetry(step, state, opts),
    collectEvidence: items => agent._collectEvidence(items),
    updateToolStats: (tool, status) => agent._updateToolStats(tool, status),
    extractAgentSummary: result => agent._extractAgentSummary(result),
    isStalledProgress: (previous, current) => agent._isStalledProgress(previous, current),
    chooseFollowUp: (step, summary, state) => agent._chooseFollowUp(step, summary, state),
    stepSignature: (step, state) => agent._stepSignature(step, state),
    findRecentFailure: signature => agent._findRecentFailure(signature),
    buildRunRecommendations: state => agent._buildRunRecommendations(state),
    suggestNextAction: state => agent._suggestNextAction(state),
    renderReport: state => agent._renderReport(state),
  };
}

function renderReport(agent, state) {
  return renderRunReport(state, { recommendations: agent._buildRunRecommendations(state), nextAction: state.nextAction || agent._suggestNextAction(state) });
}

module.exports = { createStepRuntime, renderReport };
