# ── Neurai RPC Proxy ───────────────────────────────────────────────────────
# Builds the proxy image from the local working tree.
# Build context MUST be the repository root, not docker/rpc-proxy/.
FROM node:lts-slim

ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    openssl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY . ./

COPY docker/rpc-proxy/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 19020

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
