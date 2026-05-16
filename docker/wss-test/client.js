const WebSocket = require("ws");

const HOST = process.env.PROXY_HOST || "rpc-proxy";
const PORT = process.env.PROXY_PORT || "19020";
const PATH = process.env.PROXY_PATH || "/push";
const SCHEME = process.env.PROXY_SCHEME || "wss";
const TOKEN =
  process.env.PROXY_TOKEN ||
  "testnet-wss-push-token-do-not-use-in-production";
const TEST_ADDRESS = process.env.TEST_ADDRESS || null;
const BURST_SIZE = Number(process.env.BURST_SIZE || 80);
const BURST_LIMIT = Number(process.env.BURST_LIMIT || 50);

const URL = `${SCHEME}://${HOST}:${PORT}${PATH}`;
const SUBPROTOCOL = "wss-push";
const PROTOCOL_VERSION = "wss-push/1";

let passed = 0;
let failed = 0;
const failures = [];

function ok(name) {
  console.log(`  ok  ${name}`);
  passed++;
}
function fail(name, reason) {
  console.log(`  FAIL ${name}: ${reason}`);
  failed++;
  failures.push({ name, reason });
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function connect(opts) {
  opts = opts || {};
  let protocols;
  if (Array.isArray(opts.protocols)) {
    protocols = opts.protocols;
  } else if (opts.token === null) {
    protocols = [SUBPROTOCOL];
  } else {
    const token = opts.token == null ? TOKEN : opts.token;
    protocols = [SUBPROTOCOL, `auth.${token}`];
  }
  return new Promise((resolve) => {
    const ws = new WebSocket(URL, protocols, { rejectUnauthorized: false });
    let resolved = false;
    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(t);
      resolve(result);
    };
    ws.on("open", () => finish({ ws, status: "open" }));
    ws.on("unexpected-response", (req, res) =>
      finish({ ws, status: res.statusCode, headers: res.headers }),
    );
    ws.on("error", (e) => finish({ ws, status: "error", error: e }));
    const t = setTimeout(() => finish({ ws, status: "timeout" }), 10000);
  });
}

function rpc(ws, msg) {
  return new Promise((resolve, reject) => {
    const id = msg.id;
    const onMessage = (raw) => {
      let r;
      try {
        r = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }
      if (r.id === id) {
        ws.removeListener("message", onMessage);
        clearTimeout(t);
        resolve(r);
      }
    };
    ws.on("message", onMessage);
    const t = setTimeout(() => {
      ws.removeListener("message", onMessage);
      reject(new Error(`rpc timeout for id=${id} method=${msg.method}`));
    }, 10000);
    ws.send(JSON.stringify(msg));
  });
}

async function withSession(fn) {
  const res = await connect();
  if (res.status !== "open") {
    throw new Error(`could not open session: status=${res.status}`);
  }
  try {
    await rpc(res.ws, {
      id: 1,
      method: "hello",
      params: {
        client: "wss-test",
        version: "0.1.0",
        network: "testnet",
        protocol: PROTOCOL_VERSION,
      },
    });
    return await fn(res.ws);
  } finally {
    try { res.ws.close(); } catch {}
  }
}

async function waitForProxy() {
  const max = 60;
  for (let i = 0; i < max; i++) {
    const res = await connect();
    if (res.status === "open") {
      try { res.ws.close(); } catch {}
      return;
    }
    try { if (res.ws) res.ws.terminate(); } catch {}
    console.log(`  ... waiting for proxy (${i + 1}/${max}, last=${res.status})`);
    await delay(2000);
  }
  throw new Error("proxy never became reachable");
}

async function test401NoAuth() {
  const res = await connect({ token: null });
  try {
    if (res.status === 401) ok("401 with no auth subprotocol");
    else fail("401 with no auth", `got status=${res.status}`);
  } finally {
    try { res.ws.terminate(); } catch {}
  }
}

async function test401WrongToken() {
  const res = await connect({ token: "wrong-token" });
  try {
    if (res.status === 401) ok("401 with wrong token");
    else fail("401 with wrong token", `got status=${res.status}`);
  } finally {
    try { res.ws.terminate(); } catch {}
  }
}

