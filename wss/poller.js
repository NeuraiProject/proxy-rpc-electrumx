// Polling fallback for chain + mempool events when ZMQ is unavailable or
// drops messages. Cheap: just compares getbestblockhash and getrawmempool
// against the last known state. When a change is observed, calls the same
// handlers ZMQ would have invoked.

const { callRPC } = require("./rpc");

function start(config, handlers) {
  const blockIntervalMs = Math.max(500, config.poll_interval_ms || 5000);
  const mempoolIntervalMs = Math.max(500, config.mempool_interval_ms || 3000);

  let lastBestHash = null;
  let lastMempool = null; // Set<txid> | null until first successful poll
  let blockBusy = false;
  let mempoolBusy = false;

  async function pollBlock() {
    if (blockBusy) return;
    blockBusy = true;
    try {
      const hash = await callRPC("getbestblockhash", []);
      if (typeof hash !== "string" || hash.length === 0) return;
      if (hash === lastBestHash) return;
      const wasFirst = lastBestHash === null;
      lastBestHash = hash;
      if (!wasFirst && handlers.onBlock) handlers.onBlock(hash);
      else if (wasFirst && handlers.onInitialTip) handlers.onInitialTip(hash);
    } catch (e) {
      // RPC down — silent, will retry next tick
    } finally {
      blockBusy = false;
    }
  }

  async function pollMempool() {
    if (mempoolBusy) return;
    mempoolBusy = true;
    try {
      const list = await callRPC("getrawmempool", []);
      if (!Array.isArray(list)) return;
      const newSet = new Set(list);
      if (lastMempool === null) {
        // first snapshot — don't fire handlers, just establish baseline
        lastMempool = newSet;
        return;
      }
      const added = [];
      for (const t of list) if (!lastMempool.has(t)) added.push(t);
      lastMempool = newSet;
      if (added.length > 0 && handlers.onMempoolAdded) {
        handlers.onMempoolAdded(added);
      }
    } catch (e) {
      // silent
    } finally {
      mempoolBusy = false;
    }
  }

  // Stagger first ticks so we don't slam the node at startup.
  setTimeout(() => pollBlock(), 500);
  setTimeout(() => pollMempool(), 1500);

  const blockTimer = setInterval(pollBlock, blockIntervalMs);
  const mempoolTimer = setInterval(pollMempool, mempoolIntervalMs);
  if (blockTimer.unref) blockTimer.unref();
  if (mempoolTimer.unref) mempoolTimer.unref();

  return { blockTimer, mempoolTimer };
}

module.exports = { start };
