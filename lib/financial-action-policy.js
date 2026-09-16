'use strict';

/**
 * Payment and financial action gate, v0 assessment (#2505/D).
 *
 * Money leaves the operator's control and is hard to get back, so a
 * financial action is never silently allowed: without a readable amount and
 * destination it holds for human review as CRITICAL, and even a fully
 * described one holds for review until owner-configured amount limits exist.
 * Recorded assessment, never an allow -- the limits that could relax this
 * are an explicit owner follow-up, as is the amount/destination keyword
 * inference that would route free text here.
 *
 * Pure assessment on explicit input: no filesystem, no network, no process
 * state. Malformed input degrades to review, never to allow and never throws.
 */

const { ACTION_DECISIONS, RISK_LEVELS } = require('./risk-policy-constants');

const FINANCIAL_REASONS = Object.freeze({
  DETAILS_ABSENT: 'FINANCIAL_DETAILS_ABSENT',
  IRREVERSIBLE: 'FINANCIAL_IRREVERSIBLE',
  ASSESSED: 'FINANCIAL_ASSESSMENT_RECORDED',
});

function text(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
}

function readAmount(input) {
  const raw = input && input.amount !== undefined ? input.amount : (input && input.value);
  const amount = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

/**
 * Assess one financial action.
 *
 * @param {object} [input] { amount, currency, destination, reversible }
 * @returns {object} frozen { decision, reason, riskLevel, assessment }
 */
function evaluateFinancialAction(input = {}) {
  const source = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
  const amount = readAmount(source);
  const currency = text(source.currency).toUpperCase() || null;
  const destination = text(source.destination);
  const reversible = source.reversible === true;
  const assessment = Object.freeze({
    amount,
    currency,
    destinationPresent: destination !== '',
    reversible,
    limitsConfigured: false,
  });
  if (amount === null || destination === '') {
    return Object.freeze({
      decision: ACTION_DECISIONS.HUMAN_REVIEW,
      reason: FINANCIAL_REASONS.DETAILS_ABSENT,
      riskLevel: RISK_LEVELS.CRITICAL,
      assessment,
    });
  }
  if (!reversible) {
    return Object.freeze({
      decision: ACTION_DECISIONS.HUMAN_REVIEW,
      reason: FINANCIAL_REASONS.IRREVERSIBLE,
      riskLevel: RISK_LEVELS.CRITICAL,
      assessment,
    });
  }
  return Object.freeze({
    decision: ACTION_DECISIONS.HUMAN_REVIEW,
    reason: FINANCIAL_REASONS.ASSESSED,
    riskLevel: RISK_LEVELS.HIGH,
    assessment,
  });
}

module.exports = { evaluateFinancialAction, FINANCIAL_REASONS };
