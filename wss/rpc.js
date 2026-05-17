const { default: PQueue } = require("p-queue");
const { getRPCNode } = require("../getRPCNode");

let pushQueue = null;

function initQueue(concurrency) {
  if (pushQueue) return pushQueue;
  pushQueue = new PQueue({ concurrency: concurrency || 4 });
  return pushQueue;
}

function callRPC(method, params) {
  if (!pushQueue) initQueue(4);
  return pushQueue.add(async () => {
    const node = getRPCNode();
    return node.rpc(method, params == null ? [] : params);
  });
}

function getQueueStats() {
  if (!pushQueue) return { size: 0, pending: 0 };
  return { size: pushQueue.size, pending: pushQueue.pending };
}

module.exports = { initQueue, callRPC, getQueueStats };
