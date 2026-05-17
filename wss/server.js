const http = require("http");
const https = require("https");
const fs = require("fs");
const { WebSocketServer } = require("ws");

const protocol = require("./protocol");
const { ERROR_CODES, parseMessage, makeResponse, makeError } = protocol;
const methods = require("./methods");
const { handlers, MethodError } = methods;
const sessionMod = require("./session");
const subscriptions = require("./subscriptions");
const chainEvents = require("./chain-events");
const prevoutCache = require("./prevout-cache");
const zmqWatcher = require("./zmq-watcher");
const poller = require("./poller");
const nodeHealth = require("./node-health");
const keepalive = require("./keepalive");

const MAX_PAYLOAD_BYTES = 64 * 1024;

function statusText(code) {
  switch (code) {
    case 400: return "Bad Request";
    case 401: return "Unauthorized";
    case 404: return "Not Found";
    case 503: return "Service Unavailable";
    default: return "Error";
  }
}

function abortHandshake(socket, code, headers) {
  const lines = [`HTTP/1.1 ${code} ${statusText(code)}`];
  if (headers) {
    for (const k of Object.keys(headers)) lines.push(`${k}: ${headers[k]}`);
  }
  lines.push("Content-Length: 0");
  lines.push("Connection: close");
  lines.push("", "");
  try {
    socket.write(lines.join("\r\n"));
  } catch {
    // ignore
  }
  try {
    socket.destroy();
  } catch {
    // ignore
  }
}

function jitterRetryAfter() {
  // 1-5 seconds with jitter
  return 1 + Math.floor(Math.random() * 5);
}

function extractTokenFromProtocol(req) {
  const header = req.headers["sec-websocket-protocol"];
  if (!header) return undefined;
  const parts = header.split(",").map((s) => s.trim());
  for (const p of parts) {
    if (p.startsWith("auth.")) return p.slice("auth.".length);
  }
  return undefined;
}

function extractTokenFromQuery(req) {
  const url = req.url || "";
  const qIdx = url.indexOf("?");
  if (qIdx === -1) return undefined;
  const qs = url.slice(qIdx + 1);
  const params = new URLSearchParams(qs);
  const a = params.get("auth");
  return a == null ? undefined : a;
}

function checkAuth(req, config) {
  const transport = config.auth_transport || "sec-websocket-protocol";
  const expected = config.auth_token;
  if (!expected) return false;

  if (transport === "sec-websocket-protocol") {
    return extractTokenFromProtocol(req) === expected;
  }
  if (transport === "query") {
    return extractTokenFromQuery(req) === expected;
  }
  if (transport === "both") {
    // Prioritize header. If header carries auth.* at all, only trust that — do not fall through to query.
    const h = extractTokenFromProtocol(req);
    if (h !== undefined) return h === expected;
    const q = extractTokenFromQuery(req);
    return q === expected;
  }
  return false;
}

function pathOf(req) {
  const url = req.url || "/";
  const qIdx = url.indexOf("?");
  return qIdx === -1 ? url : url.slice(0, qIdx);
}

function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || null;
}

function startCertReloader(server, config) {
  // Watches cert + key file mtime. When either changes (e.g. certbot renewed),
  // load both into memory and call setSecureContext so new TLS handshakes use
  // the new cert. Existing connections are untouched.
  // Note: we read both files into memory before applying, so a half-written
  // renewal (cert updated but key still being written) is retried next tick.
  const intervalMs = config.cert_reload_interval_ms || 60000;

  function statSafe(path) {
    try { return fs.statSync(path).mtimeMs; } catch { return null; }
  }

  let certMtime = statSafe(config.ssl_cert);
  let keyMtime = statSafe(config.ssl_key);

  const timer = setInterval(() => {
    const newCertMtime = statSafe(config.ssl_cert);
    const newKeyMtime = statSafe(config.ssl_key);
    if (newCertMtime === null || newKeyMtime === null) return;
    if (newCertMtime === certMtime && newKeyMtime === keyMtime) return;

    let cert, key;
    try {
      cert = fs.readFileSync(config.ssl_cert);
      key = fs.readFileSync(config.ssl_key);
    } catch (e) {
      // partial write during renewal — retry next tick
      return;
    }
    try {
      server.setSecureContext({ cert, key });
      certMtime = newCertMtime;
      keyMtime = newKeyMtime;
      console.log(
        `[WSS-PUSH] reloaded TLS cert (mtime ${new Date(newCertMtime).toISOString()})`,
      );
    } catch (e) {
      console.log("[WSS-PUSH] cert reload failed:", e && e.message ? e.message : e);
    }
  }, intervalMs);
  if (timer.unref) timer.unref();
  return timer;
}