async function test404Path() {
  const ws = new WebSocket(`${SCHEME}://${HOST}:${PORT}/nope`, [SUBPROTOCOL, `auth.${TOKEN}`], {
    rejectUnauthorized: false,
  });
  const status = await new Promise((resolve) => {
    let done = false;
    const finish = (s) => { if (!done) { done = true; resolve(s); } };
    ws.on("open", () => finish("open"));
    ws.on("unexpected-response", (req, res) => finish(res.statusCode));
    ws.on("error", () => finish("error"));
    setTimeout(() => finish("timeout"), 5000);
  });
  try { ws.terminate(); } catch {}
  if (status === 404) ok("404 on wrong path");
  else fail("404 wrong path", `got ${status}`);
}

async function testHello() {
  const res = await connect();
  if (res.status !== "open") return fail("hello: open", `status=${res.status}`);
  try {
    const r = await rpc(res.ws, {
      id: 100,
      method: "hello",
      params: { client: "wss-test", version: "0.1.0", network: "testnet", protocol: PROTOCOL_VERSION },
    });
    if (!r.result) return fail("hello: result", JSON.stringify(r));
    if (r.result.protocol !== PROTOCOL_VERSION)
      return fail("hello: protocol", r.result.protocol);
    if (typeof r.result.tip_height !== "number" && r.result.tip_height !== null)
      return fail("hello: tip_height type", String(r.result.tip_height));
    ok(
      `hello returns protocol=${r.result.protocol} tip_height=${r.result.tip_height}`,
    );
  } finally {
    try { res.ws.close(); } catch {}
  }
}

async function testHelloUnsupportedProtocol() {
  const res = await connect();
  if (res.status !== "open") return fail("hello bad: open", `status=${res.status}`);
  try {
    const r = await rpc(res.ws, {
      id: 200,
      method: "hello",
      params: { protocol: "wss-push/999" },
    });
    if (r.error && r.error.code === 1001) ok("hello rejects unsupported protocol (1001)");
    else fail("hello unsupported protocol", JSON.stringify(r));
  } finally {
    try { res.ws.terminate(); } catch {}
  }
}

async function testPing() {
  await withSession(async (ws) => {
    const r = await rpc(ws, { id: 300, method: "ping" });
    if (r.result === "pong") ok("ping returns pong");
    else fail("ping", JSON.stringify(r));
  });
}

async function testHelloRequiredForSubscribe() {
  const res = await connect();
  if (res.status !== "open") return fail("pre-hello check: open", `status=${res.status}`);
  try {
    const r = await rpc(res.ws, {
      id: 400,
      method: "address.subscribe",
      params: { address: "Nxxx" },
    });
    if (r.error && r.error.code === 1003) ok("methods require hello before use");
    else fail("pre-hello protection", JSON.stringify(r));
  } finally {
    try { res.ws.close(); } catch {}
  }
}

async function testInvalidAddress() {
  await withSession(async (ws) => {
    const r = await rpc(ws, {
      id: 500,
      method: "address.subscribe",
      params: { address: "this-is-not-a-valid-address" },
    });
    if (r.error && r.error.code === 1003) ok("address.subscribe rejects invalid address (1003)");
    else fail("invalid address", JSON.stringify(r));
  });
}

async function testUnsubscribeIdempotent() {
  await withSession(async (ws) => {
    const r = await rpc(ws, {
      id: 600,
      method: "address.unsubscribe",
      params: { address: "never-subscribed" },
    });
    if (r.result === true) ok("address.unsubscribe is idempotent");
    else fail("unsubscribe idempotent", JSON.stringify(r));
  });
}

async function testBroadcastGarbage() {
  await withSession(async (ws) => {
    const r = await rpc(ws, {
      id: 700,
      method: "tx.broadcast",
      params: { rawtx: "deadbeef" },
    });
    if (r.error && r.error.code === 1005) ok("tx.broadcast normalizes node error (1005)");
    else fail("broadcast garbage", JSON.stringify(r));
  });
}

async function testValidAddressSubscribe() {
  if (!TEST_ADDRESS) {
    console.log("  -- TEST_ADDRESS not set, skipping happy-path address.subscribe");
    return;
  }
  await withSession(async (ws) => {
    const r = await rpc(ws, {
      id: 800,
      method: "address.subscribe",
      params: { address: TEST_ADDRESS },
    });
    if (!r.result) return fail("valid address: result", JSON.stringify(r));
    if (typeof r.result.status !== "string")
      return fail("valid address: status type", JSON.stringify(r.result));
    if (!r.result.balance || typeof r.result.balance.confirmed !== "number")
      return fail("valid address: balance", JSON.stringify(r.result));
    ok(
      `address.subscribe(${TEST_ADDRESS}) status=${r.result.status.slice(0, 12)}... confirmed=${r.result.balance.confirmed}`,
    );
  });
}

