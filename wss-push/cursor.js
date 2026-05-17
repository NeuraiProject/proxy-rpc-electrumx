// Opaque pagination cursor for address.get_state history.
//
// Internal format: "height:tx_index:asset". The client treats this as opaque
// and only echoes back what the server returned via `next_cursor`.
//
// The composite (height, tx_index, asset) is what makes pagination stable when
// a page boundary falls inside a block or inside a tx that touches multiple
// assets: (height, tx_index) alone would skip remaining asset rows of that tx
// or revisit ones already returned.
//
// Legacy "height:tx_index" cursors from pre-asset-history clients are still
// accepted (asset defaults to "" — which sorts before any real asset name, so
// the next page resumes at the start of that tx slot).

function encode(height, txIndex, asset) {
  if (
    typeof height !== "number" ||
    typeof txIndex !== "number" ||
    typeof asset !== "string" ||
    !Number.isFinite(height) ||
    !Number.isFinite(txIndex) ||
    height < 0 ||
    txIndex < 0 ||
    asset.length === 0 ||
    asset.includes(":")
  ) {
    return null;
  }
  return `${Math.floor(height)}:${Math.floor(txIndex)}:${asset}`;
}

function decode(cursor) {
  if (cursor === null || cursor === undefined || cursor === "") {
    return { height: 0, tx_index: 0, asset: "" };
  }
  if (typeof cursor !== "string") return null;
  const newFmt = cursor.match(/^(\d+):(\d+):([^:]+)$/);
  if (newFmt) {
    return {
      height: Number(newFmt[1]),
      tx_index: Number(newFmt[2]),
      asset: newFmt[3],
    };
  }
  const legacy = cursor.match(/^(\d+):(\d+)$/);
  if (legacy) {
    return {
      height: Number(legacy[1]),
      tx_index: Number(legacy[2]),
      asset: "",
    };
  }
  return null;
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
