# neurai-wss-push

WSS push server for Neurai mobile wallets. Holds a persistent WebSocket per
client, lets it subscribe to addresses, and pushes events when balances,
mempool state, the chain tip or the node's sync state change — so the wallet
never polls. Also exposes the Neurai DePIN messaging RPCs over the same
connection.

This is **not** a generic Electrum/ElectrumX-compatible server. The wire
protocol is custom and small, intended to be paired with one mobile wallet
that speaks the same protocol.

## What's in here

- A WSS endpoint at `/push` that speaks a JSON-RPC-like protocol over WebSocket.
- Auth in the HTTP upgrade via `Sec-WebSocket-Protocol: wss-push, auth.<token>`.
- Built-in rate limiting (`503 Retry-After`) and session/subscription caps.
- ZMQ subscriber to the Neurai node (`hashblock` + `rawtx`) with polling
  fallback. Real-time `address.changed` / `chain.tip` / `chain.reorg` events.
- Deterministic reorg detection backed by an in-memory `Map<height, hash>`
  of the last 120 blocks, pre-populated at startup from the chain.
- Node-health monitoring: a 10s poll of `getblockchaininfo` gates methods
  that depend on a synced chain and emits `node.synced` / `node.syncing`
  on transitions.
- DePIN method handlers — both read-only RPCs and the signed messaging flow.
- Docker setup for testnet + an E2E test client.

## Status

**Phases 1 + 2 implemented and verified against a live testnet node**:

- `hello`, `ping`
- `address.subscribe`, `address.unsubscribe` (with initial state)
- `tx.broadcast`
- `depin.*` — read-only and signed methods (with challenge cache)
- Push events: `chain.tip`, `chain.reorg`, `address.changed`,
  `node.synced`, `node.syncing`
- ZMQ subscriber (`zeromq` optional dep) + polling fallback
- Sync gating: methods that need a synced chain return `1008` with progress
- Auth, rate limit, session limits, cert hot-reload, block-index warmup

Pending: paginated `address.get_state`, assets (`assets: true | string[]`
filter on subscribe), WS-frame keepalive, per-block "candidate addresses"
refresh optimization.

## Protocol overview

Wire-level subprotocol identifier: `wss-push`.
Application-level version (reported in `hello`): `wss-push/1`.

### Handshake

```json
// client → server (over WSS, after a 101 upgrade)
{ "id": 1, "method": "hello",
  "params": { "client": "my-wallet", "version": "0.1.0",
              "network": "mainnet", "protocol": "wss-push/1" } }

// server → client
{ "id": 1, "result": {
    "server": "neurai-rpc-proxy-wss",
    "protocol": "wss-push/1",
    "protocol_min": "wss-push/1",
    "protocol_max": "wss-push/1",
    "network": "mainnet",
    "tip_height": 75880,
    "tip_hash": "000048f1998e6f45...",
    "syncing": false,
    "verification_progress": 1.0,
    "blocks": 75880,
    "headers": 75880
  } }
```

`syncing` and friends let the wallet show a progress UI before subscribing.

### Methods

| Method | Params | Returns | Gated while syncing |
|---|---|---|---|
| `hello` | `{client, version, network, protocol}` | server info + tip + sync state | no |
| `ping` | none | `"pong"` | no |
| `address.subscribe` | `{address}` | `{address, status, balance, height}` | **yes** |
| `address.unsubscribe` | `{address}` | `true` | no |
| `tx.broadcast` | `{rawtx}` | `{txid}` | **yes** |
| `depin.check_validity` | `[asset]` or `{args:[asset]}` | RPC result | **yes** |
| `depin.list_holders` | `[asset]` | RPC result | **yes** |
| `depin.list_addresses` | `[asset]` | RPC result | **yes** |
| `depin.get_pubkey` | `[address]` | RPC result | **yes** |
| `depin.pool_stats` | none | RPC result | **yes** |
| `depin.pool_pkey` | none | RPC result | **yes** |
| `depin.pool_content` | none | RPC result | **yes** |
| `depin.mcp_status` | none | RPC result | **yes** |
| `depin.msg_info` | `[token]` | RPC result | **yes** |
| `depin.challenge` | `{address}` | `{challenge, timeout, expires_at}` | no |
| `depin.send_msg` | `{address, signature, args:[...]}` | RPC result | no |
| `depin.get_msg` | `{address, signature, args:[...]}` | RPC result | no |
| `depin.receive_msg` | `{address, signature, args:[...]}` | RPC result | no |
| `depin.submit_msg` | `{address, signature, args:[...]}` | RPC result | no |
| `depin.clear_msg` | `{address, signature, args:[...]}` | RPC result | no |

