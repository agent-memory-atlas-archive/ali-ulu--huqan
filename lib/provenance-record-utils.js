'use strict';

// Pure record helpers for provenance, moved verbatim from
// lib/provenance-ingest.js (#2246): text shaping, confidence clamping and
// provenance-id minting. No project requires: both the builder
// (lib/provenance-ingest.js) and the adapter
// (lib/provenance-ingest-adapter.js) depend downward on this leaf.

const crypto = require('crypto');

function nowIso() {
  return new Date().toISOString();
}

function sanitize(value, fallback = '') {
  const text = String(value == null ? '' : value).trim();
  return text || fallback;
}

function clampConfidence(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  return Math.max(0, Math.min(1, value));
}

function makeProvenanceId(input) {
  const sourceRef = sanitize(input.sourceRef);
  const subject = sanitize(input.subject);
  const object = sanitize(input.object);
  const base = input.provenanceId || input.id || `${sourceRef}|${subject}|${object}|${input.timestamp || ''}`;
  return `prov_${crypto.createHash('sha1').update(String(base), 'utf8').digest('hex').slice(0, 16)}`;
}

module.exports = {
  clampConfidence,
  makeProvenanceId,
  nowIso,
  sanitize,
};
