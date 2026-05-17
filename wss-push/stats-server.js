// Optional local HTTP endpoint for operators / monitoring.
//
// Single route: GET /stats → JSON snapshot of sessions, subscriptions, chain
// tip, node health, ZMQ status, RPC queue. Disabled by default; activate with
// wss_push.stats_enabled=true. Always binds to 127.0.0.1 regardless of any
// host config: the response is unauthenticated and leaks internal state
// (tip height, session counts, ZMQ liveness) that should not reach the
// public network.

const http = require("http");

const startedAt = Date.now();
let server = null;

function start(cfg, getStatsFn) {
  const port = cfg.stats_port || 19021;
  server = http.createServer((req, res) => {
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "text/plain" });
      res.end("method not allowed");
      return;
    }
    if (req.url !== "/stats") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    let body;
    try {
      const payload = {
        uptime_s: Math.floor((Date.now() - startedAt) / 1000),
        ...getStatsFn(),
      };
      body = JSON.stringify(payload);
    } catch (e) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`stats error: ${e && e.message ? e.message : "unknown"}`);
      return;
    }
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
  });

  server.on("error", (e) => {
    console.log(`[stats] server error: ${e && e.message ? e.message : e}`);
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`[stats] listening on http://127.0.0.1:${port}/stats`);
  });

  return server;
}

function stop() {
  if (server) {
    server.close();
    server = null;
  }
}

module.exports = { start, stop };
