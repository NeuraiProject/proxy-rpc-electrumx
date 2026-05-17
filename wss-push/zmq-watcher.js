// Subscribes to the Neurai node's ZMQ publisher to receive block + tx events
// in near-real-time. Falls back silently if the `zeromq` optional dep is not
// installed — the poller picks up the slack in that case.
//
// Topics consumed:
//   hashblock   -> 32-byte block hash on each new block
//   rawtx       -> full raw transaction bytes on each new mempool tx
//   sequence    -> (optional) per-topic sequence numbers for gap detection
//
// Handlers expected: { onBlock(hash_hex), onRawTx(buffer), onSequenceGap? }

let zmq = null;
try {
  // eslint-disable-next-line global-require
  zmq = require("zeromq");
} catch (e) {
  // optional dep — handled at start() time
}

function isAvailable() {
  return zmq !== null;
}

async function start(config, handlers) {
  if (!zmq) {
    console.log("[ZMQ] zeromq package not installed (optional dep). Skipping ZMQ; polling fallback only.");
    return null;
  }
  if (!config.zmq_enabled) {
    console.log("[ZMQ] disabled in config (zmq_enabled=false). Skipping.");
    return null;
  }
  if (!config.zmq_endpoint) {
    console.log("[ZMQ] no zmq_endpoint configured. Skipping.");
    return null;
  }

  const sock = new zmq.Subscriber();
  try {
    sock.connect(config.zmq_endpoint);
    sock.subscribe("hashblock");
    sock.subscribe("rawtx");
    if (config.zmq_sequence_enabled) sock.subscribe("sequence");
    console.log(
      `[ZMQ] connected to ${config.zmq_endpoint}, topics: hashblock,rawtx${config.zmq_sequence_enabled ? ",sequence" : ""}`,
    );
  } catch (e) {
    console.log("[ZMQ] connect failed:", e && e.message ? e.message : e);
    return null;
  }

  // Per-topic sequence numbers. ZMQ delivers them as a 4-byte little-endian uint.
  const lastSeq = new Map();

  (async () => {
    try {
      for await (const frames of sock) {
        if (!Array.isArray(frames) || frames.length < 2) continue;
        const topic = frames[0].toString();
        const payload = frames[1];
        // Some publishers send a sequence as the trailing frame. When present,
        // check for gaps and let the caller decide if a resync is needed.
        if (frames.length >= 3 && handlers.onSequenceGap) {
          const seq = frames[2].readUInt32LE(0);
          const prev = lastSeq.get(topic);
          if (prev !== undefined && seq !== prev + 1) {
            handlers.onSequenceGap(topic, prev, seq);
          }
          lastSeq.set(topic, seq);
        }
        try {
          if (topic === "hashblock" && handlers.onBlock) {
            handlers.onBlock(payload.toString("hex"));
          } else if (topic === "rawtx" && handlers.onRawTx) {
            handlers.onRawTx(payload);
          }
        } catch (e) {
          console.log(`[ZMQ] handler error on ${topic}:`, e && e.message ? e.message : e);
        }
      }
    } catch (e) {
      console.log("[ZMQ] subscriber loop exited:", e && e.message ? e.message : e);
    }
  })();

  return sock;
}

module.exports = { start, isAvailable };
