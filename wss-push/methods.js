const protocol = require("./protocol");
const { ERROR_CODES } = protocol;
const { callRPC } = require("./rpc");
const subscriptions = require("./subscriptions");
const { statusHash } = require("./status");
const { MethodError, requireHello, requireSynced } = require("./common");
const chainState = require("./chain-state");
const nodeHealth = require("./node-health");
const cursor = require("./cursor");
const depin = require("./depin-methods");

async function fetchAddressState(address) {
  const [balanceRaw, mempoolRaw, utxosRaw] = await Promise.all([
    callRPC("getaddressbalance", [{ addresses: [address] }]).catch(() => null),
    callRPC("getaddressmempool", [{ addresses: [address] }]).catch(() => []),
    callRPC("getaddressutxos", [{ addresses: [address] }]).catch(() => []),
  ]);

  const confirmed = balanceRaw && typeof balanceRaw.balance === "number" ? balanceRaw.balance : 0;
  let unconfirmed = 0;
  const mempool = Array.isArray(mempoolRaw) ? mempoolRaw : [];
  for (const m of mempool) {
    if (typeof m.satoshis === "number") unconfirmed += m.satoshis;
  }

  const utxos = Array.isArray(utxosRaw) ? utxosRaw : [];
  const utxosForHash = utxos.map((u) => ({
    txid: u.txid,
    vout: u.outputIndex,
    value: u.satoshis,
    asset: u.assetName || "",
  }));

  const mempoolTxids = mempool.map((m) => m.txid);

  return {
    balance: { confirmed, unconfirmed },
    mempool,
    mempoolTxids,
    utxos,
    utxosForHash,
    status: statusHash({
      balance: { confirmed, unconfirmed },
      mempoolTxids,
      utxos: utxosForHash,
    }),
  };
}

