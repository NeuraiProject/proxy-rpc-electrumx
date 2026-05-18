# Tests

This directory contains test-only assets. The main Docker stack in
`docker/docker-compose.yml` only starts the service containers.

Start the service stack:

```bash
docker compose -f docker/docker-compose.yml up -d --build
```

Run the WSS acceptance suite:

```bash
docker compose -f docker/docker-compose.yml -f tests/docker-compose.yml --profile test run --rm wss-test
```

