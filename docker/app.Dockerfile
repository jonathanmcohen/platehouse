# Platehouse app image, with a healthcheck: the Fastify
# server (apps/server) with the built web app (apps/web/dist) beside it, on
# node:26.13.0-trixie-slim, run as the image's non-root node user.
#
# Build context: the repository root. Only what this file copies goes in
# (docker/app.Dockerfile.dockerignore, which BuildKit reads beside this file).
#   docker build -f docker/app.Dockerfile -t platehouse .
#
# Layout inside the image, /app, is the workspace's own:
#   apps/server/dist/src/main.js           the entry point (CMD)
#   apps/server/dist/src/plate-mesh/worker.js
#                                          the thread a plate's mesh is read
#                                          in, started from worker-read.js
#                                          beside it (#358)
#   apps/server/dist/src/db/migrations/    the SQL migrations, copied next to
#                                          the built migrate.js, which reads
#                                          ./migrations beside itself (#31)
#   apps/web/dist/                         the web build; the server finds it
#                                          beside its own package (PR #155),
#                                          and requires it (#162): /healthz
#                                          is 503 while index.html is missing.
#                                          It holds apps/web/public's icons
#                                          and manifest at its root, which
#                                          the server answers at / (ROOT_FILES)
#   packages/*/dist/                       the workspace packages the server
#                                          imports, built
#   node_modules, */node_modules           production dependencies only
# apps/importer is never copied (its test folder holds Manyfold's AGPL
# OpenAPI fixture, PR #157), and neither is any test folder.
#
# Configuration is the environment only (apps/server/src/config.ts);
# the image sets none of it except what that file's defaults already say.
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
COPY packages/i18n/package.json packages/i18n/
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
COPY packages/i18n/tsconfig.json packages/i18n/
COPY packages/i18n/src packages/i18n/src
COPY packages/i18n/locales packages/i18n/locales
COPY apps/server/tsconfig.json apps/server/
COPY apps/server/src apps/server/src
COPY apps/web/tsconfig.json apps/web/index.html apps/web/vite.config.ts apps/web/
COPY apps/web/src apps/web/src
# The favicons, app icons and manifest: vite build copies public/ to the root
# of apps/web/dist, and writes none of them when it is missing.
COPY apps/web/public apps/web/public

# The server and the packages it imports, with tsc (no test folder is in the
# context, so none is compiled), then the web app with vite build. tsc copies
# no .sql files, so the migrations are copied next to the built migrate.js,
# where MIGRATIONS_DIR resolves (#31), and checked file for file.
RUN node_modules/.bin/tsc -b apps/server \
 && pnpm --filter @platehouse/web run build \
 && cp -R apps/server/src/db/migrations apps/server/dist/src/db/migrations \
 && diff -r apps/server/src/db/migrations apps/server/dist/src/db/migrations \
 && test -f apps/server/dist/src/main.js \
 && test -f packages/i18n/dist/src/index.js \
 && test -f packages/i18n/locales/en.json \
 && test -f apps/server/dist/src/db/migrate.js \
 && test -f apps/server/dist/src/db/migrations/0001_init.sql \
 && test -f apps/server/dist/src/plate-mesh/worker.js \
 && test -f apps/web/dist/index.html \
 && test -d apps/web/dist/assets \
 && test -f apps/web/dist/favicon.ico \
 && test -f apps/web/dist/favicon.svg \
 && test -f apps/web/dist/apple-touch-icon.png \
 && test -f apps/web/dist/icon-192.png \
 && test -f apps/web/dist/icon-512.png \
 && test -f apps/web/dist/icon-maskable-512.png \
 && test -f apps/web/dist/site.webmanifest

