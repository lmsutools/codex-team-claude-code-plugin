# Changelog

## Unreleased: first-class Rust

Rust workspaces get dedicated profile, verification, review and isolation support. Nothing changes for non-Cargo projects.

- **`rust` profile template.** Use `"extends": "rust"`.
  - `fmt` (advise): `cargo fmt --all --check`.
  - `clippy` (enforce): `-D warnings`.
  - `tests` (enforce): `cargo test --no-fail-fast`.
  - `clippy` and `tests` run with `--locked --offline` on the affected packages, and only when Rust inputs change.
  - `examples/rust/profile.json` swaps in nextest and adds a cross-target clippy for a Ready platform.
- **Affected packages.** `scripts/cargo-affected.mjs` selects the workspace packages that own changed files, plus their transitive workspace dependents (normal, dev and build), from `cargo metadata --no-deps --offline`.
  - The root manifest, `Cargo.lock`, `.cargo/` and toolchain/lint configuration select `--workspace`.
  - Docs-only changes skip the check. `--always` runs the workspace instead.
- **New reserved profile variables.** `${changedList}` is a file listing the job's changed paths, written per check under the scratch folder. `${pluginRoot}` is the installed plugin root.
- **Test counts.** libtest `test result:` lines are summed across test binaries and doc tests (`format: "cargo"`). The nextest Summary line is parsed too (`format: "nextest"`), and timeouts count as failures.
- **Rust summaries.** Checks that run cargo/rustc (or cargo-affected) record `rust`: error and warning counts, up to 8 diagnostics (errors first, each with code, message and cwd-relative `file:line:column`), up to 8 failing tests (libtest panics in old and new thread formats, nextest FAIL lines, listed FAILED tests), and up to 8 unformatted files (`rustfmt --check` `Diff in ...` lines).
  - The summary is parsed from stderr and stdout. `outputTail` carries stdout only, so rustc errors were previously invisible to packets and reviewers.
  - Decision packets carry the first 3 of each. Reviewers get the full summary.
  - The summary is labeled untrusted.
- **Warm targets.** Worktree jobs, branch-mode jobs and batch children start from a copy-on-write clone of the original checkout's ignored `target/`, recorded as `warmTarget`.
  - Uses `/bin/cp -c -R` (`clonefile(2)`) on macOS APFS and `fs.cpSync(..., COPYFILE_FICLONE_FORCE)` on copy-on-write filesystems on Linux/Windows.
  - Measured on Helix: worktree test build 9.4 s → 4.6 s, with a 0.5 s APFS clone.
  - Correctness was verified: a dependency change in the worktree still fails the dependent's tests, and the original stays untouched.
  - Unsupported filesystems or tracked `target/` directories are skipped rather than copied. `CODEX_TEAM_WARM_TARGET=clone|copy|off` controls the behavior.
  - Each child gets its own directory, so children never share a target lock.
- **Multi-call binary symlinks (`rustup`).** `resolveCheckExecutable` preserves the symlink's basename when `realpath` points to a multi-call launcher with a different basename (such as `~/.cargo/bin/cargo` -> `rustup`), while still validating containment on the resolved target.
- **Toolchain homes.** `CARGO_HOME`/`RUSTUP_HOME` are passed automatically to `node .../cargo-affected.mjs` checks as well.
- **Worker prompt.** In Cargo workspaces, Codex is told to:
  - work offline and locked;
  - report a needed new crate as a blocker;
  - iterate with `cargo check`/`cargo test -p` on the packages it changes;
  - never `cargo clean`.
