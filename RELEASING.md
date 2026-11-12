# Releasing

`@nestrix-js/nestjs`, `@nestrix-js/ui` and `@nestrix-js/mcp` are released together, always at the same version, with
[Changesets](https://github.com/changesets/changesets) and the
[`release.yml`](./.github/workflows/release.yml) workflow. `@nestrix-js/protocol` and
`@nestrix-js/testing` are private and are never versioned, tagged or published.

**Publishing is on** (`NPM_PUBLISH_ENABLED=true` since 2026-11-12). The first releases were `0.1.0-alpha.0` to `0.1.0-alpha.3` under the `alpha` tag; the repository left Changesets pre mode with `0.1.0` (D-77), which publishes under `latest`, with provenance. A stable version always takes `latest`. To publish a future prerelease, re-enter pre mode first with `pnpm changeset pre enter <tag>` (for example `next`), commit `.changeset/pre.json`, and leave it with `pnpm changeset pre exit` before the stable release. The text below is kept as the record of how it was set up. Every job in `release.yml` is
skipped until the repository variable `NPM_PUBLISH_ENABLED` is set to `true` (see
[Keeping publishing off](#keeping-publishing-off)). The owner flips that switch last.

## Day to day

For every user-visible change (feature, fix, behaviour change) to a published package, add a
changeset to your PR:

```sh
pnpm changeset
```

Pick the bump (`patch` for fixes, `minor` for features, `major` for breaking changes; while the
version is `0.x`, breaking changes are `minor`), write a one-line summary for the changelog, and
commit the generated `.changeset/*.md`. Because versions are `fixed`, naming either package bumps
both. The [`changeset.yml`](./.github/workflows/changeset.yml) check fails a PR that changes a
published package without one. Docs-, test- and CI-only PRs are exempt: label them `no-changeset`.
Dependabot PRs and the version PR are skipped by the check. To see the same result locally:

```sh
pnpm changeset status --since=origin/main
```

## How a release happens

1. PRs with changesets are merged into `main`.
2. `release.yml` opens or updates a **"chore(release): version packages"** PR that bumps both
   `package.json` files and writes each `CHANGELOG.md`. Nothing is published yet.
3. Merging that PR runs the publish job: `pnpm verify` (the same checks as CI), then
   `pnpm release`, which runs `changeset publish` and publishes to npm through **trusted
   publishing** (OIDC: no npm token exists) with a provenance attestation, and creates the git
   tags and GitHub releases.

Before merging the version PR, check that the changelogs read well and that CI is green.

## The server image

The standalone server (`apps/server`, private, not on npm) ships as a Docker image on GHCR:
`ghcr.io/nestrix-js/nestrix-server`. The `server-image` job in `release.yml` builds
`apps/server/Dockerfile` for `linux/amd64` and `linux/arm64` (arm64 under QEMU, so it is slow) and
pushes two tags: the version (for example `0.1.0`) and the npm dist-tag (the pre tag while
`.changeset/pre.json` exists, `latest` for a stable version; `0.1.0` was the first stable one). The image carries OCI labels (source,
version, revision, licence `Apache-2.0`, description) and BuildKit provenance (`mode=max`) and SBOM
attestations, stored in the registry beside it. The job is the only one with `packages: write`; it
needs no `id-token` or `attestations` permission. It is gated on `NPM_PUBLISH_ENABLED` like the others.

It runs after the `publish` job when that job published something. To publish the image for an
existing release (a failed run, or a release made before this job existed), run the workflow by hand
from `main`: Actions, Release, Run workflow, with `version` set (for example `0.1.0`; empty
means the version in `packages/nestjs/package.json`). With a version set, the job builds from that
release's git tag `@nestrix-js/nestjs@<version>`, not from the tip of `main`. Re-running for a
version overwrites its tags.

**Owner, once:** GHCR may create the package private on the first push. Pulling without logging in
needs it public: open <https://github.com/orgs/nestrix-js/packages/container/nestrix-server/settings>,
Danger Zone, Change visibility, Public. Also check that the package is linked to the repository
(the `org.opencontainers.image.source` label does that) so the workflow's `GITHUB_TOKEN` can keep
pushing. The repository itself must be public for the provenance to be verifiable by others.

## Adding a package after the first release: `@nestrix-js/mcp`

`@nestrix-js/mcp` joined the fixed group after `@nestrix-js/nestjs` and `@nestrix-js/ui` were already published, so its first publish needs the same hand steps: npm only allows a trusted publisher on a package that exists, and the workflow's `changeset publish` has no token to create one. The release workflow publishes every non-private workspace package, so until these are done the first release that includes it fails for that package.

**Owner, once**, from a clean `main` that carries the version of the version PR:

1. Run `pnpm install --frozen-lockfile` and `pnpm verify`, then `pnpm --filter @nestrix-js/mcp pack --dry-run` and check that only `dist`, `README.md` and `package.json` ship.
2. Log in with `npm login`, then publish the package by hand with the tag of the version being released (the record of how `@nestrix-js/mcp` was first published used `alpha`), approving the 2FA prompt in the browser. Never bypass pnpm's clean-tree check.
3. On npmjs.com, package `@nestrix-js/mcp`, Settings, Trusted publishing, GitHub Actions: owner `nestrix-js`, repository `nestrix`, workflow `release.yml`, environment empty, with **Allow direct `npm publish`**; then require 2FA and disallow tokens (or use `npm trust github`, npm 11.15 or later), as for the other two packages above.
4. The next release through CI publishes it with provenance.

## Keeping publishing off

Four independent layers, so a single mistake cannot publish:

1. `release.yml` jobs are all gated on `vars.NPM_PUBLISH_ENABLED == 'true'`. The variable does not
   exist today.
2. `pnpm release` (the root script that wraps `changeset publish`) exits with an error unless it
   runs inside `release.yml` on `main`. A local `pnpm release` publishes nothing. The script
   `scripts/release.mjs` is the only place that calls `changeset publish`.
3. The publish job has no npm token. Without a trusted publisher configured on npmjs.com for the
   package, npm rejects it.
4. The `@nestrix-js` npm organisation exists, but no trusted publisher is configured until the first publish, so the scope cannot be published to.

## One-time setup (owner)

All done on 2026-11-12 (the npm scope is `@nestrix-js`, D-71). Kept for reference.

- [ ] npm account with **2FA**, and the **`@nestrix-js` organisation** created on npmjs.com. This is
      also the test of whether the scope is free (`docs/decisions.md`, "Owner actions
      outstanding"). If the scope is taken, stop: the package names change.
- [ ] Make the repository **public** (`docs/decisions.md`, "When the repository goes public").
      Provenance needs a public repository, so the first publish comes after this. Scan the
      whole history first:

      ```sh
      git log --all --format='%an <%ae>' | sort -u
      git log --all -p | grep -nE '(ghp_|github_pat_|gho_|npm_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|xox[baprs]-|sk-[A-Za-z0-9]{20,})'
      git log --all --name-only --format= | sort -u | grep -iE '\.env|secret|credential|\.pem$|\.key$|id_rsa|\.npmrc'
      ```

- [ ] GitHub, Settings, Actions, General: workflow permissions **Read**, and tick **"Allow GitHub
      Actions to create and approve pull requests"** (the version PR needs it unless
      `RELEASE_PAT` is set).
- [ ] Optional: repository secret `RELEASE_PAT`, a fine-grained token for this repository only
      with Contents and Pull requests read and write, so the version PR runs CI. Store it with
      `gh secret set RELEASE_PAT -R nestrix-js/nestrix`; never paste it anywhere else.
- [ ] Optional: a GitHub Environment `npm` with required reviewers on the publish job. Required
      reviewers on a private repository need a paid plan. If you add it, add
      `environment: npm` to the `publish` job and name `npm` in the trusted publisher below.
- [ ] Optional: a ruleset on `main` and a tag ruleset protecting release tags (`v*` and
      `@nestrix-js/*@*`). Rulesets are unavailable on a private repository on the Free plan.
- [ ] **First publish, by hand**, because npm only allows a trusted publisher to be configured on
      a package that already exists (`npm trust` also needs the package to exist). From a clean
      checkout of `main`:

      ```sh
      git switch main && git pull
      pnpm install --frozen-lockfile
      pnpm verify
      pnpm --filter @nestrix-js/nestjs pack --dry-run   # check the file list: only what should ship
      pnpm --filter @nestrix-js/ui pack --dry-run
      npm login
      pnpm --filter @nestrix-js/nestjs publish --access public
      pnpm --filter @nestrix-js/ui publish --access public
      ```

      Both packages are at `0.0.0` today. Decide which version the first publish carries: either
      publish `0.0.0` as a placeholder that reserves the names, or merge a first version PR
      first and publish that. Never bypass pnpm's clean-tree check with `--no-git-checks`. With
      2FA, npm may show an interim `0.0.0-stage` version until the publish is approved in the
      browser.
- [ ] On npmjs.com, for **each** of the two packages, Settings, Trusted publishing, GitHub
      Actions: owner `nestrix-js`, repository `nestrix`, workflow `release.yml` (exact,
      case-sensitive), environment empty (or `npm` if you added one). **Allow direct
      `npm publish`** as an action: the workflow uses `changeset publish`, not staged publishing,
      and configurations created after 2026-09-03 default to `npm stage publish` only. npm does
      not validate these values when you save them. Then set publishing access to require 2FA and
      disallow tokens. The same can be done from a terminal with `npm trust github`
      (npm 11.15 or later).
- [ ] Set the repository variable `NPM_PUBLISH_ENABLED` to `true`
      (`gh variable set NPM_PUBLISH_ENABLED --body true -R nestrix-js/nestrix`). This is the
      switch: the next push to `main` runs `release.yml`.
- [ ] After the first release through CI, check the provenance badge on the npm package pages.
- [ ] Delete any `NPM_TOKEN` secret if one was ever created (none is used).

## A bad release

`npm deprecate @nestrix-js/nestjs@<version> "<reason>"` (and the same for `@nestrix-js/ui`), then release
a fix through the normal flow. Unpublishing is only possible within 72 hours and breaks anyone who
installed that version.

To stop releases at once, delete the `NPM_PUBLISH_ENABLED` variable.

## Tooling versions

Resolved on 2026-11-11: `@changesets/cli` 3.0.3, `changesets/action` v2.1.2, Node 26 and pnpm 12
in the publish job. npm's documented minimums for trusted publishing are npm CLI 11.5.1 and Node
22.14.0; pnpm 12 attaches provenance and uses the OIDC token itself.
