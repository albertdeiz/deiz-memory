#!/usr/bin/env bash
# Bootstrap idempotente de Garage: layout, bucket y key.
set -euo pipefail

# Un solo stack. Los tests no levantan contenedores propios: usan estos mismos
# servicios con una base y un bucket aparte (ver tests/helpers/env.ts).
COMPOSE="compose.yml"
S3_PORT=3900; PG_PORT=5433; ENVFILE=".env"
DOC_PORT=8081; SPEECH_PORT=8082; OCR_PORT=8083
BUCKET="deiz-memory"
TESTBUCKET="deiz-memory-test"
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

# Dos buckets sobre el mismo Garage: el tuyo y uno de pruebas. Los tests
# escriben blobs de verdad —es la única forma de probar el adapter S3— y no
# tienen por qué dejarlos tirados entre tus documentos.
for b in "$BUCKET" "$TESTBUCKET"; do
  if ! $G bucket info "$b" >/dev/null 2>&1; then
    echo "→ creando bucket '$b'"
    $G bucket create "$b" >/dev/null
  fi
  $G bucket allow --read --write --owner "$b" --key "$KEYNAME" >/dev/null
done

# Este archivo se reescribe entero en cada corrida, así que todo lo que el CLI
# necesite para hablar con el compose tiene que salir de acá. Lo que NO sale de
# acá son las llaves de proveedores externos (ANTHROPIC_API_KEY y compañía):
# esas las pones tú y se conservan aparte, en .env.local.
cat > "$ENVFILE" <<EOF
DATABASE_URL=postgres://deiz:deiz@localhost:${PG_PORT}/deiz_memory
S3_ENDPOINT=http://localhost:${S3_PORT}
S3_REGION=garage
S3_BUCKET=${BUCKET}
S3_ACCESS_KEY_ID=${KEY_ID}
S3_SECRET_ACCESS_KEY=${KEY_SECRET}
DM_DOCUMENTS_URL=http://localhost:${DOC_PORT}
DM_SPEECH_URL=http://localhost:${SPEECH_PORT}/v1
DM_OCR_URL=http://localhost:${OCR_PORT}
DM_TEST_BUCKET=${TESTBUCKET}
EOF

echo "✓ Garage listo · credenciales en $ENVFILE"
