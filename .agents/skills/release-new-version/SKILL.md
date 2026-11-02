---
name: release-new-version
description: Cut and publish a stable BlackMushi desktop release from this fork's own GitHub Releases, which feed the in-app updater. Covers the version bump, the changelog gate, the CI gates that pull requests do not run, the fork_release workflow, and verifying the published update feed.
metadata:
  internal: true
---

# Release a New Version

This fork publishes one thing: a **stable macOS Apple Silicon** desktop build,
as a GitHub Release on this repository. That release carries the `latest.json`
the in-app updater reads.

## What this fork does not have

Upstream's release machinery was removed because it cannot work here. Do not
look for it, and do not recreate it as part of a release:

- no Nightly channel, and no `desktop_nightly.yaml` / `desktop_cd.yaml` /
  `desktop_publish.yaml`
- no CrabNebula, no Microsoft Store, no Flathub, no APT or AUR repositories
- no Windows or Linux release artifacts (their **CI** still runs; only the
  release lane is macOS-only)
- no web app, so no website changelog page to publish or verify
- no mobile app, no TestFlight, no Google Play, no `apps/mobile`
- no hosted API, Stripe, or database deployments to sequence before a release

`release-version.json` is the single version, shared by desktop and the watchOS
project. There is no separate mobile version.

## Core rule

Release from `main`, after the changelog is merged. The workflow builds whatever
commit you point it at, so a release from an unmerged branch produces a binary
no one can reproduce from `main`.

## Preflight

Read the workflow before assuming how it behaves. It is short, and it is the
only release path:

```bash
cat .github/workflows/fork_release.yaml
```

Pin every `gh` command to this fork. The checkout has an `upstream` remote, and
`gh repo view` resolves to the fork's **parent**, so an unpinned command silently
targets `fastrepl/anarlog`:

```bash
REPO="$(git remote get-url origin | sed -E 's#(git@github\.com:|https://github\.com/)##; s#\.git$##')"
echo "$REPO"   # expect this fork, not fastrepl/anarlog
```

Set the version. This also regenerates `apps/watch/apple/Version.xcconfig`, and
both files must be committed together:

```bash
VERSION=<version>
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
node scripts/release-version.mjs "$VERSION"
node scripts/release-version.mjs --check "$VERSION"
git status --porcelain release-version.json apps/watch/apple/Version.xcconfig
```

The version must be **greater than the last published one**, or installed apps
will not see an update. `gh release create` also refuses a tag that already
exists, so a repeated version fails late rather than publishing silently.

Review what will ship:

```bash
gh release list -R "$REPO" --limit 10
git log --oneline v<last-version>..main
```

## Changelog gate

`packages/changelog/content/<version>.md` is still required, but read why: the
website is gone, so this file is what the **app itself** renders in its
changelog tab. The bundled latest entry comes from the build; older versions are
fetched at runtime.

1. Follow `packages/changelog/content/AGENTS.md`.
2. Write `packages/changelog/content/$VERSION.md`, including the frontmatter:

```md
---
date: "YYYY-MM-DD"
summary: "One concise, user-facing sentence for the changelog index preview."
---
```

3. Validate:

```bash
pnpm exec dprint fmt --allow-no-files packages/changelog/content/$VERSION.md
pnpm exec dprint check --allow-no-files packages/changelog/content/$VERSION.md
pnpm -F @anlg/changelog typecheck
```

Entries are for app users: leave out internal refactors, CI work, and
implementation detail unless they explain something visible.

Merge the version bump and the changelog to `main` before releasing, and record
the resulting SHA.

## CI gate

**Pull requests and pushes do not run the desktop native jobs.** `macos_ci`,
`linux_ci`, `windows_ci` and `desktop_swift` only run on the daily schedule or
`workflow_dispatch`, so a green PR proves nothing about them. Dispatch the full
run against the candidate and check the jobs individually:

