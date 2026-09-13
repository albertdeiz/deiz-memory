# The web (§15), as an image.
#
# Two stages so the runtime carries no toolchain and no node_modules: Next's
# `standalone` output is a server plus exactly the dependencies it reaches.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json next.config.ts ./
COPY src ./src
COPY public ./public
# DM_API_URL is deliberately NOT set here. The proxy reads it per request (see
# src/app/api/[...path]/route.ts), so one image works against the compose network
# and against a localhost in development. It used to be a next.config rewrite,
# which bakes the destination in at build time — the image came out pointing at
# itself.
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Next writes its standalone server here, with its own minimal node_modules.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

# Not root: this serves a browser and has no business being able to do anything.
RUN addgroup -g 10002 web && adduser -D -u 10002 -G web web
USER web

EXPOSE 4318
ENV PORT=4318 HOSTNAME=0.0.0.0
CMD ["node", "server.js"]
