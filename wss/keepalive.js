// WS-level ping/pong keepalive.
//
// Without this, mobile WS connections behind NAT die silently after ~30s of
// inactivity (the NAT entry expires, the TCP socket lingers half-open, the
// app thinks it's connected but never receives events). Periodic pings keep
// the path alive end-to-end and let the server detect dead peers.
//
// Flow per session:
//   every `interval_ms`  →  server.ws.ping()
//                           reset / set timeout for `timeout_ms`
//   ws.on("pong")        →  clear the pending timeout (peer alive)
//   timeout fires        →  ws.terminate() (peer didn't pong in time)
//   ws.on("close")       →  stop() — clear both timers
//
// Tunable via wss_push.keepalive_interval_ms / wss_push.keepalive_timeout_ms.

function start(ws, session, config) {
  const interval = config.keepalive_interval_ms || 25000;
  const timeout = config.keepalive_timeout_ms || 10000;

  session.keepalive = {
    last_ping_at: null,
    last_pong_at: null,
    timeouts: 0,
  };

  ws.on("pong", () => {
    session.keepalive.last_pong_at = Date.now();
    if (session._keepaliveTimeoutTimer) {
      clearTimeout(session._keepaliveTimeoutTimer);
      session._keepaliveTimeoutTimer = null;
    }
  });

  function tick() {
    if (!ws || ws.readyState !== 1) return;
    session.keepalive.last_ping_at = Date.now();
    try {
      ws.ping();
    } catch {
      // socket already dead — close handler will clean up
      return;
    }
    if (session._keepaliveTimeoutTimer) {
      clearTimeout(session._keepaliveTimeoutTimer);
    }
    session._keepaliveTimeoutTimer = setTimeout(() => {
      session._keepaliveTimeoutTimer = null;
      session.keepalive.timeouts += 1;
      console.log(
        `[WSS-PUSH] session ${session.id} keepalive timeout (no pong in ${timeout}ms), terminating`,
      );
      try {
        ws.terminate();
      } catch {
        // ignore
      }
    }, timeout);
  }

  session._keepaliveIntervalTimer = setInterval(tick, interval);
  if (session._keepaliveIntervalTimer.unref) {
    session._keepaliveIntervalTimer.unref();
  }
}

function stop(session) {
  if (session._keepaliveIntervalTimer) {
    clearInterval(session._keepaliveIntervalTimer);
    session._keepaliveIntervalTimer = null;
  }
  if (session._keepaliveTimeoutTimer) {
    clearTimeout(session._keepaliveTimeoutTimer);
    session._keepaliveTimeoutTimer = null;
  }
}

module.exports = { start, stop };
