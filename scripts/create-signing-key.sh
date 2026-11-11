#!/usr/bin/env bash
# Create auto-apk's signing key and store it in Infisical (project auto-apk, env prod,
# folder /signing). Run by the owner, once. No secret is printed, passed on a command
# line, or written anywhere except a private temp dir (deleted), Infisical, and the
# backup folder below.
#
#   scripts/create-signing-key.sh            # create, test-sign, upload, back up
#   DRY_RUN=1 scripts/create-signing-key.sh  # create and test-sign only; keep nothing
#
# Needs: keytool and apksigner on PATH, openssl, npx. The Infisical CLI asks you to
# log in (browser) the first time.
#
# Replacing the key later means every install must be uninstalled once, so this
# refuses to run when Infisical already holds a keystore.
set -euo pipefail
umask 077

PROJECT_ID=${INFISICAL_PROJECT_ID:-ee4293a1-4d86-4d19-888b-4ce00d17b753}
ENV_SLUG=prod
FOLDER=/signing
ALIAS=auto-apk
BACKUP_DIR=${BACKUP_DIR:-$HOME/keys/auto-apk}
INFISICAL=(npx --yes @infisical/cli@0.45.6)
cd "$(dirname "$0")/.."

for tool in keytool apksigner openssl base64 sha256sum; do
  command -v "$tool" >/dev/null || { echo "missing: $tool" >&2; exit 1; }
done

if [ -z "${DRY_RUN:-}" ]; then
  echo "== Infisical login (opens a browser if needed)"
  "${INFISICAL[@]}" login --silent
  existing=$("${INFISICAL[@]}" secrets get KEYSTORE_BASE64 --projectId "$PROJECT_ID" --env "$ENV_SLUG" \
    --path "$FOLDER" --plain --silent 2>/dev/null || true)
  if [ -n "$existing" ]; then
    echo "Infisical already has KEYSTORE_BASE64 in $FOLDER. Not replacing it." >&2
    echo "Delete it in the dashboard first if you really mean to start over." >&2
    exit 1
  fi
fi

work=$(mktemp -d)
cleanup() { find "$work" -type f -exec shred -u {} + 2>/dev/null || true; rm -rf "$work"; }
trap cleanup EXIT

echo "== Generating the key (RSA 4096, PKCS12, valid 100 years)"
PW=$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 40)
export PW
# PKCS12 uses one password for the store and the key.
keytool -genkeypair -noprompt \
  -storetype PKCS12 -keystore "$work/auto-apk.p12" -storepass:env PW -keypass:env PW \
  -alias "$ALIAS" -keyalg RSA -keysize 4096 -sigalg SHA256withRSA -validity 36500 \
  -dname "CN=auto-apk" >/dev/null 2>&1

echo "== Test-signing an APK"
test_apk=$(ls out/*/patched-unsigned.apk work/fixtures/*.apk 2>/dev/null | head -1 || true)
[ -n "$test_apk" ] || { echo "no APK to test with (build one first: bun src/main.ts build --app x)" >&2; exit 1; }
apksigner sign --ks "$work/auto-apk.p12" --ks-pass env:PW --ks-key-alias "$ALIAS" --key-pass env:PW \
  --out "$work/test-signed.apk" "$test_apk"
apksigner verify --print-certs "$work/test-signed.apk" >"$work/verify.txt" || { echo "verification failed" >&2; exit 1; }
cert=$(grep -v '^Source Stamp' "$work/verify.txt" | sed -n 's/.*certificate SHA-256 digest: //p' | head -1)
[ -n "$cert" ] || { echo "no signer certificate in apksigner output" >&2; exit 1; }
echo "   signed and verified $test_apk"
echo "   certificate SHA-256: $cert"

if [ -n "${DRY_RUN:-}" ]; then
  echo "== DRY_RUN: nothing uploaded, nothing kept"
  exit 0
fi

echo "== Uploading to Infisical ($ENV_SLUG $FOLDER)"
{
  echo "KEYSTORE_BASE64=$(base64 -w0 "$work/auto-apk.p12")"
  echo "KEYSTORE_PASSWORD=$PW"
  echo "KEY_ALIAS=$ALIAS"
  echo "KEY_PASSWORD=$PW"
} >"$work/signing.env"
"${INFISICAL[@]}" secrets set --file "$work/signing.env" --projectId "$PROJECT_ID" --env "$ENV_SLUG" \
  --path "$FOLDER" --silent >/dev/null

echo "== Reading it back"
remote=$("${INFISICAL[@]}" secrets get KEYSTORE_BASE64 --projectId "$PROJECT_ID" --env "$ENV_SLUG" \
  --path "$FOLDER" --plain --silent | base64 -d | sha256sum | cut -d' ' -f1)
[ "$remote" = "$(sha256sum <"$work/auto-apk.p12" | cut -d' ' -f1)" ] || { echo "read-back mismatch" >&2; exit 1; }
echo "   Infisical holds the same keystore"

echo "== Backup in $BACKUP_DIR"
mkdir -p "$BACKUP_DIR"
cp "$work/auto-apk.p12" "$BACKUP_DIR/auto-apk.p12"
printf 'alias: %s\npassword (store and key): %s\ncertificate SHA-256: %s\n' "$ALIAS" "$PW" "$cert" \
  >"$BACKUP_DIR/auto-apk-password.txt"
chmod 600 "$BACKUP_DIR"/*

cat <<EOF

Done. Certificate SHA-256 (public, safe to share): $cert

Now:
  1. Put $BACKUP_DIR/auto-apk.p12 and the password from auto-apk-password.txt
     into your password manager, and keep one offline copy.
  2. Then delete $BACKUP_DIR. Infisical and your password manager are the copies.
Losing every copy means every install has to be uninstalled once.
EOF
