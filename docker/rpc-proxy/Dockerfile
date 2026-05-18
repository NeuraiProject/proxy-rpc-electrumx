# ── Neurai RPC Proxy ───────────────────────────────────────────────────────
# Builds the image by cloning neurai-wallet-services from GitHub so every
# build pulls the latest commit on the configured branch. The build context
# only needs to contain entrypoint.sh — point compose at docker/rpc-proxy/.
FROM node:lts-slim

ARG REPO_URL=https://github.com/NeuraiProject/neurai-wallet-services.git
ARG REPO_REF=main

ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    openssl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Cache-bust the clone layer when upstream HEAD moves. The GitHub API
# response changes whenever a new commit lands on REPO_REF, which forces
# Docker to invalidate this layer and re-run the clone below.
ADD https://api.github.com/repos/NeuraiProject/neurai-wallet-services/commits/${REPO_REF} /tmp/.repo-head

RUN git clone --depth 1 --branch "${REPO_REF}" "${REPO_URL}" /tmp/src \
 && cp -a /tmp/src/. /app/ \
 && rm -rf /tmp/src \
 && (npm ci --omit=dev || npm install --omit=dev)

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 19020

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
