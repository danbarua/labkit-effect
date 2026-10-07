#!/usr/bin/env zsh

BRAND="labkit"
HTTP_CAPTURES="$HOME/.local/share/$BRAND/logs/http-captures"
LGTM_DATA="$HOME/lgtm-data/"
# Tempo keeps traces 31 days and queries over up to 31 days (tempo-config.yaml beside this script);
# Prometheus keeps 31 days. The dashboards are read at 7d and 30d.
TEMPO_CONFIG="${0:A:h}/tempo-config.yaml"
mkdir -p $LGTM_DATA
mkdir -p $HTTP_CAPTURES

docker rm -f lgtm

docker run -d \
  --name lgtm \
  -e 'TEMPO_EXTRA_ARGS=--query-frontend.mcp-server.enabled=true' \
  -e 'PROMETHEUS_EXTRA_ARGS=--storage.tsdb.retention.time=31d' \
  -v "$TEMPO_CONFIG:/otel-lgtm/tempo-config.yaml:ro" \
  -v "$LGTM_DATA:/data" \
  -v "$HTTP_CAPTURES:/data/http-captures:ro" \
  -p 3000:3000 \
  -p 3200:3200 \
  -p 4040:4040 \
  -p 4317:4317 \
  -p 4318:4318 \
  -p 9090:9090 \
  grafana/otel-lgtm:latest

docker inspect --format '{{json .Mounts}}' lgtm | jq .

echo "Waiting for grafana to start..."
sleep 5
curl -fsS http://localhost:3000/api/health