DePIN signed methods talk to the independent DePIN messaging daemon and
are therefore not affected by Neurai chain sync state.

### Server-to-client events

Pushed without prior request once `hello` is done. The wallet must be
event-driven — events can interleave with normal request/response.

| Event | Payload | When |
|---|---|---|
| `chain.tip` | `{height, hash}` | New best block. Fired before any `address.changed` for the same block. |
| `chain.reorg` | `{from_height, old_tip, new_tip, new_height, invalidate_depth}` | A block at height ≤ current tip got replaced. The wallet should invalidate cache from `from_height`. |
| `address.changed` | `{address, status, reason, height, balance, delta}` | A subscribed address's state changed. `reason ∈ {"block","mempool","resync","manual"}`. `delta = {added_txids, confirmed_txids, removed_txids, touched_assets}`. |
| `node.synced` | `{height, verification_progress}` | The Neurai node finished syncing. Wallets that were waiting can now subscribe. |
| `node.syncing` | `{blocks, headers, verification_progress}` | The node fell out of sync (uncommon — deep reorg, RPC unreachable). |

#### `address.changed` example

```json
{ "method": "address.changed",
  "params": {
    "address": "tnq1p9tdg76plsuss5lguphhm76t0faf2hy8vmefrq39ctsk0t5fqygzsz2dm40",
    "status": "d9385809c15265e9...",
    "reason": "block",
    "height": 75841,
    "balance": { "confirmed": 500000000000, "unconfirmed": 0 },
    "delta": {
      "added_txids": ["471e4da0ee1ded98ec8e6c20840763dcae7fd8151fab95f9d05c33c9c69bd5dd"],
      "confirmed_txids": [],
      "removed_txids": [],
      "touched_assets": []
    } } }
```

### Sync gating

If the Neurai node isn't fully synced, methods that need a coherent chain
view return a structured `1008` error:

```json
{ "id": 2, "error": {
    "code": 1008,
    "message": "node syncing, retry when synced",
    "retry_after_seconds": 30,
    "verification_progress": 0.4231,
    "blocks": 32000,
    "headers": 75800
  } }
```

The wallet can display a real progress bar and retry every `retry_after_seconds`.
When the node finishes syncing, the server pushes `node.synced` to all
connected sessions — no need to keep polling.

### DePIN signed flow

```text
client → depin.challenge({address})       → {challenge: "ab12cd…", timeout: 60}
client signs the challenge with the address private key
client → depin.send_msg({address, signature, args: [token, "auto", message, fromAddress]})
        → result from the DePIN node
```

`"auto"` in the ip:port slot is auto-substituted with the configured DePIN
node's host:port, matching the legacy `/depin` behavior.

## Running locally (docker, testnet)

The docker stack runs a Neurai testnet node, the wss-push server, and an
E2E test client.

```bash
# Build and start
docker compose -f docker/docker-compose.yml up -d --build

# Run the Phase 1 + 2 acceptance suite
docker compose -f docker/docker-compose.yml --profile test run --rm wss-test
```

Defaults:

- WSS push listens on `127.0.0.1:19020/push` in plain WS mode (TLS off).
  A host reverse proxy is expected to terminate TLS.
- Auth token: `testnet-wss-push-token-do-not-use-in-production` —
  override via `PROXY_WSS_PUSH_AUTH_TOKEN`.
