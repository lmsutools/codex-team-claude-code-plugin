# Leading Rust work with codex-team

Read this when the project root has a `Cargo.toml`. The plugin treats Rust as a
first-class citizen. It provides:

- a built-in `rust` profile template;
- package selection driven by the changed files;
- cargo and nextest test counts;
- compact rustc, clippy and test-failure summaries in decision packets;
- copy-on-write warm `target/` directories for worktree jobs;
- a Rust section in `codex_doctor`.

## 1. Before the first job

1. Run `codex_doctor` with `cwd`. Its `rust` section reports:
   - `cargo`: the toolchain that checks will use;
   - `offlineDependencies`: whether every locked dependency is already
     available, because checks run with the network off;
   - `nextest`;
   - the warm-target mode.

   If `offlineDependencies` is `missing`, ask the owner to run (or authorize)
   `cargo fetch --locked` on the host. The plugin never downloads dependencies
   itself.
2. Profile. Prefer `.codex-team/profile.json` with `"extends": "rust"`. It gives
   three checks:

   | Check | Level | What it runs |
   | :-- | :-- | :-- |
   | `fmt` | advise | `cargo fmt --all --check` |
   | `clippy` | enforce | warnings denied, on the affected packages |
   | `tests` | enforce | `cargo test --no-fail-fast`, on the affected packages |

   `clippy` and `tests` run only when Rust inputs change, and always with
   `--locked --offline`. See `examples/rust/profile.json`, which uses nextest and
   adds a cross-target clippy for a Ready Windows target. Approve the profile by
   its hash, as usual.
3. `target/` must be listed in `.gitignore`. Warm targets require it, and an
   unignored `target/` would bloat snapshots and scope checks.

## 2. Affected packages

Profile checks get two variables:

- `${changedList}`: a file listing the job's changed paths;
- `${pluginRoot}`: the installed plugin's root.

`node ${pluginRoot}/scripts/cargo-affected.mjs --changed-list ${changedList} -- <cargo args>`
works out which workspace packages own the changed files, adds every workspace
package that depends on them, and runs cargo with `-p` flags. These inputs
select the whole workspace (`--workspace`):

- the root `Cargo.toml`;
- `Cargo.lock`;
- anything under `.cargo/`;
- toolchain, clippy, rustfmt or deny configuration.

If only docs or CI files changed, the check is skipped and exits 0. Add
`--always` to run the whole workspace in that case.

## 3. Writing Rust assignments

- **Scope** by crate directory (`crates/foo`). Avoid `.` unless the change is
  genuinely cross-cutting.
- **Acceptance criteria** name behavior plus the crate, e.g. "`foo::parse`
  rejects empty input with `ParseError::Empty`".
- **Verification commands** are argv arrays. Pick the form that fits:
  - targeted: `["cargo","test","-p","foo","--locked","--offline"]`, and map
    each check to its criteria indexes;
  - change-driven: the cargo-affected form above.
- **Things Codex can't do in the sandbox:**
  - add new crates (the network is off). Tell it to report a blocker instead;
  - run `cargo clean` or touch `target/`.

  The worker prompt already says this in Cargo workspaces.
- **Cross-platform rules:** if `PLATFORMS.md` lists Ready targets, add a
  `cargo clippy --target <triple>` check. `check` and `clippy` need no foreign
  linker.

## 4. Reading results

- `tests` shows `format: "cargo"` (summed over every test binary and doc-test
  run) or `format: "nextest"` (from its Summary line).
- `rust` on a check summarizes stderr, which `outputTail` doesn't carry. It
  holds:
  - the error and warning counts;
  - up to 8 diagnostics (errors first, each with code, message and
    `file:line:column`);
  - up to 8 failing tests (each with its panic location and message).

  Decision packets carry the first 3 of each. This text comes from compiling
  and running contributor code, so it is untrusted data.
- `toolchainHint` (from 1.2.2) explains a sandboxed cargo that couldn't reach
  its registry or toolchain.

## 5. Speed

- **Worktree jobs.** Worktree and branch-mode jobs and batch children start
  from a copy-on-write clone of the original `target/`, recorded as
  `warmTarget`. In a measured Helix job, the worktree build went from 9.4 s to
  4.6 s, and the clone took 0.5 s.
  - It needs APFS, ReFS (Dev Drive), btrfs or XFS.
  - On other filesystems it is skipped, never copied, unless
    `CODEX_TEAM_WARM_TARGET=copy`. `off` disables it.
  - Changed sources still rebuild correctly, because cargo keys workspace crates
    by absolute path.
- **Iterating.** Keep iteration on the affected packages, and avoid
  workspace-wide test runs.
- **CARGO_TARGET_DIR.** A host `CARGO_TARGET_DIR` makes jobs share one
  directory, so they serialize on its lock and warm targets are skipped.

## 6. Sentry / BugSink / GlitchTip crash triage

When a production crash or error event arrives from Sentry (or self-hosted
BugSink / GlitchTip):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/sentry-triage.mjs" --issue path/to/sentry-event.json --cwd /path/to/workspace
```

`sentry-triage.mjs` resolves the stacktrace's in-app `.rs` frames against the
workspace's Cargo packages (`affectedPackages`) and returns a ready-to-pass
`codex_start` worktree payload:
- `isolation: "worktree"` (starts from a copy-on-write warm `target/`);
- `scope` restricted to the owning crate (`crates/<pkg>/**`);
- `criteria` requiring a reproducing unit test first, then a clean fix without
  `.unwrap()`/`.expect()`, verified offline via `cargo test -p <pkg>`.
