# Platehouse slicer image (build plan Task 11): OrcaSlicer 2.5.0, OpenSCAD
# 2026.11-RC0, landrun and occt-import-js behind Slicer HTTP contract v1.
# amd64 only. release-engineer builds and publishes it in Task 25; this file
# only defines it.
#
# Every step that fetches or prepares OrcaSlicer, its profiles, OpenSCAD,
# landrun and Node follows tools/slicing-gate/Dockerfile, which Hades run 4
# proved on 2026-11-08 (332 slices, PASS). Each of those steps was a real
# failure on the way: the AppImage layout (run 1), libatomic1 for Node
# (run 2), file modes for a non-root user (first CI build), and the
# process_full presets for a printer switch (run 3).
#
# Every release file is pinned to an exact version and checked against the
# sha256 recorded here (the gate's values for Orca, OpenSCAD, landrun and
# Node, read from the GitHub release asset digests and Node's SHASUMS256.txt
# on 2026-11-07; pnpm's from the npm registry tarball on 2026-11-08, whose
# sha512 integrity matched). Orca's profile JSON is pinned by its git commit
# and checked by git. npm packages come from pnpm-lock.yaml, which pins each
# by version and integrity.
#
# Build context: the repository root.
#   docker build --platform linux/amd64 -f apps/slicer/Dockerfile -t platehouse-slicer .
#
# Run it as Hades does (AC-035): read-only root, a tmpfs at /work, internal
# network only, 4 CPUs and 4 GB (the gate's measured worst plate: 2568 MiB
# RSS, 55.31 s, 171 MiB scratch):
#   docker run --read-only --tmpfs /work:rw,size=1g,mode=1777 --cpus 4 \
#     --memory 4g --cap-drop ALL --security-opt no-new-privileges:true ...

# ubuntu:24.04, multi-arch index digest read from Docker Hub on 2026-11-07
# (amd64 manifest sha256:78d4744ead1f5b19b04d0df558ab182a5300903900755e515b2ca4d10eb2044d).
ARG BASE=ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852

# Ubuntu snapshot every apt package is installed from, as in the gate: each
# stage first installs ca-certificates and openssl pinned to their noble
# release versions (the snapshot service is https only and the base image
# has no CA bundle), then turns the snapshot on.
ARG APT_SNAPSHOT=20261107T000000Z

# The versions the server reports in /v1/health (AC-036). The Orca and
# OpenSCAD download URLs are built from them, so they cannot drift apart.
ARG ORCA_VERSION=2.5.0
ARG OPENSCAD_VERSION=2026.11-RC0

