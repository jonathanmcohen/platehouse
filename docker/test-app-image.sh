#!/usr/bin/env bash
# Runs the app image (docker/app.Dockerfile) the way Hades will, against a
# throwaway Postgres 17 and the S3 test server on a private Docker network,
# and checks what it reports (build plan Task 24; AC-093, issues #31, #162).
#
#   docker/test-app-image.sh IMAGE healthy
#     The container's own HEALTHCHECK, as the image defines it, reports
#     healthy; GET /healthz answers 200; every migration file shipped in the
#     image (apps/server/dist/src/db/migrations, beside the built migrate.js)
#     is recorded in schema_migrations, and they are the files in
#     apps/server/src/db/migrations when run from a checkout; the server runs
#     as a non-root user; and no apps/importer or test folder is in the image.
#
#   docker/test-app-image.sh IMAGE unhealthy
#     For an image built without apps/web/dist: the server starts and keeps
#     running, GET /healthz answers 503, the log says the web app is not
#     built, and the container's HEALTHCHECK reports unhealthy. Only the
#     check's timing is changed for this run (start period 10 s, every 3 s,
#     3 retries) so it shows within seconds; its command is the image's own.
#
# Every credential is random for this run and exists only inside these
# containers; nothing reads a real secret or reaches a real store. Values go
# to docker run by name (-e NAME), never on a command line. The containers and
# the network are removed on exit, pass or fail.
set -euo pipefail

image="${1:?usage: test-app-image.sh IMAGE healthy|unhealthy}"
mode="${2:?usage: test-app-image.sh IMAGE healthy|unhealthy}"
case "$mode" in healthy | unhealthy) ;; *) echo "mode must be healthy or unhealthy" >&2; exit 2 ;; esac

# The images the integration suite pins (apps/server/test/integration/support/containers.ts).
POSTGRES_IMAGE=postgres:17-alpine
S3_IMAGE=pgsty/minio:RELEASE.2026-08-04T00-00-00Z

run="ph-image-$$-${RANDOM}"
net="$run-net"
db="$run-db"
s3="$run-s3"
app="$run-app"

fail() {
  echo "::error::$*"
  exit 1
}

