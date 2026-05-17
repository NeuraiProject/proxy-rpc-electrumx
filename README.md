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

**Phases 1, 2, 3, 4, 5 + 6 implemented and verified against a live testnet node**:

- `hello`, `ping`
- `address.subscribe`, `address.unsubscribe`, `address.subscribe.bulk`,
  `address.unsubscribe.bulk` (with optional `assets` filter)
- `address.get_state` with composite cursor pagination (history + UTXOs),
  assets projection, and per-asset history rows
- `tx.broadcast`
- `depin.*` — read-only and signed methods (with challenge cache)
- Push events: `chain.tip`, `chain.reorg`, `address.changed` (with
  `touched_assets` in delta), `node.synced`, `node.syncing`
- ZMQ subscriber (`zeromq` optional dep) + mempool polling fallback
- Sync gating: methods that need a synced chain return `1008` with progress
- WS-level ping/pong keepalive (configurable, default 25s interval / 10s timeout)
- Auth, rate limit, session limits, cert hot-reload, block-index warmup

Pending: per-block "candidate addresses" refresh (optional improvement).

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
| `address.subscribe` | `{address, assets?}` | `{address, status, balance, height, assets?}` | **yes** |
| `address.subscribe.bulk` | `{addresses: [...], assets?}` | `{results: [{address, status?, balance?, height?, assets?, error?}]}` | **yes** |
| `address.unsubscribe` | `{address}` | `true` | no |
| `address.unsubscribe.bulk` | `{addresses: [...]}` | `{count}` | no |
| `address.get_state` | `{address, include_history?, include_utxos?, cursor?, limit?, utxo_cursor?, utxo_limit?, assets?, from_height?}` | `{address, status, balance, mempool, history, utxos, page, utxo_page, assets?, asset_utxos?}` | **yes** |
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

#### `address.get_state` and pagination

`address.get_state` returns the full per-address snapshot the wallet needs
to render a screen: balance, mempool entries, recent history, and UTXOs.
History is **always paginated** using a composite opaque cursor (`height:tx_index:asset`):

```json
// request
{ "id": 4, "method": "address.get_state",
  "params": {
    "address": "tnq1p9tdg76plsuss5lguphhm76t0faf2hy8vmefrq39ctsk0t5fqygzsz2dm40",
    "include_history": true,
    "include_utxos": true,
    "limit": 100,
    "cursor": null
  } }

// response
{ "id": 4, "result": {
    "address": "...",
    "status": "d9385809c15265e9...",
    "balance": { "confirmed": 500000000000, "unconfirmed": 0 },
    "mempool": [ { "txid": "...", "satoshis": 100000, "prev_txid": null, "prev_vout": null } ],
    "history": [ { "txid": "471e4d...", "height": 75841, "tx_index": 1, "asset": "XNA", "satoshis": 500000000000 } ],
    "utxos":   [ { "txid": "...", "vout": 0, "satoshis": 500000000000, "height": 75841 } ],
    "page":      { "cursor": null, "limit": 100, "has_more": true, "next_cursor": "75900:3:XNA" },
    "utxo_page": { "cursor": null, "limit": 100, "has_more": false, "next_cursor": null }
  } }
```

To fetch the next history page, the wallet sends `params.cursor: "75900:3:XNA"`
(the exact value returned in `next_cursor`). The cursor is opaque — the
client must not parse or construct it. Legacy two-part cursors
(`"height:tx_index"`) issued before per-asset history was added are still
accepted as a one-time compatibility shim. `include_history` and
`include_utxos` default to `true`; set them to `false` for a cheaper
response when the wallet only needs the balance + status. `from_height` is
accepted as a shortcut for the first page only — subsequent pages must use
`next_cursor`.

History entries aggregate per (height, tx_index, txid, asset). Every entry
has an `asset` field (`"XNA"` for native). If a single tx pays the same
address multiple times in the same asset, those outputs collapse into one
entry with the summed satoshis. If a tx touches multiple assets (e.g. a
swap of XNA → TRON), it produces one entry per asset — they share the
same `txid` but appear as distinct history rows.

