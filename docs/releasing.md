# Releasing pi_agent_rust
This repo ships:
- A crates.io package: `pi_agent_rust` (Cargo `[package].name`)
- A library crate: `pi` (Cargo `[lib].name`)
- A binary: `pi` (Cargo `[[bin]].name`)

## Versioning + tags (source of truth)
**Source of truth:** `Cargo.toml` `[package].version`.

- **Tag format:** `vX.Y.Z` (SemVer). Example: `v0.2.0`.
- **Pre-releases:** `vX.Y.Z-rc.1` (or similar). Example: `v0.2.0-rc.1`.
- **Coupling:** `pi_agent_rust` (crate), `pi` (lib), and `pi` (binary) are all built from the same package, so they share one version number.
- **Sibling repos:** `asupersync`, `rich_rust`, `charmed_rust`, `sqlmodel_rust` are versioned independently in their own repos.

### Publishing to crates.io
`.github/workflows/publish.yml` is triggered on tag pushes matching `v*` and will:
1) validate the tag is SemVer
2) verify `Cargo.toml` version matches the tag version
3) run `cargo publish --dry-run --locked`
4) publish to crates.io **only** when:
   - the tag is **not** a pre-release (workflow checks `tag` does **not** contain `-`)
   - `CARGO_REGISTRY_TOKEN` is configured

Note: dependencies that specify both `version` and `path` are expected to publish using the `version` constraint; ensure those versions exist on crates.io before tagging.

## When do we call it 1.0?
We call it `1.0.0` when:
- CI is green on Linux/macOS/Windows (`.github/workflows/ci.yml`)
- Core CLI modes are stable (print + interactive + RPC) and conformance tests are green
- Extension runtime surface and security policy are stable enough that we can commit to not breaking users without an intentional SemVer bump

Until then, `0.x` releases are allowed to break behavior when it improves correctness/parity.

## Cutting a release (patch/minor)
1) **Pick version** (SemVer):
   - patch: bugfixes / internal refactors
   - minor: new user-facing features
2) **Update version** in `Cargo.toml` (`[package].version`).
3) **Run quality gates locally**:
   - `cargo fmt --check`
   - `cargo clippy --all-targets -- -D warnings`
   - `cargo test --all-targets`
4) **Update changelog**:
   - `br changelog --since-tag vX.Y.Z` (or use `--since YYYY-MM-DD` if no prior tags)
   - paste the output into `CHANGELOG.md` under a new version heading
5) **Commit** (`git commit`).
6) **Tag**:
   - `git tag vX.Y.Z`
   - `git push origin vX.Y.Z`
7) **Verify** GitHub Actions publish job and/or dry-run output.

## Pre-release flow (rc)
Use a pre-release tag to exercise CI/publish validation without publishing to crates.io:
- `git tag vX.Y.Z-rc.1 && git push origin vX.Y.Z-rc.1`

This should run the `Publish` workflow planning step and skip the crates publish step.

