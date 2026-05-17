const { getDePinNode } = require("../getRPCNode");
const depinService = require("../depinService");
const { ERROR_CODES } = require("./protocol");
const { MethodError, requireHello, requireSynced } = require("./common");
const { callRPC } = require("./rpc");

// Read-only DePIN methods. These are normal Neurai RPC calls (no signature
// required) that happen to query DePIN-related state. Exposed under depin.*
// for grouping. They go through the standard Neurai RPC via callRPC, NOT
// through the DePIN messaging service.
const READ_ONLY_METHODS = {
  "depin.check_validity": "checkdepinvalidity",
  "depin.list_holders": "listdepinholders",
  "depin.list_addresses": "listdepinaddresses",
  "depin.get_pubkey": "getpubkey",
  "depin.pool_stats": "depinpoolstats",
  "depin.pool_pkey": "depinpoolpkey",
  "depin.pool_content": "depingetpoolcontent",
  "depin.mcp_status": "depinmcpstatus",
  "depin.msg_info": "depingetmsginfo",
};

// Signed DePIN methods. These go to the DePIN messaging service (a separate
// daemon listening on depinUrl, e.g. http://localhost:19002). They require a
// signature over a challenge the DePIN node issues per address. The flow:
//   1. Client calls depin.challenge(address) → returns the challenge string.
//   2. Client signs the challenge with the address's private key.
//   3. Client calls depin.<method>({address, signature, args}).
// The proxy holds an in-memory cache of challenges per (depinUrl, address) so
// step 1 is idempotent for the lifetime of the challenge.
const SIGNED_METHODS = {
  "depin.send_msg": "depinsendmsg",
  "depin.get_msg": "depingetmsg",
  "depin.receive_msg": "depinreceivemsg",
  "depin.submit_msg": "depinsubmitmsg",
  "depin.clear_msg": "depinclearmsg",
};

function coerceArgs(params) {
  if (Array.isArray(params)) return params;
  if (params && Array.isArray(params.args)) return params.args;
  return [];
}

function requireDepinNode() {
  const node = getDePinNode();
  if (!node || !node.depinUrl) {
    throw new MethodError(
      ERROR_CODES.INTERNAL_ERROR,
      "no DePIN node configured (set depin_enabled=true on a node in config)",
    );
  }
  return node;
}

function maybeInjectNodeIp(rpcMethod, args, depinUrl) {
  // The DePIN messaging RPCs depinsendmsg / depingetmsg take an ip:port at
  // position [1]. When the client sends an empty string or the placeholder
  // "auto", substitute the host:port of the configured DePIN node.
  if (rpcMethod !== "depinsendmsg" && rpcMethod !== "depingetmsg") return args;
  if (!Array.isArray(args) || args.length < 2) return args;
  const ipParam = args[1];
  if (ipParam && ipParam !== "" && ipParam !== "auto") return args;
  const m = depinUrl.match(/^https?:\/\/([^/]+)/);
  const replacement = m ? m[1] : "localhost:19002";
  const copy = args.slice();
  copy[1] = replacement;
  return copy;
}

const handlers = {};

for (const [wssMethod, rpcMethod] of Object.entries(READ_ONLY_METHODS)) {
  handlers[wssMethod] = async (session, params) => {
    requireHello(session);
    // Read-only DePIN methods query Neurai chain state via RPC. Refuse while
    // the node is syncing so we don't return data based on a partial chain.
    // Signed DePIN methods below go to the independent DePIN messaging
    // service and are NOT gated.
    requireSynced();
    const args = coerceArgs(params);
    try {
      return await callRPC(rpcMethod, args);
    } catch (e) {
      const msg = e && e.message ? e.message : `${rpcMethod} failed`;
      // Match the original /rpc behavior: checkdepinvalidity on non-DePIN assets
      // ("must start with &") returns a structured "not a DePIN asset" object
      // instead of erroring out — useful for wallets querying arbitrary assets.
      if (rpcMethod === "checkdepinvalidity" && msg.includes("must start with &")) {
        return {
          valid: false,
          isDePinAsset: false,
          message: "Not a DePIN asset (assets must start with & to be DePIN assets)",
        };
      }
      throw new MethodError(ERROR_CODES.INTERNAL_ERROR, msg);
    }
  };
}

handlers["depin.challenge"] = async (session, params) => {
  requireHello(session);
  if (!params || typeof params.address !== "string" || params.address.length === 0) {
    throw new MethodError(ERROR_CODES.INVALID_PARAMS, "address required");
  }
  const node = requireDepinNode();
  try {
    const { challenge, timeout, expiresAt } = await depinService.requestChallenge(
      node.depinUrl,
      params.address,
    );
    return {
      challenge,
      timeout,
      expires_at: new Date(expiresAt).toISOString(),
    };
  } catch (e) {
    throw new MethodError(
      ERROR_CODES.INTERNAL_ERROR,
      e && e.message ? e.message : "challenge request failed",
    );
  }
};

for (const [wssMethod, rpcMethod] of Object.entries(SIGNED_METHODS)) {
  handlers[wssMethod] = async (session, params) => {
    requireHello(session);
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new MethodError(
        ERROR_CODES.INVALID_PARAMS,
        "params must be an object with {address, signature, args}",
      );
    }
    if (typeof params.address !== "string" || params.address.length === 0) {
      throw new MethodError(ERROR_CODES.INVALID_PARAMS, "address required");
    }
    if (typeof params.signature !== "string" || params.signature.length === 0) {
      throw new MethodError(ERROR_CODES.INVALID_PARAMS, "signature required");
    }
    const node = requireDepinNode();
    const args = maybeInjectNodeIp(rpcMethod, coerceArgs(params), node.depinUrl);
    const signMessage = async () => params.signature;
    try {
      return await depinService.executeDePinRPC(
        node.depinUrl,
        params.address,
        signMessage,
        rpcMethod,
        args,
      );
    } catch (e) {
      throw new MethodError(
        ERROR_CODES.INTERNAL_ERROR,
        e && e.message ? e.message : `${rpcMethod} failed`,
      );
    }
  };
}

module.exports = { handlers, READ_ONLY_METHODS, SIGNED_METHODS };
