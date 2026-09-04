#!/usr/bin/env bash
# Brings the whole system up. Nothing runs on the host: not the lanes, not the
# model, not the app.
#
# The order is not cosmetic. The object store mints its credentials on first
# boot and writes them to .env, and the app containers read that file when
# compose starts them — so they have to come after.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "· infrastructure and lanes"
docker compose up -d postgres garage documents ocr whisper ollama

echo "· object store credentials"
./scripts/garage-init.sh

echo "· schema and seeds"
docker compose --profile setup run --rm app-migrate

echo "· app"
docker compose --profile chat up -d app-worker app-bot

echo
docker compose run --rm app-worker doctor