function createRateLimiter(limit) {
  const recent = [];
  return function tryAccept() {
    const now = Date.now();
    while (recent.length > 0 && recent[0] < now - 1000) recent.shift();
    if (recent.length >= limit) return false;
    recent.push(now);
    return true;
  };
}

function start(config, ctx) {
  let server;
  if (config.tls_enabled === false) {
    // Plain HTTP mode. Used when a reverse proxy (nginx/Caddy/etc.) terminates TLS upstream
    // and forwards the WebSocket upgrade to this port. NEVER expose this port directly to the
    // internet — bind to a private interface or restrict via firewall.
    server = http.createServer();
    console.log("[WSS-PUSH] TLS disabled (tls_enabled=false). Expect a reverse proxy to terminate TLS.");
  } else {
    if (!fs.existsSync(config.ssl_cert)) {
      throw new Error(`[WSS-PUSH] ssl_cert not found: ${config.ssl_cert}`);
    }
    if (!fs.existsSync(config.ssl_key)) {
      throw new Error(`[WSS-PUSH] ssl_key not found: ${config.ssl_key}`);
    }
    server = https.createServer({
      cert: fs.readFileSync(config.ssl_cert),
      key: fs.readFileSync(config.ssl_key),
    });
    startCertReloader(server, config);
  }

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD_BYTES,
    handleProtocols: (protocols /*, req */) => {
      // protocols is Set<string> in ws 8+. Return the wire-level SUBPROTOCOL ("wss-push")
      // if offered; otherwise return null to accept without echoing a subprotocol header
      // (RFC 6455 allows this — useful for query-mode clients that don't send any).
      // Returning false would reject the upgrade outright.
      if (protocols && typeof protocols.has === "function") {
        if (protocols.has(protocol.SUBPROTOCOL)) return protocol.SUBPROTOCOL;
      }
      return null;
    },
  });

  const tryAcceptConn = createRateLimiter(config.max_new_connections_per_second || 50);

  server.on("upgrade", (req, socket, head) => {
    if (pathOf(req) !== config.path) {
      return abortHandshake(socket, 404);
    }
    if (!checkAuth(req, config)) {
      return abortHandshake(socket, 401);
    }
    if (!tryAcceptConn()) {
      return abortHandshake(socket, 503, { "Retry-After": jitterRetryAfter() });
    }
    if (sessionMod.getStats().sessionCount >= (config.max_sessions || 5000)) {
      return abortHandshake(socket, 503, { "Retry-After": jitterRetryAfter() });
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws, req) => {
    const session = sessionMod.createSession(ws, clientIp(req));
    keepalive.start(ws, session, config);

    ws.on("message", async (raw) => {
      session.lastSeen = Date.now();
      session.msgCount++;
      const msg = parseMessage(raw);
      if (!msg) {
        sessionMod.sendJson(
          session,
          makeError(null, ERROR_CODES.INVALID_PARAMS, "invalid message"),
        );
        return;
      }
      const handler = handlers[msg.method];
      if (!handler) {
        sessionMod.sendJson(
          session,
          makeError(msg.id, ERROR_CODES.METHOD_NOT_FOUND, `method not found: ${msg.method}`),
        );
        return;
      }
      try {
        const result = await handler(session, msg.params, ctx);
        sessionMod.sendJson(session, makeResponse(msg.id, result));
      } catch (e) {
        if (e instanceof MethodError) {
          sessionMod.sendJson(session, makeError(msg.id, e.code, e.message, e.extra));
          if (e.code === ERROR_CODES.UNSUPPORTED_PROTOCOL) {
            try { ws.close(protocol.WS_CLOSE_CODES.UNSUPPORTED_PROTOCOL, "unsupported protocol"); } catch {}
          }
        } else {
          console.log("[WSS-PUSH] handler error:", e && e.message ? e.message : e);
          sessionMod.sendJson(
            session,
            makeError(msg.id, ERROR_CODES.INTERNAL_ERROR, "internal error"),
          );
        }
      }
    });

    ws.on("close", () => {
      keepalive.stop(session);
      subscriptions.unsubscribeAll(session);
      sessionMod.destroySession(session);
    });

    ws.on("error", (e) => {
      console.log("[WSS-PUSH] socket error:", e && e.message ? e.message : e);
    });
  });

  server.listen(config.port, config.host || "0.0.0.0", () => {
    const scheme = config.tls_enabled === false ? "ws" : "wss";
    console.log(
      `[WSS-PUSH] listening on ${scheme}://${config.host || "0.0.0.0"}:${config.port}${config.path}`,
    );
  });

  startChainEvents(config);

  return { server, wss };
}

