# Platehouse slicing gate image (build plan Task 1). Throwaway: platform-sre
# builds it on Hades for one gate run and deletes it afterwards. amd64 only.
#
# Every release file fetched below is pinned to an exact version and checked
# against the sha256 recorded here. The sha256 values were read from the GitHub release
# asset digests, the npm registry tarball (its sha512 integrity matched), the
# Node.js SHASUMS256.txt and a hash of the NIST archive, all on 2026-11-07.
# The OpenSCAD value also matches the .sha256 file published with that release.
# The one source checkout, Orca's profile JSON, is pinned by its git commit
# instead and checked by git (see that step).
#
# Build context: tools/slicing-gate
#   docker build --platform linux/amd64 -t platehouse-gate:t1 tools/slicing-gate

# ubuntu:24.04, multi-arch index digest read from Docker Hub on 2026-11-07
# (amd64 manifest sha256:78d4744ead1f5b19b04d0df558ab182a5300903900755e515b2ca4d10eb2044d).
ARG BASE=ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852

# Ubuntu snapshot every apt package is installed from. apt checks each package
# against the signed snapshot index. The snapshot service is https only and
# the base image carries no CA bundle, so each stage first installs
# ca-certificates and the openssl it depends on from the live archive, pinned
# to their versions in the noble release pocket, which never changes:
# ca-certificates 20240203 and openssl 3.0.13-0ubuntu3, read from
# dists/noble/main/binary-amd64/Packages on 2026-11-07. Its other dependencies,
# debconf and libssl3t64 (3.0.13-0ubuntu3.16), are already in the pinned base
# image (its var/lib/dpkg/status, read the same day). Once the snapshot is on,
# both are installed again, so the image keeps the snapshot's versions.
#
# Both stages run Node, and the Node 26 linux-x64 binary links libatomic.so.1,
# which the base image does not carry, so both install libatomic1 from the
# snapshot. Without it the second Hades run (2026-11-08) died at the fetch
# stage's first Node call with "libatomic.so.1: cannot open shared object
# file" (exit 127). Each stage runs check-libs.sh on /opt/node/bin/node before
# it first calls Node, so a missing library fails there, naming the library.
ARG APT_SNAPSHOT=20261107T000000Z

