// In-memory state shared between the watchers (ZMQ + poller) and chain-events.
// Holds three things:
//   - tip: the latest block we know about ({height, hash})
//   - blockIndex: a bounded Map<height, hash> of recent blocks, used to detect
//     reorgs deterministically by comparing a new block's previousblockhash
//     against what we have on file for the previous height.
//   - addressStatus: last status hash emitted per subscribed address, used to
//     suppress duplicate address.changed events when nothing actually changed.

let tip = { height: null, hash: null };
const blockIndex = new Map();
let maxHeight = null;
let maxBlockIndexSize = 120;

const addressStatus = new Map();

function configure(opts) {
  if (opts && typeof opts.maxBlockIndexSize === "number" && opts.maxBlockIndexSize > 0) {
    maxBlockIndexSize = opts.maxBlockIndexSize;
  }
}

function getTip() {
  return tip;
}

function setTip(height, hash) {
  tip = { height, hash };
}

function recordBlock(height, hash) {
  if (typeof height !== "number" || !hash) return;
  blockIndex.set(height, hash);
  if (maxHeight === null || height > maxHeight) maxHeight = height;
  // Evict anything below the keep-window (maxHeight - size + 1).
  const minKeep = maxHeight - maxBlockIndexSize + 1;
  if (blockIndex.size > maxBlockIndexSize) {
    for (const h of [...blockIndex.keys()]) {
      if (h < minKeep) blockIndex.delete(h);
    }
  }
}

function getBlockAt(height) {
  return blockIndex.get(height);
}

function getBlockIndexSize() {
  return blockIndex.size;
}

function getLastStatus(address) {
  return addressStatus.get(address);
}

function setLastStatus(address, status) {
  addressStatus.set(address, status);
}

function clearLastStatus(address) {
  addressStatus.delete(address);
}

function getStats() {
  return {
    tip,
    tracked_addresses: addressStatus.size,
    block_index: {
      size: blockIndex.size,
      capacity: maxBlockIndexSize,
      max_height: maxHeight,
    },
  };
}

module.exports = {
  configure,
  getTip,
  setTip,
  recordBlock,
  getBlockAt,
  getBlockIndexSize,
  getLastStatus,
  setLastStatus,
  clearLastStatus,
  getStats,
};
