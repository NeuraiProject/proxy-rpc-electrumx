const protocol = require("./protocol");
const { ERROR_CODES } = protocol;
const { callRPC } = require("./rpc");
const subscriptions = require("./subscriptions");
const { statusHash } = require("./status");
const { MethodError, requireHello, requireSynced } = require("./common");
const chainState = require("./chain-state");
const nodeHealth = require("./node-health");
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