- DePIN methods are present but `NEURAI_DEPIN_ENABLED=false` by default;
  set to `true` (and ensure the node runs the DePIN service on
  `NEURAI_DEPIN_URL`) to make `depin.*` actually reach a backend.
- ZMQ subscriber connects to `tcp://neuraid:28332` automatically inside
  the Docker network. The `zeromq` npm package is in `optionalDependencies`;
  if it can't install (rare, glibc x64 has prebuilt binaries), the proxy
  falls back to pure-polling and logs the reason.

## Deployment behind HestiaCP (or any nginx)

The proxy listens plain WS internally. Your nginx terminates TLS with a
Let's Encrypt cert and reverse-proxies to it.

**1. Add the (sub)domain in HestiaCP and enable Let's Encrypt** in the UI.

**2. Drop this snippet at** `/home/<user>/conf/web/<domain>/nginx.ssl.conf_wss`:

```nginx
location /push {
    proxy_pass http://127.0.0.1:19020/push;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_read_timeout 3600s;
}
```

**3. Restart web:**

```bash
v-restart-web
```

**4. Start the docker stack:**

```bash
docker compose -f docker/docker-compose.yml up -d
```

The wallet then connects to `wss://<your-domain>/push`. HestiaCP handles
the cert and its 60-day renewal automatically.

If you put Cloudflare in front, use **DNS-only (grey cloud)** for this
subdomain: CF's 100-second idle WS timeout and CF-Connecting-IP rewrites
get in the way of persistent mobile-wallet connections.

### If you prefer the proxy to terminate TLS itself

Set in the proxy service environment:

```
PROXY_WSS_PUSH_TLS_ENABLED=true
PROXY_WSS_PUSH_SSL_CERT=/path/to/fullchain.pem
PROXY_WSS_PUSH_SSL_KEY=/path/to/privkey.pem
```

The proxy watches both files and hot-reloads via `setSecureContext` when
they change (e.g. when a renewal writes new files), so external renewal
tools work without restarting the container.

For local dev only, `PROXY_WSS_PUSH_AUTOGEN_CERT=true` generates a
self-signed cert in-container at startup.

## Project layout

```
.
├── index.js                  # entry point — boots wss-push only
├── getConfig.js              # config loader
├── getRPCNode.js             # Neurai + DePIN node selection / health checks
├── depinService.js           # challenge-response client for the DePIN service
├── wss-push/
│   ├── index.js              # config validation + start() + stats
│   ├── server.js             # https/http + ws upgrade, auth, rate limit
│   ├── protocol.js           # message framing, error codes, version constants
│   ├── methods.js            # core handlers (hello/ping/address.*/tx.broadcast)
│   ├── depin-methods.js      # depin.* handlers (read-only + signed)
│   ├── common.js             # MethodError, requireHello, requireSynced
│   ├── session.js            # per-connection state
│   ├── subscriptions.js      # address → sessions fan-out map
│   ├── notifications.js      # broadcast() + notifyAddress() helpers
│   ├── status.js             # stable status hash (fixed-order string)
│   ├── rpc.js                # separate PQueue for WSS-originated RPCs
│   ├── node-health.js        # getblockchaininfo poller + node.synced/syncing
│   ├── chain-state.js        # tip + Map<height,hash> + lastStatus per address
│   ├── chain-events.js       # onBlock/onRawTx orchestrator + warmup + reorg detection
│   ├── zmq-watcher.js        # ZMQ subscriber (optional `zeromq` dep)
│   ├── poller.js             # bestblockhash + mempool polling fallback
│   └── prevout-cache.js      # bounded outpoint → address LRU for input resolution
└── docker/
    ├── docker-compose.yml    # testnet node + proxy + test client
    ├── rpc-proxy/            # proxy image (local build)
    ├── wss-test/             # E2E test client (test profile)
    └── node/                 # Neurai testnet node image
```

## Tests

```bash
npm install
npm test                                                          # unit tests
docker compose -f docker/docker-compose.yml --profile test run --rm wss-test   # E2E
```

## License

MIT — see [LICENSE](LICENSE).
