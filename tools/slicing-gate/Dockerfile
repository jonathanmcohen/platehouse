# syntax=docker/dockerfile:1
#
# Platehouse slicing gate image (build plan Task 1). Throwaway: platform-sre
# builds it on Hades for one gate run and deletes it afterwards. amd64 only.
#
# Every download is pinned to an exact version and checked against the
# sha256 recorded here. The sha256 values were read from the GitHub release
# asset digests, the npm registry tarball (its sha512 integrity matched), the
# Node.js SHASUMS256.txt and a hash of the NIST archive, all on 2026-11-07.
# The OpenSCAD value also matches the .sha256 file published with that release.
#
# Build context: tools/slicing-gate
#   docker build --platform linux/amd64 -t platehouse-gate:t1 tools/slicing-gate

# ubuntu:24.04, multi-arch index digest read from Docker Hub on 2026-11-07
# (amd64 manifest sha256:78d4744ead1f5b19b04d0df558ab182a5300903900755e515b2ca4d10eb2044d).
ARG BASE=ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852

# Ubuntu snapshot every apt package is installed from. apt checks each package
# against the signed snapshot index. ca-certificates alone comes from the live
# archive first, because the snapshot service is https only and the base image
# carries no CA bundle.
ARG APT_SNAPSHOT=20261107T000000Z

