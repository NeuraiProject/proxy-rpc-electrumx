// Periodic poll of the Neurai node's sync state via getblockchaininfo.
//
// Exposes:
//   isSyncing()   — true while the node is mid-IBD or otherwise out of sync.
//   getStatus()   — { syncing, verification_progress, blocks, headers, ... }
//
// Broadcasts:
//   node.synced   — when the node transitions from syncing → synced
//   node.syncing  — when the node transitions back to syncing (uncommon;
//                    indicates a fork, deep reorg, or RPC was unreachable).
//
// Handlers that depend on a fully-synced chain (address.subscribe,
// tx.broadcast, read-only depin.*) call common.requireSynced() to refuse
// requests while syncing=true with a structured 1008 error.

const { callRPC } = require("./rpc");
const notifications = require("./notifications");

let state = {
  // Pessimistic default: until the first successful poll we treat the node as
  // syncing. Methods that require a synced node will be refused with 1008 in
  // this window (typically <10s after start).
  syncing: true,
  verification_progress: 0,
  blocks: null,
  headers: null,
  last_check_ts: null,
  last_check_ok: false,
};

let pollTimer = null;
let pollIntervalMs = 10000;
let firstPollDone = false;

function configure(opts) {
  if (opts && typeof opts.pollIntervalMs === "number" && opts.pollIntervalMs > 0) {
    pollIntervalMs = opts.pollIntervalMs;
  }
}

function evaluate(info) {
  if (!info || typeof info !== "object") return true; // treat as syncing
  const progressOk =
    typeof info.verificationprogress === "number" && info.verificationprogress > 0.999;
  const headersAligned =
    typeof info.blocks === "number" &&
    typeof info.headers === "number" &&
    info.headers - info.blocks < 2;
  // initialblockdownload is a strong signal when the node exposes it; some
  // builds don't, so we don't require it — just trust it when present.
  const ibdOk = info.initialblockdownload === false || info.initialblockdownload === undefined;
  return !(progressOk && headersAligned && ibdOk);
}

async function poll() {
  let info;
  try {
    info = await callRPC("getblockchaininfo", []);
  } catch (e) {
    state.last_check_ts = Date.now();
    state.last_check_ok = false;
    return;
  }
  const newSyncing = evaluate(info);
  const wasSyncing = state.syncing;

  state = {
    syncing: newSyncing,
    verification_progress:
      typeof info.verificationprogress === "number" ? info.verificationprogress : 0,
    blocks: typeof info.blocks === "number" ? info.blocks : null,
    headers: typeof info.headers === "number" ? info.headers : null,
    last_check_ts: Date.now(),
    last_check_ok: true,
  };

  // Suppress transitions on the very first poll — the wasSyncing default
  // (true) doesn't represent prior observed state, just our pessimistic seed.
  if (!firstPollDone) {
    firstPollDone = true;
    console.log(
      `[node-health] first check: syncing=${state.syncing} blocks=${state.blocks}/${state.headers} progress=${(state.verification_progress * 100).toFixed(2)}%`,
    );
    return;
  }

  if (wasSyncing && !newSyncing) {
    console.log(`[node-health] node synced (height=${state.blocks})`);
    notifications.broadcast("node.synced", {
      height: state.blocks,
      verification_progress: state.verification_progress,
    });
  } else if (!wasSyncing && newSyncing) {
    console.log(
      `[node-health] node fell out of sync (blocks=${state.blocks} headers=${state.headers})`,
    );
    notifications.broadcast("node.syncing", {
      blocks: state.blocks,
      headers: state.headers,
      verification_progress: state.verification_progress,
    });
  }
}

function getStatus() {
  return { ...state };
}

function isSyncing() {
  return state.syncing;
}

function start(opts) {
  if (pollTimer) return;
  if (opts) configure(opts);
  // First poll immediately so requireSynced has fresh data within ~50ms.
  poll();
  pollTimer = setInterval(poll, pollIntervalMs);
  if (pollTimer.unref) pollTimer.unref();
}

function stop() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

module.exports = {
  configure,
  start,
  stop,
  poll,
  getStatus,
  isSyncing,
};