const handlers = {
  hello: async (session, params /*, ctx */) => {
    if (params && params.protocol && !protocol.SUPPORTED_PROTOCOLS.includes(params.protocol)) {
      throw new MethodError(
        ERROR_CODES.UNSUPPORTED_PROTOCOL,
        "unsupported protocol",
        { supported: protocol.SUPPORTED_PROTOCOLS },
      );
    }
    session.helloDone = true;
    session.client = params && typeof params.client === "string" ? params.client : null;
    session.clientVersion =
      params && typeof params.version === "string" ? params.version : null;
    session.network = params && typeof params.network === "string" ? params.network : null;

    let tipHeight = null;
    let tipHash = null;
    try {
      tipHash = await callRPC("getbestblockhash", []);
      if (tipHash) {
        const header = await callRPC("getblockheader", [tipHash]);
        if (header && typeof header.height === "number") tipHeight = header.height;
      }
    } catch {
      // best-effort
    }

    const sync = nodeHealth.getStatus();

    return {
      server: "neurai-rpc-proxy-wss",
      protocol: protocol.VERSION,
      protocol_min: protocol.VERSION,
      protocol_max: protocol.VERSION,
      network: session.network,
      tip_height: tipHeight,
      tip_hash: tipHash,
      syncing: sync.syncing,
      verification_progress: sync.verification_progress,
      blocks: sync.blocks,
      headers: sync.headers,
    };
  },

  ping: async () => "pong",

  "address.subscribe": async (session, params, ctx) => {
    requireHello(session);
    requireSynced();
    if (!params || typeof params.address !== "string" || params.address.length === 0) {
      throw new MethodError(ERROR_CODES.INVALID_PARAMS, "address required");
    }
    const address = params.address;

    if (session.subs.size >= ctx.config.max_subscriptions_per_session) {
      throw new MethodError(ERROR_CODES.TOO_MANY_SUBS, "max subscriptions per session reached");
    }

    const val = await callRPC("validateaddress", [address]).catch(() => null);
    if (!val || val.isvalid !== true) {
      throw new MethodError(ERROR_CODES.INVALID_PARAMS, "invalid address");
    }

    subscriptions.subscribe(address, session);

    if (!ctx.config.send_initial_state) {
      return { address };
    }

    const state = await fetchAddressState(address);
    // Seed lastStatus so that chain-events doesn't spuriously emit
    // address.changed on the next refresh tick for an unchanged status.
    chainState.setLastStatus(address, state.status);

    let height = null;
    try {
      const h = await callRPC("getblockcount", []);
      if (typeof h === "number") height = h;
    } catch {
      // best-effort
    }

    return {
      address,
      status: state.status,
      balance: state.balance,
      height,
    };
  },

  "address.unsubscribe": async (session, params) => {
    requireHello(session);
    if (!params || typeof params.address !== "string") {
      throw new MethodError(ERROR_CODES.INVALID_PARAMS, "address required");
    }
    subscriptions.unsubscribe(params.address, session);
    return true;
  },

  "address.get_state": async (session, params, ctx) => {
    requireHello(session);
    requireSynced();
    if (!params || typeof params.address !== "string" || params.address.length === 0) {
      throw new MethodError(ERROR_CODES.INVALID_PARAMS, "address required");
    }
    const address = params.address;

    // Asset filter — MVP is native-only. Fase 5 will lift this.
    if (params.asset != null && params.asset !== false) {
      throw new MethodError(
        ERROR_CODES.INVALID_PARAMS,
        "asset filter not supported yet (use null/false for native)",
      );
    }

    const val = await callRPC("validateaddress", [address]).catch(() => null);
    if (!val || val.isvalid !== true) {
      throw new MethodError(ERROR_CODES.INVALID_PARAMS, "invalid address");
    }

    const includeHistory = params.include_history !== false;
    const includeUtxos = params.include_utxos !== false;

    const maxLimit = ctx.config.history_page_limit || 100;
    let limit = params.limit;
    if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
      limit = maxLimit;
    }
    limit = Math.min(Math.floor(limit), maxLimit);

    let cursorParsed = null;
    if (params.cursor !== undefined && params.cursor !== null) {
      cursorParsed = cursor.decode(params.cursor);
      if (cursorParsed === null) {
        throw new MethodError(ERROR_CODES.INVALID_PARAMS, "invalid cursor");
      }
    }
    if (cursorParsed === null) {
      if (typeof params.from_height === "number" && params.from_height >= 0) {
        cursorParsed = { height: Math.floor(params.from_height), tx_index: 0 };
      } else {
        cursorParsed = { height: 0, tx_index: 0 };
      }
    }

    // Always fetch the cheap stuff (balance + mempool + utxos for the status hash).
    const state = await fetchAddressState(address);
    const tip = chainState.getTip();

    let history = [];
    const pageInfo = {
      cursor: params.cursor != null ? params.cursor : null,
      limit,
      has_more: false,
      next_cursor: null,
    };

    if (includeHistory) {
      // Neurai's getaddressdeltas rejects start=0 with error -5 — "start and
      // end is expected to be greater than zero". The block-0 coinbase isn't
      // useful for any real wallet so just clamp the lower bound to 1.
      const start = Math.max(1, cursorParsed.height);
      const end = Math.max(start, tip.height || start);
      let deltas = [];
      try {
        deltas = await callRPC("getaddressdeltas", [
          { addresses: [address], start, end },
        ]);
        if (!Array.isArray(deltas)) deltas = [];
      } catch (e) {
        console.log(
          "[methods] getaddressdeltas failed:",
          e && e.message ? e.message : e,
        );
        deltas = [];
      }

      // Aggregate per (height, blockindex, txid) so a tx with multiple outputs
      // to the same address becomes a single history entry with the net delta.
      const agg = new Map();
      for (const d of Array.isArray(deltas) ? deltas : []) {
        if (typeof d.height !== "number" || typeof d.blockindex !== "number") continue;
        const key = `${d.height}:${d.blockindex}:${d.txid}`;
        const e = agg.get(key) || {
          height: d.height,
          tx_index: d.blockindex,
          txid: d.txid,
          satoshis: 0,
        };
        e.satoshis += typeof d.satoshis === "number" ? d.satoshis : 0;
        agg.set(key, e);
      }
      let sorted = [...agg.values()].sort(
        (a, b) => a.height - b.height || a.tx_index - b.tx_index,
      );

      // Skip everything strictly before the cursor.
      sorted = sorted.filter((e) => {
        if (e.height > cursorParsed.height) return true;
        if (e.height === cursorParsed.height && e.tx_index >= cursorParsed.tx_index) return true;
        return false;
      });

      history = sorted.slice(0, limit);
      if (sorted.length > limit) {
        const next = sorted[limit];
        pageInfo.has_more = true;
        pageInfo.next_cursor = cursor.encode(next.height, next.tx_index);
      }
    }

    const mempool = (state.mempool || []).map((m) => ({
      txid: m.txid,
      satoshis: typeof m.satoshis === "number" ? m.satoshis : 0,
      prev_txid: m.prevtxid || null,
      prev_vout: typeof m.prevout === "number" ? m.prevout : null,
    }));

    // UTXOs — by default capped at 100 to keep mobile payloads sane. The
    // wallet can ask for the full set with `utxo_limit: 0`, or page through
    // with `utxo_cursor`. Sort is deterministic so cursors are stable across
    // calls (height, txid lexicographic, vout).
    let utxos = [];
    let utxoPage = {
      cursor: params.utxo_cursor != null ? params.utxo_cursor : null,
      limit: 0,
      has_more: false,
      next_cursor: null,
    };

    if (includeUtxos) {
      const allUtxos = (state.utxos || []).map((u) => ({
        txid: u.txid,
        vout: u.outputIndex,
        satoshis: u.satoshis,
        height: u.height,
      }));
      allUtxos.sort(
        (a, b) =>
          a.height - b.height ||
          (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : 0) ||
          a.vout - b.vout,
      );

      const utxoLimitDefault = 100;
      const utxoLimitCap = ctx.config.utxo_page_limit || 1000;
      let utxoLimit = params.utxo_limit;

      if (utxoLimit === 0) {
        // Explicit opt-in for the full set — bypass the cap. The client took
        // responsibility for handling the payload size.
        utxos = allUtxos;
        utxoPage = {
          cursor: null,
          limit: 0,
          has_more: false,
          next_cursor: null,
        };
      } else {
        if (typeof utxoLimit !== "number" || !Number.isFinite(utxoLimit) || utxoLimit < 0) {
          utxoLimit = utxoLimitDefault;
        }
        utxoLimit = Math.min(Math.floor(utxoLimit), utxoLimitCap);

        let parsedUtxoCursor = null;
        if (params.utxo_cursor != null) {
          parsedUtxoCursor = cursor.decodeUtxo(params.utxo_cursor);
          if (parsedUtxoCursor === null) {
            throw new MethodError(
              ERROR_CODES.INVALID_PARAMS,
              "invalid utxo_cursor",
            );
          }
        }

        let sliced = allUtxos;
        if (parsedUtxoCursor) {
          sliced = sliced.filter((u) => {
            if (u.height > parsedUtxoCursor.height) return true;
            if (u.height < parsedUtxoCursor.height) return false;
            if (u.txid > parsedUtxoCursor.txid) return true;
            if (u.txid < parsedUtxoCursor.txid) return false;
            return u.vout >= parsedUtxoCursor.vout;
          });
        }

        utxos = sliced.slice(0, utxoLimit);
        if (sliced.length > utxoLimit) {
          const next = sliced[utxoLimit];
          utxoPage = {
            cursor: params.utxo_cursor != null ? params.utxo_cursor : null,
            limit: utxoLimit,
            has_more: true,
            next_cursor: cursor.encodeUtxo(next.height, next.vout, next.txid),
          };
        } else {
          utxoPage = {
            cursor: params.utxo_cursor != null ? params.utxo_cursor : null,
            limit: utxoLimit,
            has_more: false,
            next_cursor: null,
          };
        }
      }
    }

    return {
      address,
      status: state.status,
      balance: state.balance,
      mempool,
      history,
      utxos,
      page: pageInfo,
      utxo_page: utxoPage,
    };
  },

  "tx.broadcast": async (session, params) => {
    requireHello(session);
    requireSynced();
    if (!params || typeof params.rawtx !== "string" || params.rawtx.length === 0) {
      throw new MethodError(ERROR_CODES.INVALID_PARAMS, "rawtx required");
    }
    try {
      const txid = await callRPC("sendrawtransaction", [params.rawtx]);
      return { txid };
    } catch (e) {
      const msg = e && e.message ? e.message : "broadcast failed";
      throw new MethodError(ERROR_CODES.INTERNAL_ERROR, msg);
    }
  },

  ...depin.handlers,
};

module.exports = { handlers, MethodError, fetchAddressState };
