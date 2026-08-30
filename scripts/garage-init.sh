#!/usr/bin/env bash
# Bootstrap idempotente de Garage: layout, bucket y key.
# Uso:  ./scripts/garage-init.sh [test]
set -euo pipefail

MODE="${1:-dev}"
if [ "$MODE" = "test" ]; then
  COMPOSE="compose.test.yml"; S3_PORT=3910; PG_PORT=5434; ENVFILE=".env.test"
else
  COMPOSE="compose.yml";      S3_PORT=3900; PG_PORT=5433; ENVFILE=".env"
fi
BUCKET="deiz-memory"
KEYNAME="deiz"
G="docker compose -f $COMPOSE exec -T garage /garage"

echo "→ esperando a Garage..."
for i in $(seq 1 60); do
  if $G status >/dev/null 2>&1; then break; fi
  sleep 1
  if [ "$i" = "60" ]; then echo "Garage no respondió en 60s"; exit 1; fi
done

if $G status 2>/dev/null | grep -q "NO ROLE ASSIGNED"; then
  NODE_ID="$($G node id -q | cut -d@ -f1)"
  echo "→ asignando layout al nodo ${NODE_ID:0:16}..."
  $G layout assign -z dc1 -c 1G "$NODE_ID" >/dev/null
  VERSION="$($G layout show | grep -oE 'version [0-9]+' | tail -1 | awk '{print $2}')"
  $G layout apply --version "${VERSION:-1}" >/dev/null
  sleep 2
else
  echo "→ layout ya aplicado"
fi

if ! $G key info "$KEYNAME" >/dev/null 2>&1; then
  echo "→ creando key '$KEYNAME'"
  $G key create "$KEYNAME" >/dev/null
fi

KEYINFO="$($G key info "$KEYNAME" --show-secret)"
KEY_ID="$(echo "$KEYINFO"    | grep -i '^Key ID:'     | awk '{print $3}')"
KEY_SECRET="$(echo "$KEYINFO"| grep -i '^Secret key:' | awk '{print $3}')"

if ! $G bucket info "$BUCKET" >/dev/null 2>&1; then
  echo "→ creando bucket '$BUCKET'"
  $G bucket create "$BUCKET" >/dev/null
fi
$G bucket allow --read --write --owner "$BUCKET" --key "$KEYNAME" >/dev/null

cat > "$ENVFILE" <<EOF
DATABASE_URL=postgres://deiz:deiz@localhost:${PG_PORT}/deiz_memory
S3_ENDPOINT=http://localhost:${S3_PORT}
S3_REGION=garage
S3_BUCKET=${BUCKET}
S3_ACCESS_KEY_ID=${KEY_ID}
S3_SECRET_ACCESS_KEY=${KEY_SECRET}
EOF

echo "✓ Garage listo · credenciales en $ENVFILE"
