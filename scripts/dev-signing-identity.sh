#!/bin/bash
set -euo pipefail

# Creates a self-signed code-signing identity in the login keychain so local
# builds stop losing their keychain ACLs and TCC grants on every rebuild.
#
# An ad-hoc signature has no identity, so macOS records the authorised app in a
# keychain item's ACL by its cdhash. Rebuilding changes the cdhash, the ACL no
# longer matches, and every stored secret prompts again. A certificate gives the
# bundle a designated requirement built from its identifier and this certificate
# instead, which survives rebuilds.
#
# This identity is for local development only: it is not an Apple certificate,
# so it cannot be notarised and the bundle stays unshippable.
#
# Usage:
#   scripts/dev-signing-identity.sh [name]
#   scripts/dev-signing-identity.sh --remove [name]

IDENTITY_NAME="${DEV_SIGNING_IDENTITY_NAME:-BlackMushi Local Signing}"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

remove=false
if [[ "${1:-}" == "--remove" ]]; then
  remove=true
  shift
fi
if [[ -n "${1:-}" ]]; then
  IDENTITY_NAME="$1"
fi

if [[ "$remove" == true ]]; then
  security delete-identity -c "$IDENTITY_NAME" "$KEYCHAIN"
  echo "Removed '$IDENTITY_NAME'. Builds fall back to ad-hoc signing."
  exit 0
fi

if security find-identity -v -p codesigning "$KEYCHAIN" 2>/dev/null | grep -qF "$IDENTITY_NAME"; then
  echo "'$IDENTITY_NAME' already exists and is valid for code signing."
  exit 0
fi

# A run that failed after the import leaves behind a certificate no trust
# setting covers, which the check above cannot see. Drop it instead of stacking
# a second one beside it, or codesign would have two candidates to choose from.
while security find-certificate -c "$IDENTITY_NAME" "$KEYCHAIN" >/dev/null 2>&1; do
  echo "Dropping an incomplete '$IDENTITY_NAME' left by an earlier run."
  security delete-identity -c "$IDENTITY_NAME" "$KEYCHAIN" >/dev/null 2>&1 ||
    security delete-certificate -c "$IDENTITY_NAME" "$KEYCHAIN" >/dev/null 2>&1 ||
    break
done

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

# LibreSSL predates `-addext`, so the extensions go through a config file.
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

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -config "$workdir/openssl.cnf" \
  -keyout "$workdir/key.pem" -out "$workdir/cert.pem" >/dev/null 2>&1

# The Security framework reads neither of OpenSSL 3's defaults: it rejects the
# AES-256-CBC content encryption as "Unknown format in import", and the SHA-256
# MAC as a wrong password. -legacy settles the first, -macalg sha1 the second.
# An empty password fails MAC verification the same way, hence the throwaway one.
p12_password="$(openssl rand -hex 16)"
openssl pkcs12 -export -legacy -macalg sha1 \
  -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES \
  -inkey "$workdir/key.pem" -in "$workdir/cert.pem" \
  -name "$IDENTITY_NAME" -out "$workdir/identity.p12" \
  -passout "pass:$p12_password"

# -T lets codesign reach the private key; the partition list below is what
# actually stops macOS prompting for it on every build.
security import "$workdir/identity.p12" -k "$KEYCHAIN" -P "$p12_password" \
  -T /usr/bin/codesign -T /usr/bin/security
unset p12_password

echo
echo "Approve the trust prompt macOS is about to show for '$IDENTITY_NAME'."
security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$workdir/cert.pem"

echo
echo "Your login keychain password is needed once so codesign can use the key"
echo "without prompting. It is passed straight to /usr/bin/security."
read -rsp "login keychain password: " keychain_password
echo
security set-key-partition-list -S apple-tool:,apple:,codesign: -s \
  -k "$keychain_password" "$KEYCHAIN" >/dev/null
unset keychain_password

if ! security find-identity -v -p codesigning "$KEYCHAIN" | grep -qF "$IDENTITY_NAME"; then
  echo "'$IDENTITY_NAME' was imported but is not valid for code signing." >&2
  echo "Open Keychain Access, find it, and set 'Code Signing' to 'Always Trust'." >&2
  exit 1
fi

cat <<EOF

'$IDENTITY_NAME' is ready. scripts/build-macos.sh picks it up on its own.

Re-sign the app you already have installed so it stops prompting:

  scripts/build-macos.sh --sign-only "/Applications/BlackMushi.app"

Grant each keychain prompt once more after that ("Always Allow"). They will
carry over to every later build signed with this identity.
EOF
