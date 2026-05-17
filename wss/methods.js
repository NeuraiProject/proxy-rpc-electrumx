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

// Normalize the `assets` param into either:
//   { kind: "none" }   — native XNA only (default)
//   { kind: "all" }    — include every asset the address has
//   { kind: "list", names: Set<string> } — include only these asset names
// Throws MethodError(1003) for invalid input.
function parseAssetsFilter(value) {
  if (value == null || value === false) return { kind: "none" };
  if (value === true) return { kind: "all" };
  if (Array.isArray(value)) {
    const names = new Set();
    for (const n of value) {
      if (typeof n !== "string" || n.length === 0) {
        throw new MethodError(
          ERROR_CODES.INVALID_PARAMS,
          "assets array must contain non-empty asset name strings",
        );
      }
      names.add(n);
    }
    return { kind: "list", names };
  }
  throw new MethodError(
    ERROR_CODES.INVALID_PARAMS,
    "assets must be true, false, or an array of asset names",
  );
}

// Apply an asset filter to the full `state.assets` map fetched by
// fetchAddressState. Returns the subset to include in the response.
function projectAssets(assetsFromState, filter) {
  if (filter.kind === "none") return null;
  if (filter.kind === "all") return assetsFromState;
  const out = {};
  for (const name of filter.names) {
    if (assetsFromState[name]) out[name] = assetsFromState[name];
    else out[name] = { confirmed: 0, unconfirmed: 0 };
  }
  return out;
}

function projectAssetUtxos(assetUtxos, filter) {
  if (filter.kind === "none") return [];
  if (filter.kind === "all") return assetUtxos;
  return assetUtxos.filter((u) => filter.names.has(u.assetName));
}

// Native asset name as Neurai's RPC reports it.
const NATIVE_ASSET = "XNA";

