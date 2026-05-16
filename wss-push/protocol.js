// Wire-level Sec-WebSocket-Protocol identifier. Must be a valid HTTP token
// (RFC 7230 §3.2.6) — no "/". The application-level versioned name "wss-push/1"
// is reported only inside the JSON `hello` message.
const SUBPROTOCOL = "wss-push";
const VERSION = "wss-push/1";
const SUPPORTED_PROTOCOLS = [VERSION];

const ERROR_CODES = {
  UNSUPPORTED_PROTOCOL: 1001,
  AUTH_FAILED: 1002,
  INVALID_PARAMS: 1003,
  METHOD_NOT_FOUND: 1004,
  INTERNAL_ERROR: 1005,
  TOO_MANY_SUBS: 1006,
  RATE_LIMITED: 1007,
};

const WS_CLOSE_CODES = {
  UNSUPPORTED_PROTOCOL: 1002,
  AUTH_FAILED: 1008,
  POLICY_VIOLATION: 1008,
  GOING_AWAY: 1001,
  NORMAL: 1000,
};

function makeResponse(id, result) {
  return { id, result };
}

function makeError(id, code, message, extra) {
  const error = { code, message };
  if (extra && typeof extra === "object") {
    for (const k of Object.keys(extra)) error[k] = extra[k];
  }
  return { id: id == null ? null : id, error };
}

function makeEvent(method, params) {
  return { method, params };
}

function parseMessage(raw) {
  if (typeof raw !== "string" && !Buffer.isBuffer(raw)) return null;
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : raw;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof msg !== "object" || msg === null || Array.isArray(msg)) return null;
  if (typeof msg.method !== "string" || msg.method.length === 0) return null;
  return {
    id: msg.id == null ? null : msg.id,
    method: msg.method,
    params: msg.params == null ? {} : msg.params,
  };
}

module.exports = {
  SUBPROTOCOL,
  VERSION,
  SUPPORTED_PROTOCOLS,
  ERROR_CODES,
  WS_CLOSE_CODES,
  makeResponse,
  makeError,
  makeEvent,
  parseMessage,
};