UTXOs are paginated independently from history. By default `utxo_limit` is
**100** to keep mobile payloads sane — an address with thousands of UTXOs
(coinbase miner addresses, exchange hot wallets) would otherwise produce
multi-MB responses. The wallet has two ways to get more:

- `utxo_limit: <N>` — at most N UTXOs in this page; use `utxo_cursor`
  (returned as `utxo_page.next_cursor`) to fetch the next page.
- `utxo_limit: 0` — explicit opt-in for the **full set**, no cap. Use only
  when the wallet is prepared to handle large responses.

The server-side cap is `wss_push.utxo_page_limit` (default 1000); requests
above this clamp silently to the cap unless `utxo_limit: 0`.

### Assets

Neurai supports tokens (assets) on the same chain. By default the proxy
returns only the native XNA balance and UTXOs — wallets that don't care
about tokens see nothing new. To opt in, pass an `assets` filter:

| `assets` value | Behavior |
|---|---|
| `false`, `null`, or omitted | Native XNA only (default). Response unchanged. |
| `true` | Include every asset the address holds. |
| `["TRON", "BROM"]` | Include only these specific asset names (zero-filled if absent). |

When `assets` is set, the response gains:

```jsonc
// address.subscribe / address.subscribe.bulk[i]
{ "address": "...", "status": "...", "balance": {...}, "height": 75900,
  "assets": {
    "TRON":  { "confirmed": 100700000000, "unconfirmed": 0 },
    "TRON!": { "confirmed": 100000000,    "unconfirmed": 0 }
  } }

// address.get_state additionally returns:
{ "...": "...",
  "assets": { "TRON": {...}, ... },
  "asset_utxos": [
    { "txid": "...", "vout": 1, "satoshis": 42000000000, "height": 13973, "asset": "TRON" }
  ] }
```

Key points:

- The **status hash always includes asset balances + asset UTXOs** regardless
  of the filter. This means a token transfer to a subscribed address fires
  `address.changed` even if the wallet only requested `assets: false`. The
  wallet decides whether to refetch with the assets filter based on
  `delta.touched_assets` in the event.
- **Ownership tokens** (`NAME!`) are returned as separate entries from the
  underlying asset (`NAME`) — they're distinct on Neurai. The wallet can
  show or hide them as needed.
- **Asset history** in `address.get_state` follows the `assets` filter:
  - `assets: false` (default) → history contains only XNA rows.
  - `assets: true` → history mixes XNA and every asset row the address
    received, sorted by `(height, tx_index, asset)`. One row per asset
    per tx (see the aggregation note above).
  - `assets: ["FOO"]` → history contains XNA plus only the listed asset
    names. XNA is always included so wallets can render the native ledger
    alongside the filtered tokens.

  Requires a Neurai node built with the `getaddressdeltas` wildcard fix
  (`assetName: "*"`). Older nodes return an empty asset history; native
  history still works on those.

### Bulk subscribe for HD wallets

HD wallets derive many addresses (one per index) and need to subscribe them
all at session open. `address.subscribe.bulk` saves the round-trip cost of
issuing N individual subscribes:

```json
// request
{ "id": 10, "method": "address.subscribe.bulk",
  "params": { "addresses": ["addr1", "addr2", "addr3"] } }

// response — per-entry results, in input order
{ "id": 10, "result": { "results": [
    { "address": "addr1", "status": "ab12...", "balance": {...}, "height": 75900 },
    { "address": "addr2", "error": { "code": 1003, "message": "invalid address" } },
    { "address": "addr3", "status": "cd34...", "balance": {...}, "height": 75900 }
] } }
```

Per-entry errors do not abort the batch. The batch as a whole fails (1003)
if `addresses` is missing/non-array, or (1006) if it would push the session
over `max_subscriptions_per_session`. The max batch size defaults to **200**
(configurable via `wss_push.bulk_subscribe_limit`).

`address.unsubscribe.bulk({addresses: [...]})` symmetrically removes many.
It silently ignores empty/non-string entries and returns `{count}`.

### Resilient ZMQ subscriber