async function fetchAddressState(address) {
  // Always fetch native + all assets in parallel. The asset data feeds into
  // the status hash so any asset change (not just native) will trigger an
  // address.changed event downstream. Handlers may still filter what they
  // return to the client based on the `assets` param.
  const [balanceRaw, mempoolRaw, nativeUtxosRaw, assetUtxosRaw] = await Promise.all([
    callRPC("getaddressbalance", [{ addresses: [address] }, true]).catch(() => null),
    callRPC("getaddressmempool", [{ addresses: [address] }]).catch(() => []),
    callRPC("getaddressutxos", [{ addresses: [address] }]).catch(() => []),
    callRPC("getaddressutxos", [{ addresses: [address], assetName: "*" }]).catch(() => []),
  ]);

  // Native balance + per-asset balances. getaddressbalance with includeAssets
  // returns an array of {assetName, balance, received}; XNA is the native.
  let confirmedNative = 0;
  const assets = {};
  if (Array.isArray(balanceRaw)) {
    for (const b of balanceRaw) {
      if (!b || typeof b.balance !== "number") continue;
      if (b.assetName === NATIVE_ASSET) {
        confirmedNative = b.balance;
      } else {
        assets[b.assetName] = { confirmed: b.balance, unconfirmed: 0 };
      }
    }
  }

  // Native mempool — note: getaddressmempool returns native by default. Asset
  // mempool entries would need a separate query with assetName; for now we
  // capture native only. Asset mempool will be covered in a follow-up.
  const mempool = Array.isArray(mempoolRaw) ? mempoolRaw : [];
  let unconfirmedNative = 0;
  for (const m of mempool) {
    if (typeof m.satoshis === "number") unconfirmedNative += m.satoshis;
  }

  const utxos = Array.isArray(nativeUtxosRaw) ? nativeUtxosRaw : [];
  const utxosForHash = utxos.map((u) => ({
    txid: u.txid,
    vout: u.outputIndex,
    value: u.satoshis,
    asset: u.assetName || "",
  }));

  const assetUtxosRawArr = Array.isArray(assetUtxosRaw) ? assetUtxosRaw : [];
  const assetUtxosForHash = assetUtxosRawArr.map((u) => ({
    txid: u.txid,
    vout: u.outputIndex,
    value: u.satoshis,
    asset: u.assetName || "",
  }));

  const mempoolTxids = mempool.map((m) => m.txid);

  const balance = { confirmed: confirmedNative, unconfirmed: unconfirmedNative };

  return {
    balance,
    assets,
    mempool,
    mempoolTxids,
    utxos,
    utxosForHash,
    assetUtxos: assetUtxosRawArr,
    assetUtxosForHash,
    status: statusHash({
      balance,
      mempoolTxids,
      utxos: utxosForHash,
      assets,
      assetUtxos: assetUtxosForHash,
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
      server: "neurai-wallet-services",
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
    const assetsFilter = parseAssetsFilter(params.assets);

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

    const response = {
      address,
      status: state.status,
      balance: state.balance,
      height,
    };
    const projectedAssets = projectAssets(state.assets || {}, assetsFilter);
    if (projectedAssets !== null) response.assets = projectedAssets;
    return response;
  },

  "address.unsubscribe": async (session, params) => {
    requireHello(session);
    if (!params || typeof params.address !== "string") {
      throw new MethodError(ERROR_CODES.INVALID_PARAMS, "address required");
    }
    subscriptions.unsubscribe(params.address, session);
    return true;
  },

  // Bulk variants for HD wallets that derive many addresses up front.
  // Errors are reported per-address in the response so one bad entry doesn't
  // poison the batch. The whole call is gated by requireSynced like the
  // single-address variant.
  "address.subscribe.bulk": async (session, params, ctx) => {
    requireHello(session);
    requireSynced();
    if (!params || !Array.isArray(params.addresses)) {
      throw new MethodError(
        ERROR_CODES.INVALID_PARAMS,
        "addresses array required",
      );
    }
    const addresses = params.addresses;
    if (addresses.length === 0) {
      return { results: [] };
    }
    const MAX_BATCH = ctx.config.bulk_subscribe_limit || 200;
    if (addresses.length > MAX_BATCH) {
      throw new MethodError(
        ERROR_CODES.INVALID_PARAMS,
        `batch too large (got ${addresses.length}, max ${MAX_BATCH})`,
      );
    }
    if (session.subs.size + addresses.length > ctx.config.max_subscriptions_per_session) {
      throw new MethodError(
        ERROR_CODES.TOO_MANY_SUBS,
        "batch would exceed max subscriptions per session",
      );
    }

    // One asset filter applies to the whole batch — HD wallets fetch the same
    // way for every derived address.
    const assetsFilter = parseAssetsFilter(params.assets);

    // Fetch the chain tip once for the whole batch instead of per-address.
    let height = null;
    if (ctx.config.send_initial_state) {
      try {
        const h = await callRPC("getblockcount", []);
        if (typeof h === "number") height = h;
      } catch {
        // best-effort
      }
    }

    const results = await Promise.all(
      addresses.map(async (address) => {
        if (typeof address !== "string" || address.length === 0) {
          return {
            address: typeof address === "string" ? address : null,
            error: { code: ERROR_CODES.INVALID_PARAMS, message: "invalid address" },
          };
        }
        try {
          const val = await callRPC("validateaddress", [address]).catch(() => null);
          if (!val || val.isvalid !== true) {
            return {
              address,
              error: { code: ERROR_CODES.INVALID_PARAMS, message: "invalid address" },
            };
          }
          subscriptions.subscribe(address, session);
          if (!ctx.config.send_initial_state) {
            return { address };
          }
          const state = await fetchAddressState(address);
          chainState.setLastStatus(address, state.status);
          const entry = {
            address,
            status: state.status,
            balance: state.balance,
            height,
          };
          const projectedAssets = projectAssets(state.assets || {}, assetsFilter);
          if (projectedAssets !== null) entry.assets = projectedAssets;
          return entry;
        } catch (e) {
          return {
            address,
            error: {
              code: ERROR_CODES.INTERNAL_ERROR,
              message: e && e.message ? e.message : "subscribe failed",
            },
          };
        }
      }),
    );

    return { results };
  },

  "address.unsubscribe.bulk": async (session, params) => {
    requireHello(session);
    if (!params || !Array.isArray(params.addresses)) {
      throw new MethodError(
        ERROR_CODES.INVALID_PARAMS,
        "addresses array required",
      );
    }
    let count = 0;
    for (const address of params.addresses) {
      if (typeof address === "string" && address.length > 0) {
        subscriptions.unsubscribe(address, session);
        count++;
      }
    }
    return { count };
  },

  "address.get_state": async (session, params, ctx) => {
    requireHello(session);
    requireSynced();
    if (!params || typeof params.address !== "string" || params.address.length === 0) {
      throw new MethodError(ERROR_CODES.INVALID_PARAMS, "address required");
    }
    const address = params.address;

    // Asset filter: accepts the same shapes as address.subscribe.
    //   undefined/null/false → native only (default)
    //   true → all assets the address has
    //   string[] → only these asset names (native always included)
    // `asset` is kept as a legacy alias for `assets`.
    const assetsFilter = parseAssetsFilter(
      params.assets !== undefined ? params.assets : params.asset,
    );

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
        cursorParsed = { height: Math.floor(params.from_height), tx_index: 0, asset: "" };
      } else {
        cursorParsed = { height: 0, tx_index: 0, asset: "" };
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

      // When the caller asked for any asset data (kind != "none"), use the
      // wildcard call — it returns native XNA deltas AND non-native asset
      // deltas in one shot. Otherwise stick to the cheaper native-only call.
      const rpcParams =
        assetsFilter.kind === "none"
          ? { addresses: [address], start, end }
          : { addresses: [address], start, end, assetName: "*" };
      let deltas = [];
      try {
        deltas = await callRPC("getaddressdeltas", [rpcParams]);
        if (!Array.isArray(deltas)) deltas = [];
      } catch (e) {
        console.log(
          "[methods] getaddressdeltas failed:",
          e && e.message ? e.message : e,
        );
        deltas = [];
      }

      // For list-mode, keep XNA + only the whitelisted asset names.
      if (assetsFilter.kind === "list") {
        deltas = deltas.filter((d) => {
          const name = d.assetName || NATIVE_ASSET;
          return name === NATIVE_ASSET || assetsFilter.names.has(name);
        });
      }

      // Aggregate per (height, blockindex, txid, asset). One row per asset
      // within a tx so a swap (XNA out + FOO in) produces two history entries.
      const agg = new Map();
      for (const d of deltas) {
        if (typeof d.height !== "number" || typeof d.blockindex !== "number") continue;
        const asset = d.assetName || NATIVE_ASSET;
        const key = `${d.height}:${d.blockindex}:${d.txid}:${asset}`;
        const e = agg.get(key) || {
          height: d.height,
          tx_index: d.blockindex,
          txid: d.txid,
          asset,
          satoshis: 0,
        };
        e.satoshis += typeof d.satoshis === "number" ? d.satoshis : 0;
        agg.set(key, e);
      }
      let sorted = [...agg.values()].sort(
        (a, b) =>
          a.height - b.height ||
          a.tx_index - b.tx_index ||
          (a.asset < b.asset ? -1 : a.asset > b.asset ? 1 : 0),
      );

      // Skip everything strictly before the cursor.
      sorted = sorted.filter((e) => {
        if (e.height > cursorParsed.height) return true;
        if (e.height < cursorParsed.height) return false;
        if (e.tx_index > cursorParsed.tx_index) return true;
        if (e.tx_index < cursorParsed.tx_index) return false;
        return e.asset >= cursorParsed.asset;
      });

      history = sorted.slice(0, limit);
      if (sorted.length > limit) {
        const next = sorted[limit];
        pageInfo.has_more = true;
        pageInfo.next_cursor = cursor.encode(next.height, next.tx_index, next.asset);
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

    const projectedAssets = projectAssets(state.assets || {}, assetsFilter);
    const projectedAssetUtxos = includeUtxos
      ? projectAssetUtxos(state.assetUtxos || [], assetsFilter).map((u) => ({
          txid: u.txid,
          vout: u.outputIndex,
          satoshis: u.satoshis,
          height: u.height,
          asset: u.assetName || "",
        }))
      : [];

    const response = {
      address,
      status: state.status,
      balance: state.balance,
      mempool,
      history,
      utxos,
      page: pageInfo,
      utxo_page: utxoPage,
    };
    if (projectedAssets !== null) {
      response.assets = projectedAssets;
      response.asset_utxos = projectedAssetUtxos;
    }
    return response;
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
