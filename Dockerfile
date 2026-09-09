# The app itself, as an image. Nothing needs Node on the host.
#
# Two stages so the runtime carries no toolchain: the builder installs every
# dependency and bundles, the runtime installs production dependencies only and
# copies one file in. The bundle keeps our own modules together; dependencies
# stay external because bundling native ones buys nothing and breaks some.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx esbuild src/adapters/cli/index.ts \
      --bundle --platform=node --format=esm --target=node22 \
      --packages=external --outfile=dist/dm.js

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist/dm.js ./dist/dm.js
COPY migrations ./migrations

# The image ships the CLI. Which process a container runs — the worker, the bot,
# a one-off command — is the compose's call, not the image's.
ENTRYPOINT ["node", "/app/dist/dm.js"]
CMD ["doctor"]

# ---------------------------------------------------------------- the backup
#
# The same app, plus the three binaries the backup shells out to. A separate
# stage and not the runtime image because the worker and the bot have no use for
# restic, rclone or a VPN client, and an image is not a place to keep options
# open.
FROM runtime AS backup

# restic encrypts and versions; rclone is only transport. Tailscale is how the
# destination gets reached without anything being exposed to the internet — the
# Nextcloud on the other end publishes no port and resolves to a tailnet address.
RUN apk add --no-cache restic rclone tailscale bash

COPY services/backup/entrypoint.sh /usr/local/bin/dm-backup
RUN chmod +x /usr/local/bin/dm-backup

ENTRYPOINT ["/usr/local/bin/dm-backup"]
CMD ["backup", "status"]
