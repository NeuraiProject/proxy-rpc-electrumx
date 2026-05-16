# neurai-wss-push

WSS push server for Neurai mobile wallets. Holds a persistent WebSocket per
client, lets it subscribe to addresses, and pushes events when balances or
mempool state change — so the wallet never polls. Also exposes the Neurai
DePIN messaging RPCs over the same connection.

This is **not** a generic Electrum/ElectrumX-compatible server. The wire
protocol is custom and small, intended to be paired with one mobile wallet
that speaks the same protocol.

## What's in here

- A WSS endpoint at `/push` that speaks a JSON-RPC-like protocol over WebSocket.
- Auth in the HTTP upgrade via `Sec-WebSocket-Protocol: wss-push, auth.<token>`.
- Built-in rate limiting (`503 Retry-After`) and session/subscription caps.
- DePIN method handlers — both read-only RPCs and the signed messaging flow.
- Docker setup for testnet + an E2E test client.

## Status

**Phase 1** of the plan is implemented and tested end-to-end:

- `hello`, `ping`
- `address.subscribe`, `address.unsubscribe` (with initial state)
- `tx.broadcast`
- `depin.*` — read-only and signed methods
- Auth, rate limit, session limits, cert hot-reload

Pending: ZMQ-driven `address.changed` / `chain.tip` / `chain.reorg` events,
paginated `address.get_state`, assets, WS-frame keepalive.

## Protocol overview

Wire-level subprotocol identifier: `wss-push`.
Application-level version (in `hello`): `wss-push/1`.

Handshake:

```json
// client → server (over WSS, after a 101 upgrade)
{ "id": 1, "method": "hello",
  "params": { "client": "my-wallet", "version": "0.1.0",
              "network": "mainnet", "protocol": "wss-push/1" } }

// server → client
{ "id": 1, "result": { "server": "neurai-rpc-proxy-wss",
                       "protocol": "wss-push/1",
                       "protocol_min": "wss-push/1",
                       "protocol_max": "wss-push/1",
                       "network": "mainnet",
                       "tip_height": 123456,
                       "tip_hash": "..." } }
```

Available methods today:

| Method | Params | Returns |
|---|---|---|
| `hello` | `{client, version, network, protocol}` | server info + tip |
| `ping` | none | `"pong"` |
| `address.subscribe` | `{address}` | `{address, status, balance, height}` |
| `address.unsubscribe` | `{address}` | `true` |
| `tx.broadcast` | `{rawtx}` | `{txid}` |
| `depin.check_validity` | `[asset]` or `{args:[asset]}` | RPC result |
| `depin.list_holders` | `[asset]` | RPC result |
| `depin.list_addresses` | `[asset]` | RPC result |
| `depin.get_pubkey` | `[address]` | RPC result |
| `depin.pool_stats` | none | RPC result |
| `depin.pool_pkey` | none | RPC result |
| `depin.pool_content` | none | RPC result |
| `depin.mcp_status` | none | RPC result |
| `depin.msg_info` | `[token]` | RPC result |
| `depin.challenge` | `{address}` | `{challenge, timeout, expires_at}` |
| `depin.send_msg` | `{address, signature, args:[...]}` | RPC result |
| `depin.get_msg` | `{address, signature, args:[...]}` | RPC result |
| `depin.receive_msg` | `{address, signature, args:[...]}` | RPC result |
| `depin.submit_msg` | `{address, signature, args:[...]}` | RPC result |
| `depin.clear_msg` | `{address, signature, args:[...]}` | RPC result |

`address.changed`, `chain.tip`, `chain.reorg` server-to-client events are
defined in the plan but not yet emitted (Phase 2).

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

# Run the Phase 1 acceptance suite
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
│   ├── index.js              # config validation + start()
│   ├── server.js             # https/http + ws upgrade, auth, rate limit
│   ├── protocol.js           # message framing, error codes, version constants
│   ├── methods.js            # core handlers (hello/ping/address.*/tx.broadcast)
│   ├── depin-methods.js      # depin.* handlers (read-only + signed)
│   ├── common.js             # MethodError, requireHello
│   ├── session.js            # per-connection state
│   ├── subscriptions.js      # address → sessions fan-out map
│   ├── status.js             # stable status hash (fixed-order string)
│   └── rpc.js                # separate PQueue for WSS-originated RPCs
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
