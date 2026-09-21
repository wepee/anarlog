#!/bin/bash
set -euo pipefail

# Builds the macOS desktop bundle and makes sure it ends up with a real
# signature. Without one, `tauri build` leaves the linker's ad-hoc signature in
# place: no entitlements, and a code-signing identifier derived from the build
# hash instead of the bundle id. TCC then keys the app on its cdhash, so every
# rebuild loses the permissions the user already granted.
#
# Usage:
#   scripts/build-macos.sh [tauri build args...]
#   scripts/build-macos.sh --sign-only <path to .app>   # re-sign, no rebuild
#
# Xcode 26+ ships a SwiftPM build system that internalizes `@_cdecl` symbols in
# release, which breaks swift-rs linking, so pin the Command Line Tools toolchain.
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Library/Developer/CommandLineTools}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP_DIR="$REPO_ROOT/apps/desktop"

DEV_SIGNING_IDENTITY_NAME="${DEV_SIGNING_IDENTITY_NAME:-BlackMushi Local Signing}"

resolve_identity() {
  if [[ -n "${APPLE_SIGNING_IDENTITY:-}" ]]; then
    printf '%s' "$APPLE_SIGNING_IDENTITY"
    return
  fi

  local identity
  identity="$(security find-identity -v -p codesigning 2>/dev/null |
    sed -n 's/.*"\(Developer ID Application:.*\)".*/\1/p' |
    head -n 1)"
  if [[ -n "$identity" ]]; then
    printf '%s' "$identity"
    return
  fi

  # Fall back to the local development identity from
  # scripts/dev-signing-identity.sh. It cannot be notarised, but it gives the
  # bundle a designated requirement that survives rebuilds, so keychain ACLs
  # and TCC grants stop resetting on every build.
  security find-identity -v -p codesigning 2>/dev/null |
    sed -n "s/.*\"\($DEV_SIGNING_IDENTITY_NAME\)\".*/\\1/p" |
    head -n 1
}

# Ad-hoc and the local identity are signed here; only a Developer ID is handed
# to Tauri, which signs with the hardened runtime and a timestamp.
identity_kind() {
  case "$1" in
    -) printf 'adhoc' ;;
    "Developer ID Application:"*) printf 'developer-id' ;;
    *) printf 'local' ;;
  esac
}

# Signs the bundle in place. A Developer ID keeps its designated requirement
# stable across rebuilds, which is what lets TCC recognise the app again.
sign_app() {
  local app="$1"
  local identity="$2"
  local entitlements="$3"
  local info_plist="$app/Contents/Info.plist"
  local identifier executable main_binary
  local options=()

  identifier="$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$info_plist")"
  executable="$(/usr/libexec/PlistBuddy -c "Print :CFBundleExecutable" "$info_plist")"
  main_binary="$app/Contents/MacOS/$executable"

  # The hardened runtime requires library validation, which neither an ad-hoc
  # nor a self-signed local signature can satisfy for the vendored dylib. A
  # timestamp is only worth its round trip on a certificate Apple issued.
  if [[ "$(identity_kind "$identity")" == "developer-id" ]]; then
    options=(--timestamp --options runtime)
  fi

  # Nested Mach-O first: the bundle signature seals them, so signing them
  # afterwards would invalidate the outer seal.
  while IFS= read -r -d '' nested; do
    if [[ "$nested" == "$main_binary" ]]; then
      continue
    fi
    if [[ "$(file -b --mime-type "$nested")" != "application/x-mach-binary" ]]; then
      continue
    fi
    codesign --force --sign "$identity" "${options[@]+"${options[@]}"}" "$nested"
  done < <(find "$app/Contents" -type f -print0)

  codesign --force --sign "$identity" \
    --identifier "$identifier" \
    --entitlements "$entitlements" \
    "${options[@]+"${options[@]}"}" \
    "$app"
  codesign --verify --verbose=2 "$app"
}

entitlements_for() {
  if [[ "$*" == *app-store* ]]; then
    printf '%s' "$DESKTOP_DIR/src-tauri/Entitlements.app-store.plist"
  else
    printf '%s' "$DESKTOP_DIR/src-tauri/Entitlements.plist"
  fi
}

