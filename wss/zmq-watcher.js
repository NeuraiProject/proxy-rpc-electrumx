// Resilient ZMQ subscriber to the Neurai node's publisher.
//
// ZMQ's connect() is non-blocking and lazy — the library itself will retry
// the underlying TCP connection in the background. But that's not enough for
// us in practice:
//
//   - If the iterator throws (rare but possible on socket teardown), we'd
//     stop receiving events forever without an outer reconnect loop.
//   - If the publisher (neuraid) restarts, ZMQ pub/sub does NOT replay
//     buffered messages. There's a small window between sub re-establishment
//     and the next published message where we could miss events. The poller
//     fallback handles tip catch-up, but a fresh subscription is healthier.
//   - If the network silently fails (idle TCP, NAT teardown), no error
//     fires — the iterator just hangs forever. A watchdog detects this.
//
// Architecture:
//   loop forever:
//     create subscriber, subscribe topics, run for-await-of iterator
//     on iterator exit (clean or error): close socket, wait with backoff,
//                                        try again
//
// Backoff: 1s, 2s, 4s, ..., capped at 30s. Resets whenever we stay
// connected >30s without failures (proxy: a healthy run).
//
// Watchdog: if no message arrives for `zmq_watchdog_ms` (default 5 min),
// recycle the socket. Polling fallback covers any events missed in the
// gap — this is purely about re-establishing a fresh subscription in
// case ZMQ's own connection healing didn't recover.

let zmq = null;
try {
  // eslint-disable-next-line global-require
  zmq = require("zeromq");
} catch (e) {
  // optional dep — handled at start() time
}

const state = {
  connected: false,
  attempts: 0,
  last_message_at: null,
  last_connected_at: null,
  last_disconnected_at: null,
};

function isAvailable() {
  return zmq !== null;
}

function getStatus() {
  return { ...state };
}

async function loopOnce(config, handlers) {
  const sock = new zmq.Subscriber();
  const watchdogMs = config.zmq_watchdog_ms || 5 * 60 * 1000;
  const watchdogTickMs = Math.min(Math.floor(watchdogMs / 4), 30000);
  let lastMessageAt = Date.now();
  state.last_message_at = lastMessageAt;
  const lastSeq = new Map();

  // Watchdog: closes the socket if no message arrives for too long. The
  // for-await loop exits when the socket closes and the outer reconnect
  // loop spins up a new socket.
  const watchdogTimer = setInterval(() => {
    const idle = Date.now() - lastMessageAt;
    if (idle > watchdogMs) {
      console.log(
        `[ZMQ] watchdog: no message in ${idle}ms (>${watchdogMs}ms), recycling socket`,
      );
      try { sock.close(); } catch {}
    }
  }, watchdogTickMs);
  if (watchdogTimer.unref) watchdogTimer.unref();

  try {
    sock.connect(config.zmq_endpoint);
    sock.subscribe("hashblock");
    sock.subscribe("rawtx");
    if (config.zmq_sequence_enabled) sock.subscribe("sequence");

    state.connected = true;
    state.last_connected_at = Date.now();
    console.log(
      `[ZMQ] connected to ${config.zmq_endpoint}, topics: hashblock,rawtx${config.zmq_sequence_enabled ? ",sequence" : ""}`,
    );

    for await (const frames of sock) {
      lastMessageAt = Date.now();
      state.last_message_at = lastMessageAt;

      if (!Array.isArray(frames) || frames.length < 2) continue;
      const topic = frames[0].toString();
      const payload = frames[1];

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
  } finally {
    clearInterval(watchdogTimer);
    state.connected = false;
    state.last_disconnected_at = Date.now();
    try { sock.close(); } catch {}
  }
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

  const maxBackoff = 30000;
  let backoff = 1000;

  (async () => {
    while (true) {
      const startedAt = Date.now();
      state.attempts += 1;
      try {
        await loopOnce(config, handlers);
        console.log("[ZMQ] subscriber loop exited cleanly");
      } catch (e) {
        console.log(`[ZMQ] subscriber error: ${e && e.message ? e.message : e}`);
      }
      // If we stayed connected long enough to be considered healthy, reset
      // the backoff so the next failure doesn't penalize us with a long wait.
      const elapsed = Date.now() - startedAt;
      if (elapsed > 30000) backoff = 1000;

      console.log(`[ZMQ] reconnecting in ${backoff}ms (attempt #${state.attempts + 1})`);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, backoff));
      backoff = Math.min(backoff * 2, maxBackoff);
    }
  })().catch((e) => {
    console.log(`[ZMQ] reconnect loop crashed: ${e && e.message ? e.message : e}`);
  });

  return true;
}

module.exports = { start, isAvailable, getStatus };