function startChainEvents(config) {
  const cache = prevoutCache.create({ maxSize: 100000 });
  chainEvents.configure({
    methods,
    prevoutCache: cache,
    invalidate_depth: config.reorg_invalidate_depth || 60,
    block_index_size: config.block_index_size || 120,
  });

  const handlersForWatchers = {
    onBlock: (hash) => {
      chainEvents.onBlock(hash).catch((e) =>
        console.log("[chain-events] onBlock error:", e && e.message ? e.message : e),
      );
    },
    onRawTx: (buf) => {
      chainEvents.onRawTx(buf).catch((e) =>
        console.log("[chain-events] onRawTx error:", e && e.message ? e.message : e),
      );
    },
    onMempoolAdded: (txids) => {
      chainEvents.onMempoolAdded(txids).catch((e) =>
        console.log("[chain-events] onMempoolAdded error:", e && e.message ? e.message : e),
      );
    },
    onInitialTip: (hash) => {
      chainEvents.onInitialTip(hash).catch(() => {});
    },
    onSequenceGap: (topic, prev, next) => {
      console.log(`[ZMQ] sequence gap on ${topic}: ${prev} -> ${next}, polling will resync`);
    },
  };

  // Node health poll (cheap, every 10s by default). Starts immediately so
  // requireSynced() in method handlers has fresh data right after listen().
  nodeHealth.start({
    pollIntervalMs: config.node_health_poll_interval_ms || 10000,
  });

  // Warm up the block index before opening watchers so that the very first
  // onBlock has enough history to do reorg detection correctly. Watchers
  // start after warmup completes (or fails — we don't block forever).
  (async () => {
    await chainEvents.warmup();

    // ZMQ first (real-time). Falls back silently if the optional `zeromq` dep
    // isn't installed or if connection fails — the poller handles it.
    zmqWatcher.start(config, handlersForWatchers).catch((e) =>
      console.log("[ZMQ] start failed:", e && e.message ? e.message : e),
    );

    // Polling fallback runs always — covers ZMQ outages, missed messages, and
    // first-tip seeding before any block arrives via ZMQ.
    poller.start(
      {
        poll_interval_ms: config.poll_interval_ms,
        mempool_interval_ms: config.mempool_interval_ms,
      },
      handlersForWatchers,
    );
  })().catch((e) =>
    console.log("[chain-events] startup error:", e && e.message ? e.message : e),
  );
}

module.exports = { start };