# Production dependencies only, from the store the first install filled; then
# everything but the build output goes: sources, the web app's sources,
# public/ (vite build copied it into apps/web/dist) and config, source maps
# (their sources are gone) and tsc's build info.
RUN rm -rf node_modules apps/*/node_modules packages/*/node_modules \
 && pnpm install --frozen-lockfile --prod --offline --filter "@platehouse/server..." \
 && rm -rf packages/*/src apps/server/src \
      apps/web/src apps/web/public apps/web/index.html apps/web/vite.config.ts apps/web/tsconfig.json \
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

# Debian's pending updates, applied here because the base image can lag
# Debian's security fixes: the release workflow's Trivy gate fails on any
# fixable OS HIGH or CRITICAL, and run 43661472697 failed on a zlib1g fix the
# base did not have yet. Upgrades, plus tini for PID 1 (see ENTRYPOINT),
# installed without recommends and with apt retrying a failed download 10
# times as the other images do (#147), and the package lists removed
# afterwards. Only this stage needs it: nothing from the build stage's OS
# reaches the image, only /src.
#
# OS_UPDATES_STAMP is used in this RUN so that a new value rebuilds it: the
# build cache would otherwise keep this layer for as long as the base digest
# and this line stay the same, and later Debian fixes would never reach the
# image. release.yml passes a value unique to the run (run id and attempt), so
# every release takes Debian's current fixes; the CI App image job passes the
# UTC date and the run attempt, so pull request builds refresh daily, stay
# cached within a day, and a re-run of a failed job refreshes too.
# A plain docker build with no value uses "local".
ARG OS_UPDATES_STAMP=local
RUN echo "Debian updates, stamp ${OS_UPDATES_STAMP}" \
 && printf '%s\n' 'Acquire::Retries "10";' 'Acquire::http::Timeout "30";' 'Acquire::https::Timeout "30";' > /etc/apt/apt.conf.d/80retries \
 && apt-get update --error-on=any \
 && DEBIAN_FRONTEND=noninteractive apt-get -y upgrade --no-install-recommends \
      -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold \
 && DEBIAN_FRONTEND=noninteractive apt-get -y install --no-install-recommends tini \
 && test -x /usr/bin/tini \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /src /app

# The AGPL licence text, so the image carries the licence it is distributed under.
COPY LICENSE /app/LICENSE

# The inbox and the temp folder the configuration defaults to, writable by
# the node user (uid 1000) when no bind mount covers them.
RUN mkdir -p /data/inbox /data/tmp \
 && chown node:node /data/inbox /data/tmp

USER node

# The same checks as the node user: it can read the server, the plate mesh
# worker, the migrations and the web build with its icons and manifest, and write the data folders.
RUN test "$(id -u)" != 0 \
 && test -r /app/apps/server/dist/src/main.js \
 && test -r /app/apps/server/dist/src/db/migrations/0001_init.sql \
 && test -r /app/apps/server/dist/src/plate-mesh/worker.js \
 && test -r /app/apps/web/dist/index.html \
 && test -r /app/apps/web/dist/favicon.ico \
 && test -r /app/apps/web/dist/favicon.svg \
 && test -r /app/apps/web/dist/apple-touch-icon.png \
 && test -r /app/apps/web/dist/icon-192.png \
 && test -r /app/apps/web/dist/icon-512.png \
 && test -r /app/apps/web/dist/icon-maskable-512.png \
 && test -r /app/apps/web/dist/site.webmanifest \
 && test -w /data/inbox \
 && test -w /data/tmp

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app
EXPOSE 3000

# Docker marks the container unhealthy when /healthz stops answering
# 200 (the database, pg-boss and the web build), so an orchestrator or
# monitor watching container health sees it. A fetch that hangs counts as a failure
# after 4 s. During the start period a check runs every 2 s, so a healthy
# start shows within seconds.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --start-interval=2s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# tini runs as PID 1 and reaps orphans: a process whose parent has gone is
# re-parented to PID 1, and Node, which waits only on the children it spawned,
# would leave it a zombie for the life of the container. tini also passes
# SIGTERM on to Node, which stops itself on SIGTERM and SIGINT (main.ts,
# within 30 s), also while it is still starting.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/server/dist/src/main.js"]