FROM --platform=linux/amd64 ${BASE} AS fetch
ARG APT_SNAPSHOT
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates=20240203 openssl=3.0.13-0ubuntu3 \
 && echo "APT::Snapshot \"${APT_SNAPSHOT}\";" > /etc/apt/apt.conf.d/50snapshot \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates openssl curl xz-utils unzip git libatomic1 \
 && rm -rf /var/lib/apt/lists/*

# fetch URL FILE SHA256: download and refuse anything that does not match.
RUN printf '%s\n' \
      'fetch() { curl -fsSL --retry 3 -o "$2" "$1"; echo "$3  $2" | sha256sum -c -; }' \
      > /usr/local/lib/fetch.sh

# need TEST-ARGS [-- REASON]: a check that names itself on stderr when it
# fails, so a failed step never exits 1 with no text (see need.sh).
COPY need.sh /usr/local/lib/need.sh

WORKDIR /dl

# OrcaSlicer v2.5.0, Ubuntu 24.04 AppImage (released 2026-11-07).
# Both AppImage trees get chmod -R a+rX after extraction: read for every user,
# and execute wherever any execute bit is already set. Without it the gate
# user could not run libexec/orca-slicer-env ("Permission denied", first CI
# build, 2026-11-08), while the checks here, run as root, passed.
# Layout read from this exact file's squashfs on 2026-11-08: AppRun is a bash
# launcher (mode 0755) that execs libexec/orca-slicer-env bin/orca-slicer, and
# the env script puts lib/orca-runtime and bin on LD_LIBRARY_PATH. There is no
# resources/profiles/BBL.json and no BBL/machine, process or filament JSON:
# every vendor's presets are packed into resources/profiles/<vendor>.opc, a
# binary preset cache (OrcaSlicer src/libslic3r/PresetCacheFormat.cpp), which
# flatten-profiles.mjs cannot read. The JSON comes from Orca's source in the
# next step; the .opc files stay as Orca shipped them, and their version
# stamps are checked against that JSON further down.
ARG ORCA_URL=https://github.com/OrcaSlicer/OrcaSlicer/releases/download/v2.5.0/OrcaSlicer_Linux_AppImage_Ubuntu2404_V2.5.0.AppImage
ARG ORCA_SHA256=d13eb0a9cd618ed080ab6b82c64c0a60c4501aac91e88d5ac2c3b526fb141a7c
RUN source /usr/local/lib/fetch.sh \
 && source /usr/local/lib/need.sh \
 && fetch "$ORCA_URL" orca.AppImage "$ORCA_SHA256" \
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

# Orca's BBL profile JSON, from OrcaSlicer's own source at the commit tag
# v2.5.0 points to (Jon's call, 2026-11-08; resolved with git ls-remote on
# 2026-11-08: a lightweight tag on 40ecc66f78ed72dc368e0c1ebe40d77f00cc8a19).
# It is fetched by that commit, never by the tag or a branch, shallow and
# without blobs, and only BBL.json, BBL/, OrcaFilamentLibrary.json and
# OrcaFilamentLibrary/ are checked out (about 17 MB). Git checks every object
# it receives against its hash, and the tree against the commit, so the
# checkout is that commit's content; HEAD is then checked against the pin.
# The JSON goes to /opt/orca-profiles, beside the AppImage, not inside it,
# so nothing shadows the .opc files Orca ships.
# Orca source tag v2.5.0 -> commit 40ecc66f78ed72dc368e0c1ebe40d77f00cc8a19
# (git ls-remote, 2026-11-08). The tag is recorded here, not as a build arg:
# only the commit is fetched, so a tag arg would be a setting nothing reads
# (issue #6). A new Orca release means a new commit pin, resolved the same way.
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
 && need -f /opt/orca-profiles/BBL.json \
 && need -d /opt/orca-profiles/BBL/machine \
 && need -d /opt/orca-profiles/BBL/process \
 && need -d /opt/orca-profiles/BBL/filament \
 && need -f /opt/orca-profiles/OrcaFilamentLibrary.json \
 && need -d /opt/orca-profiles/OrcaFilamentLibrary/filament

# OpenSCAD 2026.11-RC0 Linux AppImage (pre-release, Jon's call: latest RC).
# Layout read from this exact file's squashfs on 2026-11-08: AppRun is a
# symlink to usr/bin/openscad, an ELF binary whose RUNPATH ($ORIGIN/../lib)
# finds the libraries bundled in usr/lib.
ARG OPENSCAD_URL=https://github.com/openscad/openscad/releases/download/openscad-2026.11-RC0/OpenSCAD-2026.11-RC0-x86_64.AppImage
ARG OPENSCAD_SHA256=78c2050aedcf52cca0186151cdcda1118a771491e3bec934b3172d0b03a9de96
RUN source /usr/local/lib/fetch.sh \
 && source /usr/local/lib/need.sh \
 && fetch "$OPENSCAD_URL" openscad.AppImage "$OPENSCAD_SHA256" \
 && chmod +x openscad.AppImage \
 && ./openscad.AppImage --appimage-extract > /dev/null \
 && mv squashfs-root /opt/openscad \
 && chmod -R a+rX /opt/openscad \
 && rm openscad.AppImage \
 && need -x /opt/openscad/AppRun \
 && need -x /opt/openscad/usr/bin/openscad

# landrun v0.1.17.
ARG LANDRUN_URL=https://github.com/Zouuup/landrun/releases/download/v0.1.17/landrun-linux-amd64
ARG LANDRUN_SHA256=6ada66a06669e8994e174a7271af2db636308e55a0d6ec896cc7d326b46727f6
RUN source /usr/local/lib/fetch.sh \
 && fetch "$LANDRUN_URL" /opt/landrun "$LANDRUN_SHA256" \
 && chmod 0755 /opt/landrun

# Node.js 26.13.0, linux x64. Its libraries (libatomic.so.1 among them) are
# checked after the last download and before anything here runs it.
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

# check-libs.sh is copied in after the last download, so editing it reruns
# only the steps from here on and not every download (issue #8). It checks
# Node's libraries before the first Node call in this stage.
COPY check-libs.sh /opt/gate-build/check-libs.sh
RUN source /usr/local/lib/need.sh \
 && bash /opt/gate-build/check-libs.sh /opt/node/bin/node \
 && need "$(/opt/node/bin/node --version)" = v26.13.0

# The profile JSON must be the release the AppImage was built from: the version
# in each source <vendor>.json must equal the version stamped in the
# <vendor>.opc Orca ships (Orca writes it from that same field), or the build
# fails naming both. On 2026-11-08: BBL 02.08.00.16 = 2.8.0.16 and
# OrcaFilamentLibrary 02.04.00.26 = 2.4.0.26.
COPY check-profile-version.mjs /opt/gate-build/check-profile-version.mjs
COPY lib/is-main.mjs /opt/gate-build/lib/is-main.mjs
RUN /opt/node/bin/node /opt/gate-build/check-profile-version.mjs /opt/orca/resources/profiles/BBL.opc /opt/orca-profiles/BBL.json \
 && /opt/node/bin/node /opt/gate-build/check-profile-version.mjs /opt/orca/resources/profiles/OrcaFilamentLibrary.opc /opt/orca-profiles/OrcaFilamentLibrary.json

FROM --platform=linux/amd64 ${BASE}
ARG APT_SNAPSHOT
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]
ENV DEBIAN_FRONTEND=noninteractive

# Runtime libraries the two AppImages take from the host (Orca's
# scripts/appimage_lib_policy.sh lists GL/EGL, X11, GTK 3, WebKitGTK 4.1,
# GStreamer, fontconfig and the C++ runtime), Mesa for EGL and software GL,
# GNU time, and libatomic1 for Node (see APT_SNAPSHOT). No X server and no
# Xvfb.
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
COPY --from=fetch /opt/node /opt/node
COPY --from=fetch /opt/landrun /usr/local/bin/landrun
COPY --from=fetch /opt/gate /opt/gate
COPY gate.mjs flatten-profiles.mjs select-sample.mjs check-libs.sh /opt/gate/
COPY lib/ /opt/gate/lib/
COPY need.sh /usr/local/lib/need.sh
RUN ln -s /opt/node/bin/node /usr/local/bin/node

# Fail the build, not the run, when a shared library either program links is
# missing from the image. Orca's AppRun is a bash launcher, so the check runs
# on the real binary with the library path the launcher's orca-slicer-env sets
# (lib/orca-runtime, then bin). OpenSCAD's AppRun is a symlink to
# usr/bin/openscad, which finds its bundled libraries through its RUNPATH.
# check-libs.sh also fails when ldd itself fails, so it cannot pass without
# checking anything. Node's libraries are checked again here, in the stage
# the gate runs in, before node is first called. occt-import-js's
# package.json main is dist/occt-import-js.js, which loads
# dist/occt-import-js.wasm beside it.
RUN source /usr/local/lib/need.sh \
 && bash /opt/gate/check-libs.sh /opt/orca/bin/orca-slicer /opt/orca/lib/orca-runtime:/opt/orca/bin \
 && need -x /opt/openscad/usr/bin/openscad \
 && bash /opt/gate/check-libs.sh /opt/openscad/usr/bin/openscad \
 && bash /opt/gate/check-libs.sh /opt/node/bin/node \
 && need "$(node --version)" = v26.13.0 \
 && need -x /usr/local/bin/landrun \
 && need -f /opt/gate/node_modules/occt-import-js/dist/occt-import-js.js \
 && need -f /opt/gate/node_modules/occt-import-js/dist/occt-import-js.wasm

# Orca's process_full folder (Hades run 3, 2026-11-08: 79 plates failed with
# code -3). When a file is sliced on another printer and the extruder variant
# count changes (P1S and X1C presets carry two print variants, A1 one),
# Orca 2.5.0's CLI (src/OrcaSlicer.cpp, machine_switch) loads
# <resources>/profiles/BBL/process_full/<the new printer's default_print_profile>.json.
# <resources> is the binary's ../../resources, here /opt/orca/resources, and
# no flag or data dir moves it. The AppImage ships no such folder. Orca wants a
# flattened preset there (type process, from system, no inherits: it can only
# resolve inherits through a BBL.json manifest the AppImage does not ship), so
# flatten-profiles.mjs writes one per machine preset's default process from
# the pinned source JSON. Only a new folder is added inside BBL/: Orca finds
# vendors by the <vendor>.json and <vendor>.opc files directly under
# profiles/, so BBL is still installed from BBL.opc, and the checks below fail
# the build if a BBL.json appears or if the folder was already there.
# Read on 2026-11-08 from OrcaSlicer.cpp, PresetBundle.cpp and utils.cpp
# (vendor_names_in) at commit 40ecc66.
RUN source /usr/local/lib/need.sh \
 && need -f /opt/orca/resources/profiles/BBL.opc \
 && need ! -e /opt/orca/resources/profiles/BBL/process_full -- "the AppImage ships no process_full, so nothing of Orca's is replaced" \
 && node /opt/gate/flatten-profiles.mjs --profiles /opt/orca-profiles --process-full /opt/orca/resources/profiles/BBL/process_full \
 && chmod -R a+rX /opt/orca/resources/profiles/BBL/process_full \
 && need -f "/opt/orca/resources/profiles/BBL/process_full/0.20mm Standard @BBL A1.json" \
 && need -f "/opt/orca/resources/profiles/BBL/process_full/0.20mm Standard @BBL X1C.json" \
 && need ! -e /opt/orca/resources/profiles/BBL.json -- "a BBL.json would make Orca install BBL from JSON instead of BBL.opc"

RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin gate
USER 10001

# The same checks again as the gate user. Every check above runs as root,
# and root passes test -x on any execute bit and test -r on any file, so
# only these show the gate user can start the programs and read its files.
RUN source /usr/local/lib/need.sh \
 && need -x /opt/orca/AppRun \
 && need -x /opt/orca/libexec/orca-slicer-env \
 && need -x /opt/orca/bin/orca-slicer \
 && need -r /opt/orca/resources/profiles/BBL.opc \
 && need -r "/opt/orca/resources/profiles/BBL/process_full/0.20mm Standard @BBL A1.json" \
 && need -r "/opt/orca/resources/profiles/BBL/process_full/0.20mm Standard @BBL X1C.json" \
 && need -x /opt/openscad/AppRun \
 && need -x /opt/openscad/usr/bin/openscad \
 && need -x /usr/local/bin/landrun \
 && need -x /opt/node/bin/node \
 && need -r /opt/orca-profiles/BBL.json \
 && need -r /opt/orca-profiles/OrcaFilamentLibrary.json \
 && need -r /opt/gate/gate.mjs \
 && need -r /opt/gate/node_modules/occt-import-js/dist/occt-import-js.wasm

WORKDIR /work
ENTRYPOINT []
CMD ["node", "/opt/gate/gate.mjs"]
