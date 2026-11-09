#!/bin/bash
set -euo pipefail

# [fork] Creates the self-signed certificate fork_release.yaml signs releases
# with, and stores it as the repository secrets FORK_SIGNING_CERTIFICATE and
# FORK_SIGNING_CERTIFICATE_PASSWORD.
#
# Without it, releases are signed ad-hoc and macOS identifies the app by a
# cdhash that changes with every build: each update asks for the keychain
# again and silently drops the Accessibility, microphone and screen grants
# (System Settings keeps showing the old, now unrelated, entry as enabled).
# A certificate gives every release the same designated requirement instead.
#
# Run it once. A new certificate is a new identity, so replacing it costs one
# more round of keychain prompts and permission grants; hence --force.
#
# Usage:
#   scripts/fork-signing-certificate.sh [--force] [owner/repo]

force=false
if [[ "${1:-}" == "--force" ]]; then
  force=true
  shift
fi
REPO="${1:-wepee/anarlog}"
IDENTITY_NAME="${FORK_SIGNING_IDENTITY_NAME:-BlackMushi Release Signing}"

for tool in gh openssl base64; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "$tool is required." >&2
    exit 1
  fi
done

if [[ "$force" != true ]] &&
  gh secret list --repo "$REPO" | awk '{ print $1 }' | grep -qx FORK_SIGNING_CERTIFICATE; then
  echo "FORK_SIGNING_CERTIFICATE already exists on $REPO; keeping it." >&2
  echo "Replacing it changes the app's identity once more. Pass --force to do it anyway." >&2
  exit 1
fi

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

cat > "$workdir/openssl.cnf" <<CNF
[ req ]
distinguished_name = dn
x509_extensions    = v3
prompt             = no

[ dn ]
CN = $IDENTITY_NAME

[ v3 ]
basicConstraints       = critical,CA:false
keyUsage               = critical,digitalSignature
extendedKeyUsage       = critical,codeSigning
subjectKeyIdentifier   = hash
CNF

# codesign refuses an expired certificate, so make it outlive the fork.
openssl req -x509 -newkey rsa:2048 -nodes -days 7300 \
  -config "$workdir/openssl.cnf" \
  -keyout "$workdir/key.pem" -out "$workdir/cert.pem" >/dev/null 2>&1

# `security import` reads neither of OpenSSL 3's PKCS#12 defaults (AES content
# encryption, SHA-256 MAC). LibreSSL, macOS's own openssl, already writes the
# old format and does not know -legacy.
legacy=()
if openssl version | grep -q '^OpenSSL [3-9]'; then
  legacy=(-legacy -macalg sha1)
fi
p12_password="$(openssl rand -hex 16)"
openssl pkcs12 -export "${legacy[@]+"${legacy[@]}"}" \
  -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES \
  -inkey "$workdir/key.pem" -in "$workdir/cert.pem" \
  -name "$IDENTITY_NAME" -out "$workdir/identity.p12" \
  -passout "pass:$p12_password"

base64 < "$workdir/identity.p12" | tr -d '\n' |
  gh secret set FORK_SIGNING_CERTIFICATE --repo "$REPO"
printf '%s' "$p12_password" |
  gh secret set FORK_SIGNING_CERTIFICATE_PASSWORD --repo "$REPO"
unset p12_password

fingerprint="$(openssl x509 -in "$workdir/cert.pem" -noout -fingerprint -sha1 |
  sed 's/.*=//; s/://g')"

cat <<EOF

'$IDENTITY_NAME' ($fingerprint) is stored on $REPO.
The next Fork Release is signed with it. Install that release, then once more:
  - answer both keychain prompts with "Always Allow";
  - in System Settings > Privacy & Security > Accessibility, remove BlackMushi
    with "-" and grant it again from BlackMushi's settings.
Later releases keep both.
EOF
