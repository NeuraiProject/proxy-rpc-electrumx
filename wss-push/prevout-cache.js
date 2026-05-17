// Bounded outpoint -> address cache used by chain-events to resolve transaction
// inputs without falling back to getrawtransaction RPC for every spend.
//
// Map preserves insertion order, so re-inserting a key on access gives us a
// cheap LRU. Eviction is a single map.keys().next() lookup when over capacity.

function create({ maxSize = 100000 } = {}) {
  const map = new Map();

  function keyOf(txid, vout) {
    return `${txid}:${vout}`;
  }

  function set(txid, vout, address) {
    if (!txid || typeof vout !== "number" || !address) return;
    const k = keyOf(txid, vout);
    if (map.has(k)) map.delete(k);
    map.set(k, address);
    if (map.size > maxSize) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
  }

  function get(txid, vout) {
    if (!txid || typeof vout !== "number") return undefined;
    const k = keyOf(txid, vout);
    const v = map.get(k);
    if (v !== undefined) {
      // touch — move to most-recently-used position
      map.delete(k);
      map.set(k, v);
    }
    return v;
  }

  function size() {
    return map.size;
  }

  function clear() {
    map.clear();
  }

  return { set, get, size, clear };
}

module.exports = { create };
