#!/usr/bin/env bash
# Starts the end-to-end stack (build plan Task 22) for this run.
#
# 1. Makes a throwaway TLS CA and one certificate for platehouse.e2e.test and
#    id.e2e.test, which Traefik serves and the app trusts for the issuer.
# 2. Makes every secret the stack needs (database and S3 passwords, the OIDC
#    client secret, LINK_SECRET) with openssl rand. Under GitHub Actions each
#    is masked first, so no log line can show it.
# 3. Writes them to an env file outside the repo and starts compose with it,
#    waiting until every service is healthy.
#
# Needs: docker with compose, openssl, the workspace installed (pnpm install)
# and the web app built (pnpm --filter @platehouse/web build), and both host
# names resolving to 127.0.0.1 (see e2e/README.md). Prints where the env file
# is; stop the stack with:
#   docker compose -f e2e/compose.yml --env-file <that file> down -v
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dir="${E2E_DIR:-${RUNNER_TEMP:-/tmp}/platehouse-e2e}"
certs="$dir/certs"
env_file="$dir/e2e.env"
case "$dir" in
  */platehouse-e2e | */e2e-run) ;;
  *)
    echo "E2E_DIR must end in /platehouse-e2e or /e2e-run (it is emptied first): $dir" >&2
    exit 1
    ;;
esac
rm -rf "$dir"
mkdir -p "$certs"
chmod 700 "$dir"

if [ ! -f "$here/../apps/web/dist/index.html" ]; then
  echo "The web app is not built: run pnpm --filter @platehouse/web build first." >&2
  exit 1
fi

# A throwaway CA, valid for two days, and a server certificate it signs.
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -sha256 \
  -subj "/CN=Platehouse e2e throwaway CA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -addext "subjectKeyIdentifier=hash" \
  -keyout "$certs/ca-key.pem" -out "$certs/ca.pem" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -sha256 \
  -subj "/CN=platehouse.e2e.test" \
  -keyout "$certs/server-key.pem" -out "$certs/server.csr" 2>/dev/null
cat >"$certs/server.ext" <<'EOF'
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:platehouse.e2e.test, DNS:id.e2e.test
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid, issuer
EOF
openssl x509 -req -in "$certs/server.csr" -CA "$certs/ca.pem" -CAkey "$certs/ca-key.pem" \
  -CAcreateserial -days 2 -sha256 -extfile "$certs/server.ext" -out "$certs/server.pem" 2>/dev/null
rm -f "$certs/ca-key.pem" "$certs/server.csr" "$certs/server.ext" "$certs/ca.srl"
# Traefik and the app run as root in their containers; the key stays readable
# only to its owner on the host.
chmod 644 "$certs/ca.pem" "$certs/server.pem"
chmod 600 "$certs/server-key.pem"
chmod 755 "$certs"

db_password="$(openssl rand -hex 24)"
s3_access_key="ph$(openssl rand -hex 8)"
s3_secret_key="$(openssl rand -hex 24)"
oidc_secret="$(openssl rand -hex 24)"
link_secret="$(openssl rand -hex 32)"
if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  for value in "$db_password" "$s3_access_key" "$s3_secret_key" "$oidc_secret" "$link_secret"; do
    echo "::add-mask::${value}"
  done
fi

umask 077
{
  echo "E2E_CERTS_DIR=$certs"
  echo "E2E_DB_PASSWORD=$db_password"
  echo "E2E_S3_ACCESS_KEY_ID=$s3_access_key"
  echo "E2E_S3_SECRET_ACCESS_KEY=$s3_secret_key"
  echo "E2E_OIDC_CLIENT_SECRET=$oidc_secret"
  echo "E2E_LINK_SECRET=$link_secret"
} >"$env_file"
umask 022

if [ -n "${GITHUB_ENV:-}" ]; then echo "E2E_ENV_FILE=$env_file" >>"$GITHUB_ENV"; fi
echo "e2e env file: $env_file"

compose=(docker compose -f "$here/compose.yml" --env-file "$env_file")
"${compose[@]}" pull --quiet
if ! "${compose[@]}" up -d --wait --wait-timeout 300; then
  echo "::error::The e2e stack did not become healthy"
  "${compose[@]}" ps -a
  "${compose[@]}" logs --no-color --tail 200
  exit 1
fi
"${compose[@]}" ps
