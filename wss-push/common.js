const { ERROR_CODES } = require("./protocol");

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

module.exports = { MethodError, requireHello };