FROM --platform=linux/amd64 ${BASE} AS fetch
ARG APT_SNAPSHOT
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates=20240203 openssl=3.0.13-0ubuntu3 \
 && echo "APT::Snapshot \"${APT_SNAPSHOT}\";" > /etc/apt/apt.conf.d/50snapshot \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates openssl curl xz-utils git libatomic1 \
 && rm -rf /var/lib/apt/lists/*

# fetch URL FILE SHA256: download and refuse anything that does not match.
RUN printf '%s\n' \
      'fetch() { curl -fsSL --retry 3 -o "$2" "$1"; echo "$3  $2" | sha256sum -c -; }' \
      > /usr/local/lib/fetch.sh

# need TEST-ARGS [-- REASON]: a check that names itself when it fails.
COPY apps/slicer/docker/need.sh /usr/local/lib/need.sh

WORKDIR /dl

# OrcaSlicer, Ubuntu 24.04 AppImage, extracted (no FUSE in a container).
# chmod -R a+rX so the non-root user can read everything and run what has an
# execute bit (the gate's first CI build: "Permission denied" on
# libexec/orca-slicer-env). AppRun is a bash launcher that execs
# libexec/orca-slicer-env bin/orca-slicer. The AppImage ships its presets
# only as binary .opc caches; the JSON comes from Orca's source next.
ARG ORCA_VERSION
ARG ORCA_SHA256=d13eb0a9cd618ed080ab6b82c64c0a60c4501aac91e88d5ac2c3b526fb141a7c
RUN source /usr/local/lib/fetch.sh \
 && source /usr/local/lib/need.sh \
 && fetch "https://github.com/OrcaSlicer/OrcaSlicer/releases/download/v${ORCA_VERSION}/OrcaSlicer_Linux_AppImage_Ubuntu2404_V${ORCA_VERSION}.AppImage" orca.AppImage "$ORCA_SHA256" \
 && chmod +x orca.AppImage \
 && ./orca.AppImage --appimage-extract > /dev/null \
 && mv squashfs-root /opt/orca \
 && chmod -R a+rX /opt/orca \
 && rm orca.AppImage \
 && need -x /opt/orca/AppRun \
 && need -x /opt/orca/libexec/orca-slicer-env \
 && need -x /opt/orca/bin/orca-slicer \
 && need -d /opt/orca/lib/orca-runtime \
 && need -f /opt/orca/resources/profiles/BBL.opc \
 && need -f /opt/orca/resources/profiles/OrcaFilamentLibrary.opc

# Orca's BBL and OrcaFilamentLibrary profile JSON from OrcaSlicer's own
# source at the commit tag v2.5.0 points to (Jon's call, 2026-11-08: a
# lightweight tag on 40ecc66, resolved with git ls-remote). Fetched by that
# commit, shallow, blobless and sparse; git checks every object against its
# hash and HEAD is checked against the pin. A new Orca release means a new
# commit pin, resolved the same way (the daily update workflow, Task 25).
ARG ORCA_SRC_SHA=40ecc66f78ed72dc368e0c1ebe40d77f00cc8a19
ARG ORCA_SRC_REPO=https://github.com/OrcaSlicer/OrcaSlicer.git
RUN source /usr/local/lib/need.sh \
 && git init -q /dl/orca-src \
 && cd /dl/orca-src \
 && git remote add origin "$ORCA_SRC_REPO" \
 && git sparse-checkout set --no-cone /resources/profiles/BBL.json /resources/profiles/BBL/ /resources/profiles/OrcaFilamentLibrary.json /resources/profiles/OrcaFilamentLibrary/ \
 && git fetch -q --depth 1 --filter=blob:none origin "$ORCA_SRC_SHA" \
 && git -c advice.detachedHead=false checkout -q FETCH_HEAD \
 && need "$(git rev-parse HEAD)" = "$ORCA_SRC_SHA" \
 && mkdir /opt/orca-profiles \
 && mv resources/profiles/BBL.json resources/profiles/BBL resources/profiles/OrcaFilamentLibrary.json resources/profiles/OrcaFilamentLibrary /opt/orca-profiles/ \
 && cd /dl \
 && rm -rf /dl/orca-src \
 && chmod -R a+rX /opt/orca-profiles \
 && need -f /opt/orca-profiles/BBL.json \
 && need -d /opt/orca-profiles/BBL/machine \
 && need -d /opt/orca-profiles/BBL/process \
 && need -d /opt/orca-profiles/BBL/filament \
 && need -f /opt/orca-profiles/OrcaFilamentLibrary.json

# OpenSCAD Linux AppImage (the latest release candidate, Jon's call),
# extracted. AppRun is a symlink to usr/bin/openscad, whose RUNPATH finds the
# libraries bundled in usr/lib.
ARG OPENSCAD_VERSION
ARG OPENSCAD_SHA256=78c2050aedcf52cca0186151cdcda1118a771491e3bec934b3172d0b03a9de96
RUN source /usr/local/lib/fetch.sh \
 && source /usr/local/lib/need.sh \
 && fetch "https://github.com/openscad/openscad/releases/download/openscad-${OPENSCAD_VERSION}/OpenSCAD-${OPENSCAD_VERSION}-x86_64.AppImage" openscad.AppImage "$OPENSCAD_SHA256" \
 && chmod +x openscad.AppImage \
 && ./openscad.AppImage --appimage-extract > /dev/null \
 && mv squashfs-root /opt/openscad \
 && chmod -R a+rX /opt/openscad \
 && rm openscad.AppImage \
 && need -x /opt/openscad/AppRun \
 && need -x /opt/openscad/usr/bin/openscad

# landrun v0.1.17 (Linux Landlock), OpenSCAD's sandbox (AC-052).
ARG LANDRUN_URL=https://github.com/Zouuup/landrun/releases/download/v0.1.17/landrun-linux-amd64
ARG LANDRUN_SHA256=6ada66a06669e8994e174a7271af2db636308e55a0d6ec896cc7d326b46727f6
RUN source /usr/local/lib/fetch.sh \
 && fetch "$LANDRUN_URL" /opt/landrun "$LANDRUN_SHA256" \
 && chmod 0755 /opt/landrun

# Node.js 26.13.0, linux x64. It links libatomic.so.1 (installed above; the
# gate's Hades run 2 died without it), checked before Node first runs.
ARG NODE_URL=https://nodejs.org/dist/v26.13.0/node-v26.13.0-linux-x64.tar.xz
ARG NODE_SHA256=d28a96af6c38596f6d9d97c0ee531c13d238d757742387d1928de822d959e997
RUN source /usr/local/lib/fetch.sh \
 && fetch "$NODE_URL" node.tar.xz "$NODE_SHA256" \
 && mkdir /opt/node \
 && tar -xJf node.tar.xz -C /opt/node --strip-components=1 \
 && rm node.tar.xz
COPY apps/slicer/docker/check-libs.sh /usr/local/lib/check-libs.sh
RUN source /usr/local/lib/need.sh \
 && bash /usr/local/lib/check-libs.sh /opt/node/bin/node \
 && need "$(/opt/node/bin/node --version)" = v26.13.0

# pnpm 12.18.0 (the workspace's packageManager), from the npm registry
# tarball. Only the build stage uses it.
ARG PNPM_URL=https://registry.npmjs.org/pnpm/-/pnpm-12.18.0.tgz
ARG PNPM_SHA256=29d1d7d99bf6ec6d0a3dbb0ec5656f0d16e997e8be676ca45c581d11cb71f753
RUN source /usr/local/lib/fetch.sh \
 && source /usr/local/lib/need.sh \
 && fetch "$PNPM_URL" pnpm.tgz "$PNPM_SHA256" \
 && mkdir /opt/pnpm \
 && tar -xzf pnpm.tgz -C /opt/pnpm --strip-components=1 \
 && rm pnpm.tgz \
 && printf '#!/bin/sh\nexec /opt/node/bin/node /opt/pnpm/bin/pnpm.mjs "$@"\n' > /usr/local/bin/pnpm \
 && chmod 0755 /usr/local/bin/pnpm \
 && need "$(PATH=/opt/node/bin:$PATH pnpm --version)" = 12.18.0

# ---------------------------------------------------------------- build
# The slicer and the two workspace packages it uses, built with tsc, then
# reinstalled with production dependencies only.
FROM fetch AS build
ENV PATH=/opt/node/bin:/usr/local/bin:/usr/bin:/bin \
    npm_config_store_dir=/root/.pnpm-store
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/threemf/package.json packages/threemf/
COPY packages/slicer-contract/package.json packages/slicer-contract/
COPY apps/slicer/package.json apps/slicer/
RUN pnpm install --frozen-lockfile --filter "@platehouse/slicer..." --filter platehouse
COPY packages/threemf/tsconfig.json packages/threemf/
COPY packages/threemf/src packages/threemf/src
COPY packages/slicer-contract/tsconfig.json packages/slicer-contract/
COPY packages/slicer-contract/src packages/slicer-contract/src
COPY apps/slicer/tsconfig.json apps/slicer/
COPY apps/slicer/src apps/slicer/src
RUN node_modules/.bin/tsc -b apps/slicer \
 && rm -rf node_modules apps/slicer/node_modules packages/threemf/node_modules packages/slicer-contract/node_modules \
 && pnpm install --frozen-lockfile --prod --offline --filter "@platehouse/slicer..." \
 && rm -rf packages/*/src apps/slicer/src packages/*/dist/test apps/slicer/dist/test \
 && find . -name '*.tsbuildinfo' -delete \
 && chmod -R a+rX /src

# ---------------------------------------------------------------- runtime
FROM --platform=linux/amd64 ${BASE}
ARG APT_SNAPSHOT
ARG ORCA_VERSION
ARG OPENSCAD_VERSION
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]
ENV DEBIAN_FRONTEND=noninteractive

# Runtime libraries the two AppImages take from the host (Orca's
# scripts/appimage_lib_policy.sh: GL/EGL, X11, GTK 3, WebKitGTK 4.1,
# GStreamer, fontconfig, the C++ runtime), Mesa for EGL and software GL, GNU
# time (Orca's peak RSS for the contract), and libatomic1 for Node. No X
# server and no Xvfb: gate item (f) rendered OpenSCAD headless with EGL.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates=20240203 openssl=3.0.13-0ubuntu3 \
 && echo "APT::Snapshot \"${APT_SNAPSHOT}\";" > /etc/apt/apt.conf.d/50snapshot \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates openssl \
      time \
      libatomic1 \
      libgl1 libglx-mesa0 libgl1-mesa-dri libegl1 libegl-mesa0 libgles2 libopengl0 libglu1-mesa \
      libgtk-3-0t64 libwebkit2gtk-4.1-0 libgstreamer1.0-0 libgstreamer-plugins-base1.0-0 \
      libsecret-1-0 libsm6 libice6 libmspack0t64 \
      libfontconfig1 fontconfig fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

COPY --from=fetch /opt/orca /opt/orca
COPY --from=fetch /opt/orca-profiles /opt/orca-profiles
COPY --from=fetch /opt/openscad /opt/openscad
COPY --from=fetch /opt/node/bin/node /opt/node/bin/node
COPY --from=fetch /opt/landrun /usr/local/bin/landrun
COPY --from=build /src /opt/platehouse/app
COPY apps/slicer/docker/need.sh /usr/local/lib/need.sh
COPY apps/slicer/docker/check-libs.sh /usr/local/lib/check-libs.sh
RUN ln -s /opt/node/bin/node /usr/local/bin/node

# Fail the build, not a slice, when a shared library a program links is
# missing. Orca's check uses the library path its launcher sets.
RUN source /usr/local/lib/need.sh \
 && bash /usr/local/lib/check-libs.sh /opt/orca/bin/orca-slicer /opt/orca/lib/orca-runtime:/opt/orca/bin \
 && bash /usr/local/lib/check-libs.sh /opt/openscad/usr/bin/openscad \
 && bash /usr/local/lib/check-libs.sh /opt/node/bin/node \
 && need "$(node --version)" = v26.13.0 \
 && need -x /usr/local/bin/landrun \
 && need -f /opt/platehouse/app/apps/slicer/dist/src/server.js \
 && need -f /opt/platehouse/app/apps/slicer/node_modules/occt-import-js/dist/occt-import-js.wasm

# The profiles, flattened at build (see apps/slicer/src/profiles.ts):
# - the source JSON's versions must equal the .opc caches Orca ships
#   (BBL 02.08.00.16 = 2.8.0.16 on 2026-11-08), or the build fails;
# - Orca's process_full folder gets every instantiable machine's default
#   process, or the build fails naming the machine (gate run 3: code -3 on
#   every printer switch without it). Only that folder is added inside
#   BBL/: Orca still installs BBL from BBL.opc, and the checks fail the
#   build if the folder was already there or a BBL.json appears;
# - /opt/platehouse/profiles gets a flattened machine file per menu printer
#   and a generic filament per type, named in manifest.json.
RUN source /usr/local/lib/need.sh \
 && need ! -e /opt/orca/resources/profiles/BBL/process_full -- "the AppImage ships no process_full, so nothing of Orca's is replaced" \
 && node /opt/platehouse/app/apps/slicer/dist/src/profiles.js \
      --source /opt/orca-profiles \
      --shipped /opt/orca/resources/profiles \
      --out /opt/platehouse/profiles \
      --process-full /opt/orca/resources/profiles/BBL/process_full \
 && chmod -R a+rX /opt/orca/resources/profiles/BBL/process_full /opt/platehouse/profiles \
 && need -f "/opt/orca/resources/profiles/BBL/process_full/0.20mm Standard @BBL X1C.json" \
 && need -f /opt/platehouse/profiles/manifest.json \
 && need ! -e /opt/orca/resources/profiles/BBL.json -- "a BBL.json would make Orca install BBL from JSON instead of BBL.opc"

# A small STL outside every job folder: the container test imports it from a
# .scad to prove landrun blocks a read outside the job folder (AC-052).
RUN printf '%s\n' 'solid probe' \
      '  facet normal 0 0 1' '    outer loop' \
      '      vertex 0 0 0' '      vertex 10 0 0' '      vertex 0 10 0' \
      '    endloop' '  endfacet' 'endsolid probe' > /opt/platehouse/sandbox-probe.stl \
 && chmod 0644 /opt/platehouse/sandbox-probe.stl

RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin slicer
USER 10001

# The same checks as the slicer user: root passes test -x and -r on
# anything, so only these show the user can run the programs and read the
# files.
RUN source /usr/local/lib/need.sh \
 && need -x /opt/orca/AppRun \
 && need -x /opt/orca/libexec/orca-slicer-env \
 && need -x /opt/orca/bin/orca-slicer \
 && need -r /opt/orca/resources/profiles/BBL.opc \
 && need -r "/opt/orca/resources/profiles/BBL/process_full/0.20mm Standard @BBL X1C.json" \
 && need -x /opt/openscad/AppRun \
 && need -x /opt/openscad/usr/bin/openscad \
 && need -x /usr/local/bin/landrun \
 && need -x /opt/node/bin/node \
 && need -r /opt/platehouse/profiles/manifest.json \
 && need -r /opt/platehouse/app/apps/slicer/dist/src/server.js \
 && need -r /opt/platehouse/app/apps/slicer/node_modules/occt-import-js/dist/occt-import-js.wasm \
 && need -r /opt/platehouse/sandbox-probe.stl

# SLICE_PLATE_SECONDS from the gate (AC-035): twice the worst plate, 55.31 s,
# rounded up to 120. The server kills a plate at SLICE_TIMEOUT_SECONDS,
# default SLICE_PLATE_SECONDS + 60.
ENV NODE_ENV=production \
    PORT=8080 \
    HOME=/work \
    WORK_DIR=/work \
    PROFILES_DIR=/opt/platehouse/profiles \
    SLICE_PLATE_SECONDS=120 \
    ORCA_VERSION=${ORCA_VERSION} \
    OPENSCAD_VERSION=${OPENSCAD_VERSION}

WORKDIR /work
EXPOSE 8080

# AC-093: Docker marks the container unhealthy when /v1/health stops
# answering, so the fleet restart-loop alert sees it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=2s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ENTRYPOINT []
CMD ["node", "/opt/platehouse/app/apps/slicer/dist/src/server.js"]