- **`codex_doctor` Rust section.** It reports the cargo version, offline-dependency readiness (`cargo fetch --locked --offline`), nextest and the warm-target mode, with advice.
- **Contracts.** `schemas/profile.schema.json` was regenerated. It had been missing top-level `passEnv`, the check fields `host`/`passEnv`/`allowInline`/`criteria`, and `gates.executionSensitivePaths`. A new sync test keeps templates, schema and examples in step with the runtime.
- **Lead skill & bundled Rust architect skill.** A short "Rust projects" section links to `skills/lead/references/rust.md`, and `skills/weedo-rust-dev-skill/` bundles the full cross-platform Rust architecture, build optimization, remote VM sizing, fast TDD, and `crates/telemetry` Sentry playbook.
- **Sentry / BugSink / GlitchTip triage (`scripts/sentry-triage.mjs`).** Maps Rust stacktraces and `tracing` breadcrumbs from a Sentry event/issue JSON to the owning Cargo workspace package and generates a scoped `codex_start` worktree assignment requiring a reproducing regression test.
- **Cross-PC multi-agent installer (`scripts/setup-all.mjs`).** `npm run setup-all` links `weedo-rust-dev-skill` into Claude Code (`~/.claude/skills/`), Codex CLI (`~/.codex/skills/`), and Antigravity (`~/.gemini/config/skills/`), and installs the toggleable `codex-rust-suite` Antigravity plugin (`~/.gemini/config/plugins/codex-rust-suite/`) on macOS, Windows (junctions, no Admin needed), and Linux.
- **Tests & macOS compatibility.** `tests/rust.test.mjs` adds 23 tests (unit, end-to-end against fake Codex, real cargo, Sentry triage, and multi-agent installer), smoke-tested end-to-end against `codex-cli 0.162.1` (`gpt-6-astra`) on a Cargo workspace. Added `tests/setup-realpath-tmp.mjs` and fixed `/private/var` path canonicalization in `sandboxLimitation` so all 487 tests pass on macOS as well as Windows/Linux.

## 1.2.2 (2026-10-18)

1.2.2 works with the latest Codex CLI and adds service tiers.

- Smoke-tested end to end on Codex CLI 0.163.0 and 0.153.2: scout, implementation with a sandboxed check, revision on the same thread, and worktree isolation with integration.
- Compatibility-checked on 0.162.1.
- Fixes eight problems seen in heavy parallel use on Windows, plus four found while testing against the real CLIs.

### Service tiers

- `codex_start` accepts `serviceTier: "default" | "fast" | "priority" | "ultrafast"`, passed as `-c service_tier=<tier>`. When it is omitted, the CLI configuration decides. Revisions, reviewers and deadline finalize inherit the tier, and requests without one keep their 1.2.1 identity.
- An explicit tier is validated against the selected CLI's `codex features list`: `fast` and `priority` need `fast_mode`, and `ultrafast` needs `ultrafast_mode`. 0.162.1 and 0.163.0 have `ultrafast_mode`; 0.153.2 does not. A refusal names the CLI.
- `codex_status`, waiter packets and the Stop footer show the effective tier. Codex drops a tier that the model's catalog does not advertise and emits an item notice. The plugin records this as `serviceTierOmitted` and shows `default (ultrafast omitted ...)`. Start output also gives advice from Codex's cached model catalog.
- On 2026-10-18 the catalog advertised only `priority` ("Fast", 2x) for `gpt-6-astra`. With `service_tier = "ultrafast"`, 0.153.2 and 0.163.0 both omitted the tier and ran at the default speed.

### Fixes

1. **First-run sandbox setup.**
   - The preflight before the first model call gives a folder this runtime has never set up a 180 s bound, or 60 s once the folder is warm. `CODEX_TEAM_PROBE_TIMEOUT_MS` overrides the bound. `codex_doctor probe=true` gets a 200 s total budget (it was 20 s).
   - The preflight is retried once after a timeout, after a runner start timeout, or when another process holds a runtime file (os error 32, often the Codex desktop app). A held file is named in the recovery steps and in the doctor hint.
   - "Timed out after 15000ms waiting for runner spawn_ready" is classified as the transient `sandbox_spawn_timeout` and is never cached as project health. When it stops the worker, the same thread resumes once after a fresh preflight. A sandboxed check whose runner never started is run once more.
