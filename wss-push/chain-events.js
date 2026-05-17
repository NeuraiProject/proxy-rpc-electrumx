// Orchestrator that turns low-level chain events (from ZMQ or polling) into
// the protocol-level events emitted to clients: chain.tip, chain.reorg,
// address.changed. Owns the reorg detection logic and the address-refresh
// fan-out.
//
// Event ordering per the protocol spec:
//   On each block: chain.tip → (chain.reorg if applicable) → address.changed*
//   address.changed reason: "block" on normal extension, "resync" after reorg,
//                           "mempool" when triggered by rawtx
//
// Refresh strategy (MVP):
//   block        -> refresh every currently subscribed address
//   rawtx        -> decode tx, collect touched addresses (outputs always,
//                   inputs via prevout cache or getrawtransaction), refresh
//                   only those with active subscriptions
//   reorg        -> same as block but reason="resync"
//
// This is intentionally simple. The plan calls out an optimization where only
// "candidate" addresses are refreshed on new blocks (those with mempool tx,
// recently touched, or marked dirty). That's a Fase 6 hardening concern; for
// MVP we accept the per-block O(N subscribed addresses) RPC cost.

const { callRPC } = require("./rpc");
const chainState = require("./chain-state");
const subscriptions = require("./subscriptions");
const notifications = require("./notifications");

let methodsRef = null;
let prevoutCache = null;
let invalidateDepth = 60;
let blockIndexSize = 120;

function configure(opts) {
  methodsRef = opts.methods;
  prevoutCache = opts.prevoutCache || null;
  invalidateDepth = opts.invalidate_depth || opts.invalidateDepth || 60;
  blockIndexSize = opts.block_index_size || opts.blockIndexSize || 120;
  chainState.configure({ maxBlockIndexSize: blockIndexSize });
}

// Pre-populate the in-memory block index by fetching the last N blocks at
// startup. Without this, after a restart we couldn't tell whether a new block
// extends the chain or is a reorg until we'd seen ~invalidate_depth new blocks
// arrive. Walking back from the current tip restores that knowledge in ~1s.
//
// Fetches happen in parallel against the RPC queue (capped at PQueue
// concurrency) — about 120 calls at ~5-10ms each, batched as ~30 rounds.
async function warmup() {
  try {
    const tipHash = await callRPC("getbestblockhash", []);
    if (typeof tipHash !== "string" || tipHash.length === 0) {
      console.log("[chain-events] warmup: getbestblockhash returned nothing");
      return false;
    }
    const tipHeader = await callRPC("getblockheader", [tipHash, true]);
    if (!tipHeader || typeof tipHeader.height !== "number") {
      console.log("[chain-events] warmup: getblockheader returned nothing");
      return false;
    }
    const tipHeight = tipHeader.height;

    const startHeight = Math.max(0, tipHeight - blockIndexSize + 1);
    const heights = [];
    for (let h = startHeight; h <= tipHeight; h++) heights.push(h);

    const results = await Promise.all(
      heights.map((h) =>
        callRPC("getblockhash", [h]).catch(() => null),
      ),
    );

    let indexed = 0;
    for (let i = 0; i < heights.length; i++) {
      if (typeof results[i] === "string" && results[i].length > 0) {
        chainState.recordBlock(heights[i], results[i]);
        indexed++;
      }
    }
    chainState.setTip(tipHeight, tipHash);

    console.log(
      `[chain-events] warmup: indexed ${indexed}/${heights.length} blocks (${startHeight}..${tipHeight}), tip=${tipHash.slice(0, 16)}...`,
    );
    return true;
  } catch (e) {
    console.log("[chain-events] warmup failed:", e && e.message ? e.message : e);
    return false;
  }
}

