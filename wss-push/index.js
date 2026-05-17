const server = require("./server");
const sessionMod = require("./session");
const subscriptions = require("./subscriptions");
const rpc = require("./rpc");
const chainState = require("./chain-state");
const nodeHealth = require("./node-health");

const VALID_AUTH_TRANSPORTS = ["sec-websocket-protocol", "query", "both"];

function validateConfig(cfg) {
  if (!cfg.path || typeof cfg.path !== "string") {
    throw new Error("[WSS-PUSH] path required");
  }
  if (!cfg.port) {
    throw new Error("[WSS-PUSH] port required");
  }
  if (cfg.tls_enabled !== false) {
    if (!cfg.ssl_cert || !cfg.ssl_key) {
      throw new Error("[WSS-PUSH] ssl_cert and ssl_key required when tls_enabled is true");
    }
  }
  const transport = cfg.auth_transport || "sec-websocket-protocol";
  if (!VALID_AUTH_TRANSPORTS.includes(transport)) {
    throw new Error(
      `[WSS-PUSH] invalid auth_transport: ${transport}. Valid: ${VALID_AUTH_TRANSPORTS.join(", ")}`,
    );
  }
  if (!cfg.auth_token || typeof cfg.auth_token !== "string") {
    throw new Error("[WSS-PUSH] auth_token required");
  }
  if (cfg.auth_token === "change-this-token") {
    const isProd = process.env.NODE_ENV === "production";
    if (isProd) {
      throw new Error(
        "[WSS-PUSH] refusing to start in production with default auth_token 'change-this-token'. Set wss_push.auth_token to a real secret.",
      );
    }
    console.log(
      "[WSS-PUSH] WARNING: auth_token is the default 'change-this-token'. This is acceptable only for local development. Set NODE_ENV=production to enforce.",
    );
  }
}

function fillDefaults(cfg) {
  return {
    enabled: cfg.enabled === true,
    host: cfg.host || "0.0.0.0",
    port: cfg.port,
    path: cfg.path || "/push",
    tls_enabled: cfg.tls_enabled !== false,
    ssl_cert: cfg.ssl_cert,
    ssl_key: cfg.ssl_key,
    auth_transport: cfg.auth_transport || "sec-websocket-protocol",
    auth_token: cfg.auth_token,
    poll_interval_ms: cfg.poll_interval_ms || 5000,
    mempool_interval_ms: cfg.mempool_interval_ms || 3000,
    max_sessions: cfg.max_sessions || 5000,
    max_subscriptions_per_session: cfg.max_subscriptions_per_session || 200,
    max_new_connections_per_second: cfg.max_new_connections_per_second || 50,
    history_page_limit: cfg.history_page_limit || 100,
    reorg_invalidate_depth: cfg.reorg_invalidate_depth || 60,
    send_initial_state: cfg.send_initial_state !== false,
    zmq_enabled: cfg.zmq_enabled === true,
    zmq_endpoint: cfg.zmq_endpoint || null,
    zmq_sequence_enabled: cfg.zmq_sequence_enabled === true,
    concurrency: cfg.concurrency || 4,
  };
}

function start(rawConfig, globalConfig) {
  if (!rawConfig || rawConfig.enabled !== true) {
    console.log("[WSS-PUSH] disabled (wss_push.enabled !== true)");
    return null;
  }
  const cfg = fillDefaults(rawConfig);
  validateConfig(cfg);

  rpc.initQueue(cfg.concurrency);

  const ctx = { config: cfg, globalConfig: globalConfig || null };
  return server.start(cfg, ctx);
}

function getStats() {
  return {
    sessions: sessionMod.getStats(),
    subscriptions: subscriptions.getStats(),
    queue: rpc.getQueueStats(),
    chain: chainState.getStats(),
    node: nodeHealth.getStatus(),
  };
}

module.exports = { start, getStats };