```bash
gh workflow run desktop_ci.yaml -R "$REPO" --ref main
gh run list -R "$REPO" --workflow desktop_ci.yaml --limit 3
gh api "repos/$REPO/actions/runs/<run-id>/jobs" \
  --paginate -q '.jobs[] | "\(.conclusion)\t\(.name)"'
```

A job reported as `skipping` is not a pass. Confirm `headSha` matches the
candidate before accepting any result.

## Release

```bash
gh workflow run fork_release.yaml -R "$REPO" --ref main
```

It defaults to the version in `release-version.json` and to a **draft** release.
Both are overridable:

```bash
gh workflow run fork_release.yaml -R "$REPO" --ref main -f version=$VERSION -f draft=false
```

The job takes roughly an hour, most of it the Rust release build. Check the
steps, not just the conclusion:

```bash
gh api "repos/$REPO/actions/runs/<run-id>/jobs" \
  --paginate -q '.jobs[] | "\(.conclusion)", (.steps[] | "  \(.conclusion)\t\(.name)")'
gh run view -R "$REPO" <run-id> --log-failed
```

The workflow refuses to start without the `TAURI_SIGNING_PRIVATE_KEY` secret:
an artifact signed with any other key is rejected by the app, so there would be
nothing useful to publish.

## Verify the published release

The release is a draft by default, and **a draft does not feed the updater** —
`releases/latest/download/` resolves only to a published, non-prerelease
release. Verify before publishing, then publish, then verify the feed.

```bash
gh release view v$VERSION -R "$REPO" --json tagName,isDraft,assets \
  -q '"draft=\(.isDraft)", (.assets[] | "  \(.name) \(.size)")'
```

Expect four assets: `.app.tar.gz`, `.app.tar.gz.sig`, `.dmg`, `latest.json`.

Verify the **published bytes**, not just the workflow's own check, against the
public key shipped in the app:

```bash
gh release download v$VERSION -R "$REPO" -p 'BlackMushi_*_aarch64.app.tar.gz*' -D /tmp/rel --clobber
cargo run --locked -p updater-core --bin verify-updater-signature -- \
  /tmp/rel/BlackMushi_${VERSION}_aarch64.app.tar.gz \
  /tmp/rel/BlackMushi_${VERSION}_aarch64.app.tar.gz.sig \
  apps/desktop/src-tauri/tauri.conf.json
```

Publish, then confirm the endpoint the app actually queries:

```bash
gh release edit v$VERSION -R "$REPO" --draft=false
curl -sSL "https://github.com/$REPO/releases/latest/download/latest.json"
```

The manifest must report the new `version`, a `darwin-aarch64` platform whose
`signature` matches the `.sig` asset, and a `url` that resolves.

## Known limitations

State these rather than implying the release is more complete than it is.

- **Signing is ad-hoc** unless `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`
  and `KEYCHAIN_PASSWORD` are set. Gatekeeper warns on first launch, and the
  cdhash changes every release, so macOS re-asks for microphone and screen
  permissions after each update. The workflow already wires the `APPLE_*`
  secrets for the day a Developer ID exists; nothing else needs changing.
- **Apple Silicon only.** Intel Macs are not served by this release lane.
- **The first install is manual.** Any build predating this fork's own updater
  carries upstream's public key, so it cannot be updated into. Replace it by
  hand once; later releases update normally.
- **Older changelog entries are fetched from upstream.**
  `apps/desktop/src/changelog/source.ts` points at
  `raw.githubusercontent.com/fastrepl/anarlog`, so versions other than the
  bundled latest one show upstream's notes. The release notes in `latest.json`
  are currently just `BlackMushi <version>` and do not use the changelog file.

## Final checks

Before reporting a release as done, capture:

- the version and the `main` SHA it was built from
- the `desktop_ci` run URL and each native job's individual result
- the `fork_release` run URL
- the release URL, its tag, and that `isDraft` is false
- the signature verification result against the published artifact
- the `latest.json` served by `releases/latest/download/`, and that its `url`
  resolves
- anything not verified — in particular whether an installed app was actually
  observed detecting and applying the update, which no workflow proves