async function testDepinChallengeRequiresAddress() {
  await withSession(async (ws) => {
    const r = await rpc(ws, { id: 900, method: "depin.challenge", params: {} });
    if (r.error && r.error.code === 1003) ok("depin.challenge rejects missing address (1003)");
    else fail("depin.challenge missing address", JSON.stringify(r));
  });
}

async function testDepinSignedRejectsMissingSignature() {
  await withSession(async (ws) => {
    const r = await rpc(ws, {
      id: 901,
      method: "depin.send_msg",
      params: { address: "Nxxx", args: [] },
    });
    if (r.error && r.error.code === 1003) ok("depin.send_msg rejects missing signature (1003)");
    else fail("depin signed missing signature", JSON.stringify(r));
  });
}

async function testDepinReadOnlyRoutes() {
  // Without a real node behind, the call fails with INTERNAL_ERROR — we just
  // verify the method is registered and routes to callRPC, not METHOD_NOT_FOUND.
  await withSession(async (ws) => {
    const r = await rpc(ws, {
      id: 902,
      method: "depin.pool_stats",
      params: {},
    });
    if (r.error && r.error.code === 1005) ok("depin.pool_stats routes (RPC error normalized)");
    else if (r.result !== undefined) ok("depin.pool_stats returned a result");
    else fail("depin.pool_stats routing", JSON.stringify(r));
  });
}

async function testDepinUnknownMethod() {
  await withSession(async (ws) => {
    const r = await rpc(ws, {
      id: 903,
      method: "depin.totally_made_up",
      params: {},
    });
    if (r.error && r.error.code === 1004) ok("depin.* unknown method returns 1004");
    else fail("depin unknown method", JSON.stringify(r));
  });
}

async function testBurst() {
  await delay(1100); // wait past the rate-limit window from prior tests
  const promises = [];
  for (let i = 0; i < BURST_SIZE; i++) promises.push(connect());
  const results = await Promise.all(promises);
  const opens = results.filter((r) => r.status === "open").length;
  const limited = results.filter((r) => r.status === 503).length;
  results.forEach((r) => { try { if (r.ws) r.ws.terminate(); } catch {} });

  if (limited > 0) {
    ok(`burst: ${limited}/${BURST_SIZE} got 503, ${opens}/${BURST_SIZE} opened (limit=${BURST_LIMIT}/s)`);
    const r503 = results.find((r) => r.status === 503);
    if (r503 && r503.headers && r503.headers["retry-after"]) {
      ok(`burst: Retry-After present (${r503.headers["retry-after"]}s)`);
    } else {
      fail("burst Retry-After", "missing or unparsed");
    }
  } else {
    fail("burst", `expected some 503s with burst=${BURST_SIZE} > limit=${BURST_LIMIT}; got opens=${opens}`);
  }
}

(async () => {
  console.log(`[wss-test] target: ${URL}`);
  console.log(`[wss-test] token: ${TOKEN.slice(0, 8)}...`);

  try {
    await waitForProxy();
  } catch (e) {
    console.log(`[wss-test] FATAL: ${e.message}`);
    process.exit(2);
  }

  console.log("[wss-test] running tests");

  await test401NoAuth();
  await test401WrongToken();
  await test404Path();
  await testHello();
  await testHelloUnsupportedProtocol();
  await testPing();
  await testHelloRequiredForSubscribe();
  await testInvalidAddress();
  await testUnsubscribeIdempotent();
  await testBroadcastGarbage();
  await testDepinChallengeRequiresAddress();
  await testDepinSignedRejectsMissingSignature();
  await testDepinReadOnlyRoutes();
  await testDepinUnknownMethod();
  await testValidAddressSubscribe();
  await testBurst();

  console.log("");
  console.log(`[wss-test] ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("[wss-test] failures:");
    for (const f of failures) console.log(`  - ${f.name}: ${f.reason}`);
  }
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.log(`[wss-test] unexpected error: ${e && e.stack ? e.stack : e}`);
  process.exit(3);
});
