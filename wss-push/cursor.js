// Opaque pagination cursor for address.get_state history.
//
// Internal format: "height:tx_index". The client treats this as opaque and
// only echoes back what the server returned via `next_cursor`.
//
// The composite (height, tx_index) is what makes pagination stable when a
// page boundary falls inside a block: a `from_height` alone would either
// skip remaining txs at that height or revisit ones already returned.

function encode(height, txIndex) {
  if (
    typeof height !== "number" ||
    typeof txIndex !== "number" ||
    !Number.isFinite(height) ||
    !Number.isFinite(txIndex) ||
    height < 0 ||
    txIndex < 0
  ) {
    return null;
  }
  return `${Math.floor(height)}:${Math.floor(txIndex)}`;
}

function decode(cursor) {
  if (cursor === null || cursor === undefined || cursor === "") {
    return { height: 0, tx_index: 0 };
  }
  if (typeof cursor !== "string") return null;
  const m = cursor.match(/^(\d+):(\d+)$/);
  if (!m) return null;
  return {
    height: Number(m[1]),
    tx_index: Number(m[2]),
  };
}

// UTXO pagination cursor. Format: "height:vout:txid" with txid as the
// trailing hex string so the regex parses unambiguously. UTXOs are sorted by
// (height, txid, vout) for deterministic order; the cursor identifies the
// next entry to return.

function encodeUtxo(height, vout, txid) {
  if (
    typeof height !== "number" ||
    typeof vout !== "number" ||
    typeof txid !== "string" ||
    !Number.isFinite(height) ||
    !Number.isFinite(vout) ||
    height < 0 ||
    vout < 0 ||
    !/^[a-f0-9]+$/i.test(txid)
  ) {
    return null;
  }
  return `${Math.floor(height)}:${Math.floor(vout)}:${txid}`;
}

function decodeUtxo(cursor) {
  if (cursor === null || cursor === undefined || cursor === "") return null;
  if (typeof cursor !== "string") return null;
  const m = cursor.match(/^(\d+):(\d+):([a-f0-9]+)$/i);
  if (!m) return null;
  return {
    height: Number(m[1]),
    vout: Number(m[2]),
    txid: m[3],
  };
}

module.exports = { encode, decode, encodeUtxo, decodeUtxo };