2. **Verification under load.** The post-check observation is bounded by at least 180 s or 8× the measured snapshot cost, at most 15 min, and gets one doubled retry. `CODEX_TEAM_OBSERVATION_TIMEOUT_MS` overrides the bound. A persistent timeout is recorded as `verification.status: "observer_timeout"`, together with the check results, and the acceptance refusal says that the checks did not fail. An abnormal end never leaves `running` behind.
3. **Waiter exits instantly / status `verificat`.** Compact output halved the status string to fit its cap, so `verification_failed` read as `verificat` and then as an empty string. Status is no longer shortened. A waiter started on a finished job returns `alreadyFinished` and says not to re-arm it. The recovery card lists wait commands only for live jobs.
4. **Bogus `gitConfigChanged`.** Linked worktrees share the main repository's `.git/config`, and sibling sessions add `[branch "..."]` tracking sections to it. Codex also injects `GIT_CONFIG_COUNT/KEY/VALUE`. The plugin now compares effective configuration by entries.
   - Injected `command line:` entries are dropped.
   - `branch.<name>.remote/merge/...` changes are reported under `ignored`.
   - Remote URLs, filters, hooks, includes and core settings still count.
   - A shared Git directory is flagged.
5. **Commits from linked worktrees.** Codex never commits. A commit would need the common `.git` (objects, refs, hooks, config), so making the gitdir writable is not safe. The worker prompt says so, and accepted jobs say who commits: the lead, or `codex_integrate` for worktree and branch-mode jobs.
6. **Offline registry in checks.** Checks that run `cargo`, `rustc` or `rustup` directly receive the host's `CARGO_HOME` and `RUSTUP_HOME`, recorded as `autoPassEnv`, and Codex's shell gets them too. A failed check whose output shows cargo missing its registry or toolchain carries a `toolchainHint`. `codex_doctor` reports whether the two variables are set.
7. **Ultrafast.** See Service tiers.
8. **Latest CLI.**
   - `node scripts/cli-compat.mjs <codex>` checks every flag the plugin passes and the tiers the CLI supports, without model calls.
   - Deadline finalize no longer treats CLI notice items as tool use.
   - The reviewer and the native review accept a recovered reconnect notice.
   - The containment probe recognises the network-off sentinel environment of Codex's default Windows sandbox mode by value.

### Found while testing against the real CLIs

- **Worktree integration on `core.autocrlf` machines.** Integration compared the original's clean LF files with the worktree's CRLF checkout and refused ("Original file changed during integration preflight"). It now checks the original against its own job-start snapshot.
- **Scout briefs.** A 0.163.0 scout wrote prose into `draftAssignment.scope`. Path fields now carry schema descriptions and prompt guidance, and validation stays strict.
- **Scout evidence.** Scouts on both CLIs read files through a PowerShell literal list (`$paths = @(...); foreach ($path in $paths) { Get-Content -LiteralPath $path }`) and failed the evidence floor. Such reads now count, but only when the output contains the file's content. Codex's quote-concatenated command display is decoded.
- **PATH CLI 0.162.1 on this machine.** Its sandbox setup failed on a runtime DLL held by the running Codex desktop app (os error 32). 0.163.0 and 0.153.2 set up the same folders. The failure is now named, as described in fix 1.

### Tests

- `tests/v122.test.mjs` adds regression tests for every item above.
- A date-dependent state-card test is fixed.
- The suite still runs against a fake Codex. The opt-in real-CLI tests (`CODEX_TEAM_REAL_CLI=1`, `CODEX_TEAM_REAL_SANDBOX=1`) use the selected CLI and the host's Codex home, without model calls.
- A few existing latency budgets and fixed waiting windows assume an idle machine, and they also fail on 1.2.1 under heavy load.

Earlier releases are described by version in [docs/REFERENCE.md](docs/REFERENCE.md).