async function refreshAddress(address, reason, extraDelta) {
  if (!methodsRef || typeof methodsRef.fetchAddressState !== "function") return;
  let state;
  try {
    state = await methodsRef.fetchAddressState(address);
  } catch {
    return;
  }
  if (!state) return;
  const newStatus = state.status;
  const oldStatus = chainState.getLastStatus(address);
  if (newStatus === oldStatus) return;

  chainState.setLastStatus(address, newStatus);
  const tip = chainState.getTip();

  // Populate prevout cache from the freshly fetched UTXOs — outputs we just
  // saw on chain are now known to belong to this address.
  if (prevoutCache && Array.isArray(state.utxos)) {
    for (const u of state.utxos) {
      if (u && u.txid && typeof u.outputIndex === "number") {
        prevoutCache.set(u.txid, u.outputIndex, address);
      }
    }
  }

  notifications.notifyAddress(address, "address.changed", {
    address,
    status: newStatus,
    reason,
    height: tip.height,
    balance: state.balance,
    delta: {
      added_txids: (extraDelta && extraDelta.added_txids) || [],
      confirmed_txids: (extraDelta && extraDelta.confirmed_txids) || [],
      removed_txids: (extraDelta && extraDelta.removed_txids) || [],
      touched_assets: (extraDelta && extraDelta.touched_assets) || [],
    },
  });
}

async function refreshAllSubs(reason) {
  const addresses = subscriptions.getAllSubscribedAddresses();
  for (const addr of addresses) {
    // Sequential, not Promise.all: avoids slamming the node with N parallel
    // RPCs (each refreshAddress fires getaddressbalance/mempool/utxos in
    // parallel internally already).
    // eslint-disable-next-line no-await-in-loop
    await refreshAddress(addr, reason);
  }
}

// Walk backwards along the new chain (starting from `cursor` at `walkStartHeight`)
// looking for a block whose hash matches what we have stored for that height.
// Returns the height of that common ancestor, or null if not found within
// invalidate_depth steps or if our index ran out.
async function findCommonAncestor(cursor, walkStartHeight) {
  let height = walkStartHeight;
  let walked = 0;
  while (cursor && walked < invalidateDepth) {
    const ourHash = chainState.getBlockAt(height);
    if (ourHash === undefined) return null; // gap in our history — can't tell
    if (ourHash === cursor) return height;
    // Step back one block via RPC
    try {
      // eslint-disable-next-line no-await-in-loop
      const h = await callRPC("getblockheader", [cursor, true]);
      if (!h || typeof h.previousblockhash !== "string") return null;
      cursor = h.previousblockhash;
      height--;
      walked++;
    } catch {
      return null;
    }
  }
  return null;
}

async function onBlock(blockHash) {
  if (typeof blockHash !== "string" || blockHash.length === 0) return;
  let header;
  try {
    header = await callRPC("getblockheader", [blockHash, true]);
  } catch (e) {
    console.log("[chain-events] getblockheader failed:", e && e.message ? e.message : e);
    return;
  }
  if (!header || typeof header.height !== "number") return;

  const oldTip = chainState.getTip();
  const newTip = { height: header.height, hash: blockHash };

  // Suppress duplicate processing: if we already indexed this exact (height, hash),
  // ZMQ and the poller likely both fired. Skip silently.
  const existingAtSameHeight = chainState.getBlockAt(newTip.height);
  if (existingAtSameHeight === newTip.hash) {
    return;
  }

  // chain.tip is emitted before any address.changed for the same block (and
  // before chain.reorg per the protocol spec ordering rule).
  notifications.broadcast("chain.tip", {
    height: newTip.height,
    hash: newTip.hash,
  });

  // Index-based reorg detection. A reorg is unambiguous in two cases:
  //  (a) we have a different hash recorded for the new block's exact height
  //  (b) the new block's previousblockhash differs from what we have at
  //      height - 1
  // If our index has no entry for height - 1 (gap, fresh start before warmup,
  // catch-up after disconnect), we cannot determine and stay silent —
  // recording the new hash for future comparisons.
  let isReorg = false;
  let ancestorHeight = null;

  if (existingAtSameHeight !== undefined && existingAtSameHeight !== newTip.hash) {
    isReorg = true;
    ancestorHeight = await findCommonAncestor(header.previousblockhash, newTip.height - 1);
  } else {
    const prevHeight = newTip.height - 1;
    const ourPrevHash = chainState.getBlockAt(prevHeight);
    if (ourPrevHash !== undefined && ourPrevHash !== header.previousblockhash) {
      isReorg = true;
      ancestorHeight = await findCommonAncestor(header.previousblockhash, prevHeight - 1);
    }
  }

  if (isReorg) {
    const fromHeight =
      ancestorHeight !== null && ancestorHeight >= 0
        ? ancestorHeight + 1
        : Math.max(0, newTip.height - invalidateDepth);
    notifications.broadcast("chain.reorg", {
      from_height: fromHeight,
      old_tip: oldTip.hash,
      new_tip: newTip.hash,
      new_height: newTip.height,
      invalidate_depth: invalidateDepth,
    });
  }

  chainState.recordBlock(newTip.height, newTip.hash);
  chainState.setTip(newTip.height, newTip.hash);
  await refreshAllSubs(isReorg ? "resync" : "block");
}

