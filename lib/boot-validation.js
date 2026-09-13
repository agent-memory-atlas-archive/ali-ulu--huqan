'use strict';

// CLI/MCP boot validation: specific message, deliberate exit (Gate A item 6, #2366).
//
// Server boot owns its key requirement in lib/http/server-boot.js. CLI and MCP
// are local-first: they need no API key, and a keyless boot is the contract,
// not an accident. What stops them is contradictory configuration — the same
// HUQAN_ENV_CONFLICT the server refuses — reported here with an
// operator-readable line instead of a raw require-time stack. Values never
// enter the message: environment-compat errors name variables, not secrets.

const { validateEnvironmentCompatibility } = require('./environment-compat');

function assertBootEnvironment(environment = process.env) {
  validateEnvironmentCompatibility(environment);
}

function formatBootError(runtime, error) {
  const code = error && error.code ? error.code : 'STARTUP_VALIDATION_FAILED';
  const message = error && error.message ? error.message : String(error);
  return `HUQAN ${runtime} cannot start: ${message} (code=${code})`;
}

function reportBootError(runtime, error) {
  console.error(formatBootError(runtime, error));
}

// True when the error was a boot conflict and has been reported: entries keep
// a single glue line and stay out of the file-size ledger.
function reportBootConflict(runtime, error) {
  if (error && error.code === 'HUQAN_ENV_CONFLICT') {
    reportBootError(runtime, error);
    return true;
  }
  return false;
}

module.exports = { assertBootEnvironment, formatBootError, reportBootError, reportBootConflict };