FROM --platform=linux/amd64 ${BASE} AS fetch
ARG APT_SNAPSHOT
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && echo "APT::Snapshot \"${APT_SNAPSHOT}\";" > /etc/apt/apt.conf.d/50snapshot \
 && apt-get update \
 && apt-get install -y --no-install-recommends curl xz-utils unzip \
 && rm -rf /var/lib/apt/lists/*

# fetch URL FILE SHA256: download and refuse anything that does not match.
RUN printf '%s\n' \
      'fetch() { curl -fsSL --retry 3 -o "$2" "$1"; echo "$3  $2" | sha256sum -c -; }' \
      > /usr/local/lib/fetch.sh

WORKDIR /dl

# OrcaSlicer v2.5.0, Ubuntu 24.04 AppImage (released 2026-11-07).
ARG ORCA_URL=https://github.com/OrcaSlicer/OrcaSlicer/releases/download/v2.5.0/OrcaSlicer_Linux_AppImage_Ubuntu2404_V2.5.0.AppImage
ARG ORCA_SHA256=d13eb0a9cd618ed080ab6b82c64c0a60c4501aac91e88d5ac2c3b526fb141a7c
RUN source /usr/local/lib/fetch.sh \
 && fetch "$ORCA_URL" orca.AppImage "$ORCA_SHA256" \
 && chmod +x orca.AppImage \
 && ./orca.AppImage --appimage-extract > /dev/null \
 && mv squashfs-root /opt/orca \
 && rm orca.AppImage \
 && test -x /opt/orca/AppRun \
 && test -f /opt/orca/resources/profiles/BBL.json

# OpenSCAD 2026.11-RC0 Linux AppImage (pre-release, Jon's call: latest RC).
ARG OPENSCAD_URL=https://github.com/openscad/openscad/releases/download/openscad-2026.11-RC0/OpenSCAD-2026.11-RC0-x86_64.AppImage
ARG OPENSCAD_SHA256=78c2050aedcf52cca0186151cdcda1118a771491e3bec934b3172d0b03a9de96
RUN source /usr/local/lib/fetch.sh \
 && fetch "$OPENSCAD_URL" openscad.AppImage "$OPENSCAD_SHA256" \
 && chmod +x openscad.AppImage \
 && ./openscad.AppImage --appimage-extract > /dev/null \
 && mv squashfs-root /opt/openscad \
 && rm openscad.AppImage \
 && test -e /opt/openscad/AppRun

# landrun v0.1.17.
ARG LANDRUN_URL=https://github.com/Zouuup/landrun/releases/download/v0.1.17/landrun-linux-amd64
ARG LANDRUN_SHA256=6ada66a06669e8994e174a7271af2db636308e55a0d6ec896cc7d326b46727f6
RUN source /usr/local/lib/fetch.sh \
 && fetch "$LANDRUN_URL" /opt/landrun "$LANDRUN_SHA256" \
 && chmod 0755 /opt/landrun

# Node.js 26.13.0, linux x64.
ARG NODE_URL=https://nodejs.org/dist/v26.13.0/node-v26.13.0-linux-x64.tar.xz
ARG NODE_SHA256=d28a96af6c38596f6d9d97c0ee531c13d238d757742387d1928de822d959e997
RUN source /usr/local/lib/fetch.sh \
 && fetch "$NODE_URL" node.tar.xz "$NODE_SHA256" \
 && mkdir /opt/node \
 && tar -xJf node.tar.xz -C /opt/node --strip-components=1 \
 && rm node.tar.xz

# occt-import-js 0.0.23 from the npm registry (no runtime dependencies).
ARG OCCT_URL=https://registry.npmjs.org/occt-import-js/-/occt-import-js-0.0.23.tgz
ARG OCCT_SHA256=eaab9ca7bf02799360d8fc70468dc8bf78eb2073c3fafb1ff982006e558fc1f3
RUN source /usr/local/lib/fetch.sh \
 && fetch "$OCCT_URL" occt.tgz "$OCCT_SHA256" \
 && mkdir -p /opt/gate/node_modules/occt-import-js \
 && tar -xzf occt.tgz -C /opt/gate/node_modules/occt-import-js --strip-components=1 \
 && rm occt.tgz

# One public STEP sample for report item (h): NIST MBE PMI test case CTC-01,
# geometry only, from NIST's STEP file archive (published 2024-06-19; NIST
# allows use without restriction). The archive and the extracted file are
# both checked.
ARG NIST_URL=https://www.nist.gov/system/files/documents/noindex/2024/06/19/NIST-PMI-STEP-Files.zip
ARG NIST_SHA256=8fa78429e6d8d9b0d7681d223b6aa9ec98c3772185c55b1a0e3679b21c181911
ARG NIST_STEP_SHA256=e081d518484d5c708c6729353237f94a7d97da2b74a10d60d4c0d146d67a5855
RUN source /usr/local/lib/fetch.sh \
 && fetch "$NIST_URL" nist.zip "$NIST_SHA256" \
 && mkdir -p /opt/gate/samples \
 && unzip -j -q nist.zip 'NIST-PMI-STEP-Files/AP203 geometry only/nist_ctc_01_asme1_rd.stp' -d /opt/gate/samples \
 && echo "$NIST_STEP_SHA256  /opt/gate/samples/nist_ctc_01_asme1_rd.stp" | sha256sum -c - \
 && rm nist.zip

# The file the landrun check tries to import from outside its own directory.
RUN printf '%s\n' 'solid outside' \
      '  facet normal 0 0 1' '    outer loop' \
      '      vertex 0 0 0' '      vertex 10 0 0' '      vertex 0 10 0' \
      '    endloop' '  endfacet' 'endsolid outside' > /opt/gate/samples/outside.stl

FROM --platform=linux/amd64 ${BASE}
ARG APT_SNAPSHOT
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]
ENV DEBIAN_FRONTEND=noninteractive

# Runtime libraries the two AppImages take from the host (Orca's
# scripts/appimage_lib_policy.sh lists GL/EGL, X11, GTK 3, WebKitGTK 4.1,
# GStreamer, fontconfig and the C++ runtime), Mesa for EGL and software GL,
# and GNU time. No X server and no Xvfb.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && echo "APT::Snapshot \"${APT_SNAPSHOT}\";" > /etc/apt/apt.conf.d/50snapshot \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      time \
      libgl1 libglx-mesa0 libgl1-mesa-dri libegl1 libegl-mesa0 libgles2 libopengl0 libglu1-mesa \
      libgtk-3-0t64 libwebkit2gtk-4.1-0 libgstreamer1.0-0 libgstreamer-plugins-base1.0-0 \
      libsecret-1-0 libsm6 libice6 libmspack0t64 \
      libfontconfig1 fontconfig fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

COPY --from=fetch /opt/orca /opt/orca
COPY --from=fetch /opt/openscad /opt/openscad
COPY --from=fetch /opt/node /opt/node
COPY --from=fetch /opt/landrun /usr/local/bin/landrun
COPY --from=fetch /opt/gate /opt/gate
COPY gate.mjs flatten-profiles.mjs select-sample.mjs /opt/gate/
COPY lib/ /opt/gate/lib/
RUN ln -s /opt/node/bin/node /usr/local/bin/node

# Fail the build, not the run, when a shared library either program links is
# missing from the image.
RUN missing="$(ldd /opt/orca/AppRun | grep 'not found' || true)" \
 && scad_bin="$(find /opt/openscad -path '*/bin/openscad' -type f | head -n 1)" \
 && test -n "$scad_bin" \
 && missing="${missing}$(ldd "$scad_bin" | grep 'not found' || true)" \
 && if [ -n "$missing" ]; then echo "missing shared libraries:"; echo "$missing"; exit 1; fi \
 && node --version | grep -qx 'v26.13.0' \
 && test -x /usr/local/bin/landrun \
 && test -f /opt/gate/node_modules/occt-import-js/dist/occt-import-js.js

RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin gate
USER 10001
WORKDIR /work
ENTRYPOINT []
CMD ["node", "/opt/gate/gate.mjs"]
