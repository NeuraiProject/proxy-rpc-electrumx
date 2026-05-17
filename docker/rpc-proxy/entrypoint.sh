#!/bin/sh
set -eu

: "${NEURAI_NODE_NAME:=neuraid-testnet}"
: "${NEURAI_NODE_URL:=http://neuraid:19101}"
: "${NEURAI_RPC_USER:=neurai}"
: "${NEURAI_RPC_PASSWORD:=changeme}"
: "${NEURAI_DEPIN_ENABLED:=false}"
: "${NEURAI_DEPIN_URL:=http://neuraid:19102}"
: "${PROXY_WSS_PUSH_ENABLED:=false}"
: "${PROXY_WSS_PUSH_PORT:=19020}"
: "${PROXY_WSS_PUSH_PATH:=/push}"
: "${PROXY_WSS_PUSH_TLS_ENABLED:=true}"
: "${PROXY_WSS_PUSH_SSL_CERT:=/app/certs/push.crt}"
: "${PROXY_WSS_PUSH_SSL_KEY:=/app/certs/push.key}"
: "${PROXY_WSS_PUSH_AUTH_TRANSPORT:=sec-websocket-protocol}"
: "${PROXY_WSS_PUSH_AUTH_TOKEN:=change-this-token}"
: "${PROXY_WSS_PUSH_AUTOGEN_CERT:=false}"
: "${PROXY_WSS_PUSH_ZMQ_SEQUENCE_ENABLED:=false}"
: "${PROXY_WSS_PUSH_ZMQ_WATCHDOG_MS:=300000}"
: "${PROXY_WSS_PUSH_POLL_INTERVAL_MS:=5000}"
: "${PROXY_WSS_PUSH_MEMPOOL_INTERVAL_MS:=3000}"
: "${PROXY_WSS_PUSH_MAX_SESSIONS:=5000}"
: "${PROXY_WSS_PUSH_MAX_SUBSCRIPTIONS_PER_SESSION:=200}"
: "${PROXY_WSS_PUSH_MAX_NEW_CONNECTIONS_PER_SECOND:=50}"
: "${PROXY_WSS_PUSH_HISTORY_PAGE_LIMIT:=100}"
: "${PROXY_WSS_PUSH_UTXO_PAGE_LIMIT:=1000}"
: "${PROXY_WSS_PUSH_BULK_SUBSCRIBE_LIMIT:=200}"
: "${PROXY_WSS_PUSH_REORG_INVALIDATE_DEPTH:=60}"
: "${PROXY_WSS_PUSH_KEEPALIVE_INTERVAL_MS:=25000}"
: "${PROXY_WSS_PUSH_KEEPALIVE_TIMEOUT_MS:=10000}"
: "${PROXY_WSS_PUSH_STATS_ENABLED:=false}"
: "${PROXY_WSS_PUSH_STATS_PORT:=19021}"
: "${PROXY_ZMQ_ENDPOINT:=tcp://neuraid:28332}"

if [ "${PROXY_WSS_PUSH_ENABLED}" = "true" ] \
   && [ "${PROXY_WSS_PUSH_TLS_ENABLED}" = "true" ] \
   && [ "${PROXY_WSS_PUSH_AUTOGEN_CERT}" = "true" ]; then
  if [ ! -f "${PROXY_WSS_PUSH_SSL_CERT}" ] || [ ! -f "${PROXY_WSS_PUSH_SSL_KEY}" ]; then
    mkdir -p "$(dirname "${PROXY_WSS_PUSH_SSL_CERT}")" "$(dirname "${PROXY_WSS_PUSH_SSL_KEY}")"
    echo "[entrypoint] generating self-signed cert at ${PROXY_WSS_PUSH_SSL_CERT} (dev/test only)"
    openssl req -x509 -newkey rsa:2048 \
      -keyout "${PROXY_WSS_PUSH_SSL_KEY}" \
      -out "${PROXY_WSS_PUSH_SSL_CERT}" \
      -days 365 -nodes \
      -subj "/CN=neurai-wss-push-dev" >/dev/null 2>&1
    chmod 600 "${PROXY_WSS_PUSH_SSL_KEY}"
  else
    echo "[entrypoint] cert already exists at ${PROXY_WSS_PUSH_SSL_CERT}, skipping autogen"
  fi
fi

cat > /app/config.json <<EOF
{
  "wss_push": {
    "enabled": ${PROXY_WSS_PUSH_ENABLED},
    "host": "0.0.0.0",
    "port": ${PROXY_WSS_PUSH_PORT},
    "path": "${PROXY_WSS_PUSH_PATH}",
    "tls_enabled": ${PROXY_WSS_PUSH_TLS_ENABLED},
    "ssl_cert": "${PROXY_WSS_PUSH_SSL_CERT}",
    "ssl_key": "${PROXY_WSS_PUSH_SSL_KEY}",
    "zmq_enabled": true,
    "zmq_sequence_enabled": ${PROXY_WSS_PUSH_ZMQ_SEQUENCE_ENABLED},
    "zmq_watchdog_ms": ${PROXY_WSS_PUSH_ZMQ_WATCHDOG_MS},
    "auth_transport": "${PROXY_WSS_PUSH_AUTH_TRANSPORT}",
    "auth_token": "${PROXY_WSS_PUSH_AUTH_TOKEN}",
    "poll_interval_ms": ${PROXY_WSS_PUSH_POLL_INTERVAL_MS},
    "mempool_interval_ms": ${PROXY_WSS_PUSH_MEMPOOL_INTERVAL_MS},
    "max_sessions": ${PROXY_WSS_PUSH_MAX_SESSIONS},
    "max_subscriptions_per_session": ${PROXY_WSS_PUSH_MAX_SUBSCRIPTIONS_PER_SESSION},
    "max_new_connections_per_second": ${PROXY_WSS_PUSH_MAX_NEW_CONNECTIONS_PER_SECOND},
    "history_page_limit": ${PROXY_WSS_PUSH_HISTORY_PAGE_LIMIT},
    "utxo_page_limit": ${PROXY_WSS_PUSH_UTXO_PAGE_LIMIT},
    "bulk_subscribe_limit": ${PROXY_WSS_PUSH_BULK_SUBSCRIBE_LIMIT},
    "reorg_invalidate_depth": ${PROXY_WSS_PUSH_REORG_INVALIDATE_DEPTH},
    "keepalive_interval_ms": ${PROXY_WSS_PUSH_KEEPALIVE_INTERVAL_MS},
    "keepalive_timeout_ms": ${PROXY_WSS_PUSH_KEEPALIVE_TIMEOUT_MS},
    "stats_enabled": ${PROXY_WSS_PUSH_STATS_ENABLED},
    "stats_port": ${PROXY_WSS_PUSH_STATS_PORT},
    "zmq_endpoint": "${PROXY_ZMQ_ENDPOINT}"
  },
  "nodes": [
    {
      "name": "${NEURAI_NODE_NAME}",
      "username": "${NEURAI_RPC_USER}",
      "password": "${NEURAI_RPC_PASSWORD}",
      "neurai_url": "${NEURAI_NODE_URL}",
      "depin_enabled": ${NEURAI_DEPIN_ENABLED},
      "depin_url": "${NEURAI_DEPIN_URL}"
    }
  ]
}
EOF

echo "[entrypoint] config.json generated, starting wss-push"
exec npm start