The ZMQ subscriber runs in a reconnecting loop with exponential backoff
(1s → 2s → 4s → ... → 30s capped). It survives:

- **Neuraid restarts** — the publisher comes back, the next reconnect
  attempt re-establishes the subscription.
- **Socket teardown / iterator errors** — the outer loop catches and retries.
- **Silent disconnects (NAT teardown, idle TCP)** — a watchdog (default
  5 min, `zmq_watchdog_ms`) recycles the socket if no message arrives for
  too long, forcing a fresh subscription.

Backoff resets to 1s after any connection that stayed up for >30s.

During reconnect gaps the polling fallback continues to detect new tips and
mempool changes, so the wallet still gets `chain.tip` and `address.changed`
events — just with the polling-interval latency (default 5s for blocks, 3s
for mempool) instead of ZMQ's near-real-time.

ZMQ status is exposed via `wssPush.getStats().zmq`:

```json
{ "connected": true, "attempts": 3,
  "last_message_at": 1734568914123,
  "last_connected_at": 1734568900456,
  "last_disconnected_at": 1734568700123 }
```

### WS-level keepalive

The server sends a WebSocket `ping` frame to every active session every
`keepalive_interval_ms` (default **25s** — safely below the typical
30-second NAT timeout that kills idle mobile WS connections). If the
client doesn't respond with a `pong` within `keepalive_timeout_ms`
(default **10s**), the server calls `ws.terminate()` and runs the normal
close cleanup (`unsubscribeAll`, `destroySession`, `keepalive.stop`).

Both values are configurable in `wss_push` config or via env:

```
PROXY_WSS_PUSH_KEEPALIVE_INTERVAL_MS=25000
PROXY_WSS_PUSH_KEEPALIVE_TIMEOUT_MS=10000
```

Tuning hints:

- **Lower `interval_ms`** (e.g. 15000) if your reverse proxy / NAT has an
  aggressive idle timeout — when in doubt, halve it.
- **Lower `timeout_ms`** (e.g. 5000) if you want faster dead-peer detection,
  at the cost of being less tolerant of slow mobile networks.
- **Raise `interval_ms`** (e.g. 60000) if you want to reduce traffic and
  your network has no idle timeouts (LAN/datacenter only).

The wallet doesn't need application-level handling — the `ws` client
library auto-responds to ping frames. The application-level `ping` method
(returning `"pong"`) is a separate request/response, useful for the wallet
to actively verify the proxy is responsive.

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

### Local stats endpoint (optional)

For ops/monitoring there is an optional HTTP endpoint that exposes a JSON
snapshot of sessions, subscriptions, chain tip, node health, ZMQ status and
RPC queue depth. **Disabled by default.** Activate with:

```json
"wss_push": {
  "stats_enabled": true,
  "stats_port": 19021
}
```

Or via env vars in Docker:

```yaml
PROXY_WSS_PUSH_STATS_ENABLED: "true"
PROXY_WSS_PUSH_STATS_PORT: "19021"
```

The server always binds to `127.0.0.1` regardless of any host setting — the
response is unauthenticated and reveals internal state, so it must never be
reachable from the public network. To consume it from the host, exec into
the container or add a localhost port mapping in your compose file.

```text
$ docker exec neurai-testnet-rpc-proxy wget -qO- http://127.0.0.1:19021/stats
{"uptime_s":1234,"sessions":{"sessionCount":3},"subscriptions":{"distinctAddresses":7,...},
 "chain":{"tip":{"height":76820,...},...},"node":{"syncing":false,...},"zmq":{...}}
```

Only `GET /stats` is served; other paths return 404 and non-GET returns 405.

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
│   ├── cursor.js             # opaque cursor codecs (history + utxo)
│   ├── keepalive.js          # WS-level ping/pong per session
│   ├── node-health.js        # getblockchaininfo poller + node.synced/syncing
│   ├── chain-state.js        # tip + Map<height,hash> + lastStatus per address
│   ├── chain-events.js       # onBlock/onRawTx orchestrator + warmup + reorg detection
│   ├── zmq-watcher.js        # resilient ZMQ subscriber (backoff + watchdog)
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
