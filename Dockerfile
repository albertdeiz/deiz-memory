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
