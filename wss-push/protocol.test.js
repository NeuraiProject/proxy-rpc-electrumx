const {
  SUBPROTOCOL,
  VERSION,
  SUPPORTED_PROTOCOLS,
  ERROR_CODES,
  parseMessage,
  makeResponse,
  makeError,
  makeEvent,
} = require("./protocol");

test("VERSION is wss-push/1", () => {
  expect(VERSION).toBe("wss-push/1");
  expect(SUPPORTED_PROTOCOLS).toContain("wss-push/1");
});

test("SUBPROTOCOL is a valid HTTP token (RFC 7230)", () => {
  // RFC 7230 §3.2.6 tchar set; no "/", no whitespace, etc.
  const httpTokenRegex = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
  expect(SUBPROTOCOL).toBe("wss-push");
  expect(SUBPROTOCOL).toMatch(httpTokenRegex);
});

test("parseMessage rejects non-JSON", () => {
  expect(parseMessage("not json")).toBe(null);
});

test("parseMessage rejects array", () => {
  expect(parseMessage("[1,2,3]")).toBe(null);
});

test("parseMessage rejects missing method", () => {
  expect(parseMessage('{"id":1}')).toBe(null);
});

test("parseMessage accepts valid message", () => {
  const m = parseMessage('{"id":42,"method":"hello","params":{"a":1}}');
  expect(m).toEqual({ id: 42, method: "hello", params: { a: 1 } });
});

test("parseMessage normalizes missing id and params", () => {
  const m = parseMessage('{"method":"ping"}');
  expect(m).toEqual({ id: null, method: "ping", params: {} });
});

test("parseMessage accepts Buffer input", () => {
  const buf = Buffer.from('{"id":1,"method":"ping"}');
  const m = parseMessage(buf);
  expect(m && m.method).toBe("ping");
});

test("makeResponse shape", () => {
  expect(makeResponse(7, { ok: true })).toEqual({ id: 7, result: { ok: true } });
});

test("makeError shape with extras", () => {
  const e = makeError(3, ERROR_CODES.UNSUPPORTED_PROTOCOL, "nope", {
    supported: ["wss-push/1"],
  });
  expect(e.id).toBe(3);
  expect(e.error.code).toBe(ERROR_CODES.UNSUPPORTED_PROTOCOL);
  expect(e.error.message).toBe("nope");
  expect(e.error.supported).toEqual(["wss-push/1"]);
});

test("makeError accepts null id for spontaneous errors", () => {
  const e = makeError(null, ERROR_CODES.INVALID_PARAMS, "bad");
  expect(e.id).toBe(null);
});

test("makeEvent shape", () => {
  expect(makeEvent("address.changed", { address: "Nxyz" })).toEqual({
    method: "address.changed",
    params: { address: "Nxyz" },
  });
});