warn_local() {
  local app="$1"

  cat >&2 <<EOF

$(basename "$app") was signed with "$signing_identity", a local identity. Its
designated requirement is stable, so keychain and TCC grants carry over to the
next build, but the bundle is not notarisable and cannot be distributed. Install
a Developer ID Application certificate (or set APPLE_SIGNING_IDENTITY) to ship.
EOF
}

warn_adhoc() {
  local app="$1"

  cat >&2 <<EOF

No signing certificate found, so $(basename "$app") was signed ad-hoc.
Entitlements and the bundle identifier are now correct, but macOS identifies an
ad-hoc app by its cdhash: the permissions granted to this build will not carry
over to the next one. Run scripts/dev-signing-identity.sh for a local identity,
or install a Developer ID Application certificate, to keep them across rebuilds.
EOF
}

signing_identity="$(resolve_identity)"
[[ -n "$signing_identity" ]] || signing_identity="-"

if [[ "${1:-}" == "--sign-only" ]]; then
  app_bundle="${2:-}"
  if [[ -z "$app_bundle" || ! -d "$app_bundle" ]]; then
    echo "Usage: $0 --sign-only <path to .app>" >&2
    exit 1
  fi

  sign_app "$app_bundle" "$signing_identity" "$(entitlements_for "$app_bundle")"
  case "$(identity_kind "$signing_identity")" in
    adhoc) warn_adhoc "$app_bundle" ;;
    local) warn_local "$app_bundle" ;;
  esac
  exit 0
fi

target=""
previous=""
for argument in "$@"; do
  if [[ "$previous" == "--target" ]]; then
    target="$argument"
  fi
  previous="$argument"
done

if [[ -n "$target" ]]; then
  bundle_dir="$DESKTOP_DIR/src-tauri/target/$target/release/bundle/macos"
else
  bundle_dir="$DESKTOP_DIR/src-tauri/target/release/bundle/macos"
  case "$(uname -m)" in
    arm64) target="aarch64-apple-darwin" ;;
    *) target="x86_64-apple-darwin" ;;
  esac
fi

kind="$(identity_kind "$signing_identity")"

if [[ "$kind" == "developer-id" ]]; then
  echo "Signing with: $signing_identity"

  # Tauri copies the vendored dylib in as a framework, and the hardened runtime
  # refuses to load one that a different identity signed. It is checked into the
  # repository, so put the original back once the bundle holds a signed copy.
  cloudsync_dylib="$REPO_ROOT/crates/cloudsync/vendor/cloudsync/macos/${target%%-*}/cloudsync.dylib"
  if [[ -f "$cloudsync_dylib" ]]; then
    cloudsync_backup="$(mktemp -t cloudsync)"
    cp -p "$cloudsync_dylib" "$cloudsync_backup"
    # shellcheck disable=SC2064
    trap "cp -p '$cloudsync_backup' '$cloudsync_dylib'; rm -f '$cloudsync_backup'" EXIT

    codesign --force --sign "$signing_identity" --timestamp --options runtime "$cloudsync_dylib"
    codesign --verify --strict --verbose=2 "$cloudsync_dylib"
  fi

  export APPLE_SIGNING_IDENTITY="$signing_identity"
elif [[ "$kind" == "local" ]]; then
  # Keep APPLE_SIGNING_IDENTITY out of Tauri's environment: it would sign with
  # the hardened runtime, whose library validation a self-signed certificate
  # cannot satisfy. Sign below instead, the same way the ad-hoc path does.
  echo "Signing with: $signing_identity (local identity, set below)"
fi

cd "$DESKTOP_DIR"
pnpm exec tauri build "$@"

# Tauri signed the app and the .dmg around it already.
if [[ "$kind" == "developer-id" ]]; then
  exit 0
fi

app_bundle="$(ls -dt "$bundle_dir"/*.app 2>/dev/null | head -n 1 || true)"
if [[ -z "$app_bundle" ]]; then
  echo "No .app found under $bundle_dir; skipping signing." >&2
  exit 0
fi

sign_app "$app_bundle" "$signing_identity" "$(entitlements_for "$@")"
if [[ "$kind" == "local" ]]; then
  warn_local "$app_bundle"
else
  warn_adhoc "$app_bundle"
fi

cat >&2 <<EOF
The .dmg, if one was produced, still holds the app as it was before signing.
Install from $app_bundle instead.
EOF