async function onRawTx(rawtxBuffer) {
  let decoded;
  try {
    const hex = Buffer.isBuffer(rawtxBuffer)
      ? rawtxBuffer.toString("hex")
      : String(rawtxBuffer);
    decoded = await callRPC("decoderawtransaction", [hex]);
  } catch {
    return;
  }
  if (!decoded || !decoded.txid) return;

  const touched = new Set();

  // Outputs: addresses are right there in the decoded tx.
  for (const vout of decoded.vout || []) {
    const spk = vout && vout.scriptPubKey;
    const addresses = spk && Array.isArray(spk.addresses) ? spk.addresses : [];
    const n = typeof vout.n === "number" ? vout.n : null;
    for (const addr of addresses) {
      touched.add(addr);
      if (prevoutCache && n !== null) prevoutCache.set(decoded.txid, n, addr);
    }
  }

  // Inputs: try cache first, fall back to getrawtransaction. Coinbase txs
  // (vin[0].coinbase) have no prev_txid — skip.
  for (const vin of decoded.vin || []) {
    if (!vin || vin.coinbase) continue;
    if (!vin.txid || typeof vin.vout !== "number") continue;
    let addr = prevoutCache ? prevoutCache.get(vin.txid, vin.vout) : undefined;
    if (!addr) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const prev = await callRPC("getrawtransaction", [vin.txid, true]);
        const prevVout = prev && Array.isArray(prev.vout) ? prev.vout[vin.vout] : null;
        const spk = prevVout && prevVout.scriptPubKey;
        if (spk && Array.isArray(spk.addresses) && spk.addresses.length > 0) {
          addr = spk.addresses[0];
          if (prevoutCache) prevoutCache.set(vin.txid, vin.vout, addr);
        }
      } catch {
        // unresolvable prevout — accept the false negative; the next block
        // refresh will catch it. Plan §5 calls out: do NOT refresh all subs.
      }
    }
    if (addr) touched.add(addr);
  }

  // Notify subscribers of touched addresses with new status.
  const promises = [];
  for (const addr of touched) {
    const subs = subscriptions.getSubscribers(addr);
    if (subs && subs.size > 0) {
      promises.push(
        refreshAddress(addr, "mempool", { added_txids: [decoded.txid] }),
      );
    }
  }
  await Promise.all(promises);
}

async function onMempoolAdded(txids) {
  // Poller fallback path: we only got txids, not raw bytes. Fetch each as hex
  // and run it through the same decode→touched→refresh pipeline.
  for (const txid of txids) {
    let hex;
    try {
      // eslint-disable-next-line no-await-in-loop
      hex = await callRPC("getrawtransaction", [txid, false]);
    } catch {
      continue;
    }
    if (typeof hex !== "string" || hex.length === 0) continue;
    // eslint-disable-next-line no-await-in-loop
    await onRawTx(Buffer.from(hex, "hex"));
  }
}

async function onInitialTip(blockHash) {
  // Seed chainState without emitting events (server just started; no clients
  // to notify about a block from before they connected). Skipped if warmup
  // already populated chainState.
  if (chainState.getTip().hash) return;
  try {
    const header = await callRPC("getblockheader", [blockHash, true]);
    if (header && typeof header.height === "number") {
      chainState.setTip(header.height, blockHash);
      chainState.recordBlock(header.height, blockHash);
    }
  } catch {
    // ignore — next real block will recover
  }
}

module.exports = {
  configure,
  warmup,
  onBlock,
  onRawTx,
  onMempoolAdded,
  onInitialTip,
  refreshAddress,
};
