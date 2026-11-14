# Platehouse app image (build plan Task 24; AC-093, AC-094): the Fastify
# server (apps/server) with the built web app (apps/web/dist) beside it, on
# node:26.13.0-trixie-slim, run as the image's non-root node user.
#
# Build context: the repository root. Only what this file copies goes in
# (docker/app.Dockerfile.dockerignore, which BuildKit reads beside this file).
#   docker build -f docker/app.Dockerfile -t platehouse .
#
# Layout inside the image, /app, is the workspace's own:
#   apps/server/dist/src/main.js           the entry point (CMD)
#   apps/server/dist/src/db/migrations/    the SQL migrations, copied next to
#                                          the built migrate.js, which reads
#                                          ./migrations beside itself (#31)
#   apps/web/dist/                         the web build; the server finds it
#                                          beside its own package (PR #155),
#                                          and requires it (#162): /healthz
#                                          is 503 while index.html is missing
#   packages/*/dist/                       the workspace packages the server
#                                          imports, built
#   node_modules, */node_modules           production dependencies only
# apps/importer is never copied (its test folder holds Manyfold's AGPL
# OpenAPI fixture, PR #157), and neither is any test folder.
#
# Configuration is the environment only (the plan's Configuration contract);
# the image sets none of it except what the contract defaults already say.
# INBOX_DIR and TMP_DIR default to /data/inbox and /data/tmp, which exist in
# the image owned by the node user, for a run without the bind mounts.

# node:26.13.0-trixie-slim, multi-arch index digest read from Docker Hub on
# 2026-11-13 (last updated 2026-11-05; amd64 manifest
# sha256:6f3406bb40734a2cbe3c78c3a5d9a467113b41b7a4c653a8d0534a276c67afdf,
# arm64 sha256:09d555867f72716747921204358450bf0cd9799f293541927fbdf97ce9aee750).
ARG BASE=node:26.13.0-trixie-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072

# ---------------------------------------------------------------- build
FROM ${BASE} AS build
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]

# pnpm 12.18.0 (the workspace's packageManager), the npm registry tarball
# checked against the sha256 apps/slicer/Dockerfile records for it. Only this
# stage has pnpm.
ADD --checksum=sha256:29d1d7d99bf6ec6d0a3dbb0ec5656f0d16e997e8be676ca45c581d11cb71f753 \
    https://registry.npmjs.org/pnpm/-/pnpm-12.18.0.tgz /tmp/pnpm.tgz
RUN mkdir /opt/pnpm \
 && tar -xzf /tmp/pnpm.tgz -C /opt/pnpm --strip-components=1 \
 && rm /tmp/pnpm.tgz \
 && printf '#!/bin/sh\nexec node /opt/pnpm/bin/pnpm.mjs "$@"\n' > /usr/local/bin/pnpm \
 && chmod 0755 /usr/local/bin/pnpm \
 && test "$(pnpm --version)" = 12.18.0 \
 && test "$(node --version)" = v26.13.0

ENV npm_config_store_dir=/root/.pnpm-store
WORKDIR /src

# The server and the web app with everything they build from: the root (for
# tsc and @types/node) and the three workspace packages.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/threemf/package.json packages/threemf/
COPY packages/makerworld/package.json packages/makerworld/
COPY packages/slicer-contract/package.json packages/slicer-contract/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile \
      --filter "@platehouse/server..." --filter "@platehouse/web..." --filter platehouse

COPY packages/threemf/tsconfig.json packages/threemf/
COPY packages/threemf/src packages/threemf/src
COPY packages/makerworld/tsconfig.json packages/makerworld/
COPY packages/makerworld/src packages/makerworld/src
COPY packages/slicer-contract/tsconfig.json packages/slicer-contract/
COPY packages/slicer-contract/src packages/slicer-contract/src
COPY apps/server/tsconfig.json apps/server/
COPY apps/server/src apps/server/src
COPY apps/web/tsconfig.json apps/web/index.html apps/web/vite.config.ts apps/web/
COPY apps/web/src apps/web/src

# The server and the packages it imports, with tsc (no test folder is in the
# context, so none is compiled), then the web app with vite build. tsc copies
# no .sql files, so the migrations are copied next to the built migrate.js,
# where MIGRATIONS_DIR resolves (#31), and checked file for file.
RUN node_modules/.bin/tsc -b apps/server \
 && pnpm --filter @platehouse/web run build \
 && cp -R apps/server/src/db/migrations apps/server/dist/src/db/migrations \
 && diff -r apps/server/src/db/migrations apps/server/dist/src/db/migrations \
 && test -f apps/server/dist/src/main.js \
 && test -f apps/server/dist/src/db/migrate.js \
 && test -f apps/server/dist/src/db/migrations/0001_init.sql \
 && test -f apps/web/dist/index.html \
 && test -d apps/web/dist/assets

# Production dependencies only, from the store the first install filled; then
# everything but the build output goes: sources, the web app's sources and
# config, source maps (their sources are gone) and tsc's build info.
RUN rm -rf node_modules apps/*/node_modules packages/*/node_modules \
 && pnpm install --frozen-lockfile --prod --offline --filter "@platehouse/server..." \
 && rm -rf packages/*/src apps/server/src \
      apps/web/src apps/web/index.html apps/web/vite.config.ts apps/web/tsconfig.json \
 && find . -path ./node_modules -prune -o \( -name '*.tsbuildinfo' -o -name '*.js.map' \) -print0 \
      | xargs -0 rm -f \
 && test ! -e apps/importer \
 && test ! -e apps/server/test \
 && test ! -e apps/server/dist/test \
 && chmod -R a+rX /src

# ---------------------------------------------------------------- runtime
FROM ${BASE}
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]

LABEL org.opencontainers.image.source="https://github.com/jonathanmcohen/platehouse" \
      org.opencontainers.image.description="Platehouse: a self-hosted library for 3D print files"

COPY --from=build /src /app

# The inbox and the temp folder the configuration defaults to, writable by
# the node user (uid 1000) when no bind mount covers them.
RUN mkdir -p /data/inbox /data/tmp \
 && chown node:node /data/inbox /data/tmp

USER node

# The same checks as the node user: it can read the server, the migrations
# and the web build, and write the data folders.
RUN test "$(id -u)" != 0 \
 && test -r /app/apps/server/dist/src/main.js \
 && test -r /app/apps/server/dist/src/db/migrations/0001_init.sql \
 && test -r /app/apps/web/dist/index.html \
 && test -w /data/inbox \
 && test -w /data/tmp

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app
EXPOSE 3000

# AC-093: Docker marks the container unhealthy when /healthz stops answering
# 200 (the database, pg-boss and the web build; Tasks 24 and 30), so the
# fleet restart-loop alert sees it. A fetch that hangs counts as a failure
# after 4 s. During the start period a check runs every 2 s, so a healthy
# start shows within seconds.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --start-interval=2s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# Node runs as PID 1 and stops itself on SIGTERM and SIGINT (main.ts, within
# 30 s); the server starts no child processes, so nothing needs reaping.
CMD ["node", "apps/server/dist/src/main.js"]
