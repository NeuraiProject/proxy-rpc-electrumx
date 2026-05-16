const crypto = require("crypto");

// Status hash per PLAN_WSS_PUSH.md section 4: fixed-order string, never JSON.stringify.
// Format:
//   balance.confirmed:<n>|balance.unconfirmed:<n>|mempool:<txid>,<txid>|utxos:<txid:vout:value:asset>,...
// Native XNA is represented with empty asset string.

function compareUtxo(a, b) {
  if (a.txid !== b.txid) return a.txid < b.txid ? -1 : 1;
  const av = Number(a.vout);
  const bv = Number(b.vout);
  if (av !== bv) return av - bv;
  const aa = a.asset || "";
  const ba = b.asset || "";
  if (aa !== ba) return aa < ba ? -1 : 1;
  return 0;
}

function statusString(state) {
  const balance = state && state.balance ? state.balance : {};
  const confirmed = balance.confirmed == null ? 0 : balance.confirmed;
  const unconfirmed = balance.unconfirmed == null ? 0 : balance.unconfirmed;

  const mempoolTxids = Array.isArray(state && state.mempoolTxids) ? state.mempoolTxids.slice() : [];
  mempoolTxids.sort();
  const mempoolStr = mempoolTxids.join(",");

  const utxos = Array.isArray(state && state.utxos) ? state.utxos.slice() : [];
  utxos.sort(compareUtxo);
  const utxosStr = utxos
    .map((u) => `${u.txid}:${u.vout}:${u.value}:${u.asset || ""}`)
    .join(",");

  return (
    `balance.confirmed:${confirmed}` +
    `|balance.unconfirmed:${unconfirmed}` +
    `|mempool:${mempoolStr}` +
    `|utxos:${utxosStr}`
  );
}

function statusHash(state) {
  return crypto.createHash("sha256").update(statusString(state)).digest("hex");
}

module.exports = { statusString, statusHash };