cleanup() {
  local status=$?
  if [ "$status" -ne 0 ] && docker inspect "$app" >/dev/null 2>&1; then
    echo "---- app container state"
    docker inspect --format '{{json .State}}' "$app" || true
    echo "---- app log (last 200 lines)"
    docker logs --tail 200 "$app" 2>&1 || true
  fi
  docker rm -f "$app" "$s3" "$db" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

# until_ok SECONDS DESCRIPTION COMMAND...: runs COMMAND every second until it
# succeeds, or fails naming DESCRIPTION.
until_ok() {
  local limit="$1" what="$2"
  shift 2
  local end=$((SECONDS + limit))
  until "$@" >/dev/null 2>&1; do
    [ "$SECONDS" -lt "$end" ] || fail "timed out after ${limit}s waiting for ${what}"
    sleep 1
  done
}

secret() { openssl rand -hex "$1"; }

export POSTGRES_PASSWORD S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY MINIO_ROOT_USER MINIO_ROOT_PASSWORD
POSTGRES_PASSWORD="$(secret 16)"
S3_ACCESS_KEY_ID="ph$(secret 8)"
S3_SECRET_ACCESS_KEY="$(secret 24)"
MINIO_ROOT_USER="$S3_ACCESS_KEY_ID"
MINIO_ROOT_PASSWORD="$S3_SECRET_ACCESS_KEY"
if [ -n "${GITHUB_ACTIONS:-}" ]; then
  echo "::add-mask::$POSTGRES_PASSWORD"
  echo "::add-mask::$S3_SECRET_ACCESS_KEY"
fi

echo "== image $image"
docker image inspect --format 'size {{.Size}} bytes, user {{.Config.User}}, healthcheck {{json .Config.Healthcheck}}' "$image"

docker network create "$net" >/dev/null

docker run -d --name "$db" --network "$net" --network-alias db \
  -e POSTGRES_PASSWORD -e POSTGRES_DB=platehouse "$POSTGRES_IMAGE" >/dev/null
docker run -d --name "$s3" --network "$net" --network-alias s3 -p 127.0.0.1::9000 \
  -e MINIO_ROOT_USER -e MINIO_ROOT_PASSWORD "$S3_IMAGE" server /data >/dev/null

# Postgres's first start runs initdb on a socket-only server, then restarts;
# a TCP answer on 127.0.0.1 is the real server.
until_ok 90 "Postgres" docker exec "$db" pg_isready -h 127.0.0.1 -U postgres -d platehouse
s3_port="$(docker port "$s3" 9000/tcp | head -n 1 | sed 's/.*://')"
until_ok 90 "the S3 test server" curl -fsS "http://127.0.0.1:${s3_port}/minio/health/live"

export DATABASE_URL PUBLIC_ORIGIN S3_ENDPOINT S3_REGION S3_BUCKET S3_FORCE_PATH_STYLE \
  OIDC_CLIENT_ID OIDC_CLIENT_SECRET LINK_SECRET
DATABASE_URL="postgres://postgres:${POSTGRES_PASSWORD}@db:5432/platehouse"
PUBLIC_ORIGIN=https://platehouse.test
S3_ENDPOINT=http://s3:9000
S3_REGION=us-east-1
S3_BUCKET=platehouse-image-check
S3_FORCE_PATH_STYLE=true
OIDC_CLIENT_ID=platehouse-image-check
OIDC_CLIENT_SECRET="$(secret 16)"
LINK_SECRET="$(secret 32)"
s3_env=(-e S3_ENDPOINT -e S3_REGION -e S3_BUCKET -e S3_ACCESS_KEY_ID -e S3_SECRET_ACCESS_KEY)

# The bucket, made with the image's own Node and AWS SDK, so the image's
# client reaches the store over the network as the server will.
docker run --rm --network "$net" "${s3_env[@]}" -w /app/apps/server --entrypoint node "$image" \
  --input-type=module -e "
    import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
    const e = process.env;
    const client = new S3Client({ endpoint: e.S3_ENDPOINT, region: e.S3_REGION, forcePathStyle: true,
      credentials: { accessKeyId: e.S3_ACCESS_KEY_ID, secretAccessKey: e.S3_SECRET_ACCESS_KEY } });
    await client.send(new CreateBucketCommand({ Bucket: e.S3_BUCKET }));
    client.destroy();
    console.log('bucket made');"

health_args=()
if [ "$mode" = unhealthy ]; then
  health_args=(--health-start-period=10s --health-interval=3s --health-retries=3)
fi
docker run -d --name "$app" --network "$net" -p 127.0.0.1::3000 "${health_args[@]}" \
  -e DATABASE_URL -e PUBLIC_ORIGIN "${s3_env[@]}" -e S3_FORCE_PATH_STYLE \
  -e OIDC_CLIENT_ID -e OIDC_CLIENT_SECRET -e LINK_SECRET "$image" >/dev/null
app_port="$(docker port "$app" 3000/tcp | head -n 1 | sed 's/.*://')"

health() { docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$app"; }
running() { [ "$(docker inspect --format '{{.State.Running}}' "$app")" = true ]; }
healthz() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${app_port}/healthz" || true; }

want="$mode"
end=$((SECONDS + 180))
while :; do
  running || fail "the app container stopped (health $(health))"
  status="$(health)"
  [ "$status" = "$want" ] && break
  if [ "$want" = healthy ] && [ "$status" = unhealthy ]; then
    fail "the HEALTHCHECK reported unhealthy"
  fi
  if [ "$want" = unhealthy ] && [ "$status" = healthy ]; then
    fail "the HEALTHCHECK reported healthy without the web build"
  fi
  [ "$SECONDS" -lt "$end" ] || fail "timed out waiting for the HEALTHCHECK to report ${want} (last: ${status})"
  sleep 2
done
echo "== HEALTHCHECK reports ${status} after ${SECONDS}s"
docker inspect --format '{{range .State.Health.Log}}{{.ExitCode}} {{end}}' "$app" | sed 's/^/   check exit codes: /'

code="$(healthz)"
uid="$(docker exec "$app" id -u)"
echo "== GET /healthz: ${code}; the server runs as uid ${uid}"
[ "$uid" != 0 ] || fail "the server runs as root"

if [ "$mode" = unhealthy ]; then
  [ "$code" = 503 ] || fail "GET /healthz answered ${code}, not 503, without the web build"
  # Read whole, then searched: grep -q on a pipe can close it early, and under
  # pipefail the SIGPIPE would fail a check that passed (issue #9).
  log="$(docker logs "$app" 2>&1)"
  grep -q 'The web app is not built' <<<"$log" || fail "the log does not say the web app is not built"
  sleep 3
  running || fail "the app container stopped"
  echo "== without apps/web/dist: running, /healthz 503, the log names the missing build, HEALTHCHECK unhealthy"
  exit 0
fi

[ "$code" = 200 ] || fail "GET /healthz answered ${code}, not 200"

# The migrations: what the image ships beside migrate.js, what the server
# applied, and (from a checkout) what the repo holds, all the same list.
shipped="$(docker exec "$app" ls /app/apps/server/dist/src/db/migrations | sort)"
applied="$(docker exec "$db" psql -U postgres -d platehouse -tAc 'select name from schema_migrations order by name')"
echo "== migrations shipped: $(echo "$shipped" | tr '\n' ' ')"
echo "== migrations applied: $(echo "$applied" | tr '\n' ' ')"
[ -n "$shipped" ] || fail "the image ships no migrations"
[ "$shipped" = "$applied" ] || fail "the applied migrations are not the shipped ones"
here="$(cd "$(dirname "$0")/.." && pwd)"
if [ -d "$here/apps/server/src/db/migrations" ]; then
  repo="$(ls "$here/apps/server/src/db/migrations" | sort)"
  [ "$repo" = "$shipped" ] || fail "the image's migrations are not the repo's"
  echo "== the image's migrations are the repo's"
fi

# What must never be in the image.
docker exec "$app" bash -c 'test ! -e /app/apps/importer' || fail "apps/importer is in the image"
tests="$(docker exec "$app" bash -c 'find /app -path /app/node_modules -prune -o -type d \( -name test -o -name tests \) -print')"
[ -z "$tests" ] || fail "test folders are in the image: ${tests}"
echo "== no apps/importer and no test folder in the image"
echo "== healthy: HEALTHCHECK healthy, /healthz 200, migrations applied from the built layout"
