const { ERROR_CODES } = require("./protocol");
const nodeHealth = require("./node-health");

class MethodError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.code = code;
    this.extra = extra || null;
  }
}

function requireHello(session) {
  if (!session.helloDone) {
    throw new MethodError(
      ERROR_CODES.INVALID_PARAMS,
      "hello required before this method",
    );
  }
}

// Reject methods that depend on a fully-synced chain. Returns a structured
// 1008 error with sync progress so the wallet can display a progress bar and
// retry with a sensible cadence.
function requireSynced() {
  if (!nodeHealth.isSyncing()) return;
  const status = nodeHealth.getStatus();
  throw new MethodError(
    ERROR_CODES.NODE_SYNCING,
    "node syncing, retry when synced",
    {
      retry_after_seconds: 30,
      verification_progress: status.verification_progress,
      blocks: status.blocks,
      headers: status.headers,
    },
  );
}

module.exports = { MethodError, requireHello, requireSynced };
