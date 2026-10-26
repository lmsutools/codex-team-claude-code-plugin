---
name: weedo-rust-dev-skill
description: >-
  Senior-level playbook for planning, scaffolding, and maintaining large-scale Rust
  applications for Windows, macOS, and/or Linux with fast, multi-core-friendly builds.
  Use this skill when the user starts or pre-plans a big Rust project, designs a Cargo
  workspace or crate architecture, chooses target platforms, complains about slow Rust
  compile/link/test times or a slow TDD loop, wants to use rented remote VMs or many-core machines for
  builds, configures profiles/linkers/CI/caching, reviews Rust architecture for
  borrow-checker or async pain at scale, or asks for modern (edition 2024, Rust 1.9x)
  practices.
---

# Weedo Rust Dev Skill

Goal: make big Rust codebases (100k–1M+ LOC) pleasant to work in. That means
**edit→check in seconds, edit→test in under ~10 s, clean CI in minutes**, cores that
are actually used (local or rented), and an architecture that doesn't trigger refactors
that spread across every crate. Ship on Windows, macOS, and/or Linux, and keep the
others one playbook away.

The two scaling problems are linked, and both get solved at planning time:

1. **Build latency** (the #1 complaint about Rust at scale). Cargo can only use all
   your cores if the crate graph is wide. One giant crate or a long dependency chain
   leaves cores idle, and debuginfo, linking, monomorphization, and proc-macros make
   it worse.
2. **Architectural rigidity.** Ownership, lifetimes, and `Send`/`'static` live in type
   signatures, so a late change to the ownership model spreads everywhere.

The crate graph you pick for architecture reasons *is* your build-parallelism graph, so
plan the two together.

## Step 0: always do this first

1. **Platform intake.** If the project has no `PLATFORMS.md`, **ask the owner** (use
   `ask_question` when available) before any planning, scaffolding, CI, or release work:
   - Ship now: Windows / macOS / Linux (multi-select)
   - Likely within ~12 months (multi-select; default = all not shipped now)
   - App kind: desktop GUI / CLI / server or background service / library
   - CPU architectures: x64 / arm64 / both

   Record the answers in `PLATFORMS.md` (template:
   [resources/templates/PLATFORMS.md](resources/templates/PLATFORMS.md)). If the file
   exists, **read it instead of asking**. When the owner signals a change ("clients on
   Mac now"), run the expansion playbook in
   [platforms.md §4](references/platforms.md#4-expansion-playbook-my-clients-are-on-maclinux-now).
2. **Environment check.** Run [check_env.sh](scripts/check_env.sh) (macOS/Linux) or
   [check_env.ps1](scripts/check_env.ps1) (Windows). It reports the toolchain, cores,
   RAM, **free disk**, linker, and OS speed traps (XProtect, Defender/Dev Drive). Don't
   assume nightly is available. Label anything nightly-only.
   - **If on macOS:** Explicitly remind the user to **Flip the One-Time macOS XProtect Switch (30 Seconds on This Mac)** if not already enabled:
     ```bash
     sudo spctl developer-mode enable-terminal
     ```
     and toggle their Terminal / IDE on in **System Settings → Privacy & Security → Developer Tools** so Apple's `syspolicyd` stops scanning every newly linked Rust test and build-script binary on first run.

## Choose the workflow

| Situation | Go to |
| :-- | :-- |
| New project / pre-planning | **Workflow A** |
| Existing project builds slowly | **Workflow B** |
| TDD / test loop is slow | [fast-tdd.md](references/fast-tdd.md) |
| Using rented VMs / many-core machines | **Workflow D** → [remote-vm-builds.md](references/remote-vm-builds.md) |
| Architecture or design review | **Workflow C** |
| Adding an OS later | [platforms.md §4](references/platforms.md#4-expansion-playbook-my-clients-are-on-maclinux-now) |
| CI, lints, supply chain, release | [tooling-and-ci.md](references/tooling-and-ci.md) |
| Which language/ecosystem features to use | [modern-rust.md](references/modern-rust.md) |

---

## Workflow A: pre-plan and scaffold a new large project

1. **Platform intake** (Step 0) → Ship / Ready / Out tiers ([platforms.md §2](references/platforms.md#2-support-tiers)).
   Every non-shipped OS defaults to **Ready**: it's compile-checked in CI on every PR, so
   adding it later is cheap.
2. **Write the build-speed budget into the plan** (adjust with the owner):
   incremental `cargo check` < 2 s · incremental single-crate test < 10 s ·
   clean build < 3–5 min on a dev laptop · warm CI < 10 min.
3. **Design a wide, shallow crate graph**
   ([architecture.md §1](references/architecture.md#1-crate-topology-the-build-graph-is-the-architecture)):
   `domain` → `app` (ports) → sibling adapters + one `platform` crate → **thin binary**.
   Depth ≤ 4.
4. **Fix the ownership topology** ([architecture.md §2](references/architecture.md#2-ownership--state-rules)):
   IDs/handles between entities, no lifetimes on stored types, a deliberate state model
   per subsystem.
5. **Spike the skeleton** (~200 lines: every port trait, async boundary, `Send` bound,
   one dummy adapter, one `tokio::spawn`). It must compile cleanly before the team
   builds on it ([architecture.md §5](references/architecture.md#5-the-skeleton-spike-before-committing-to-an-architecture)).
6. **Scaffold**:
   ```bash
   bash <skill>/scripts/scaffold_workspace.sh <name> [dir] \
     --ship windows --ready macos,linux --kind desktop|cli|server|lib --arch x64,arm64
   ```
   This writes the workspace with tuned profiles, `[workspace.lints]`,
   `[workspace.dependencies]`, `.cargo/config.toml` (per-OS linkers),
   `rust-toolchain.toml` (all Ship + Ready targets), `PLATFORMS.md`, `AGENTS.md`,
   `deny.toml`, nextest config, `.gitattributes`, and a CI workflow whose matrix
   matches the tiers.
7. **Verify**: `cargo check --workspace --all-targets`, then
   `cargo check --target <triple>` for each Ready target, then `cargo build --timings` +
   [timings_parallelism.py](scripts/timings_parallelism.py).

## Workflow B: diagnose and fix a slow build (measure first, then change things)

1. Run [build_audit.sh](scripts/build_audit.sh) (`--full` adds a timed clean build and
   a timed incremental rebuild). It writes a Markdown report: profiles, linker,
   proc-macro and build-script counts, duplicate deps, workspace depth, test-binary
   count, rust-analyzer target dir, OS speed traps, and parallelism numbers.
2. Classify where the time goes using `--timings` + `timings_parallelism.py`:
   - long serial chain / idle cores → crate graph (architecture.md §1)
   - one huge crate → split by change frequency, move generics out
   - codegen-heavy → monomorphization (build-performance.md §5)
   - proc-macro / build-script heavy → build-performance.md §6
   - link-heavy → linker, debuginfo, fewer test binaries (§3, §4, §8)
3. Apply [build-performance.md](references/build-performance.md) **in order** (§1 OS
   fixes are free and often the biggest local win). Re-measure after each change and
   keep only what helps.
4. Report before/after numbers.

## Workflow C: architecture review

Check against [architecture.md](references/architecture.md),
[platforms.md §3](references/platforms.md#3-portability-rules-always-on-even-with-a-single-ship-target),
and [modern-rust.md](references/modern-rust.md). Report lifetime contagion,
`Arc<Mutex<_>>` sprawl, generic-parameter explosion, workspace-wide error enums,
async-trait-object misuse, `cfg(target_os)` leaking outside the `platform` crate, and
crate-graph depth. For each finding, propose the smallest fix that doesn't spread.

## Workflow D: use remote VMs / many-core machines to the max

Follow [remote-vm-builds.md](references/remote-vm-builds.md) strictly, in order:
measure `max useful cores = work / critical path` → fix the critical path → choose
what to offload (the inner loop usually stays on a fast local machine) → size the VM
(cores ≤ useful parallelism, ≥ 2 GB RAM/core, local NVMe) → pick a workflow (remote dev
box / remote build / build-once-test-many) → verify utilization > 60%.
Tune `-Zthreads` on the VM with [zthreads_sweep.sh](scripts/zthreads_sweep.sh) instead
of guessing (build-performance.md §7).
- **Zero-waste VM rule (never pay for idle VMs during LLM review):** On first connect,
  install the dead-man's switch (`scripts/remote_build.sh <host> --install-watchdog 15`)
  so the VM powers off after 15m of zero `cargo`/`rustc` activity, and pass `--poweroff`
  on pre-review bursts (`scripts/remote_build.sh <host> --poweroff ...`) so the VM shuts
  down immediately before the local LLM begins reviewing logs/diffs.

## Workflow E: rescue / migrate an existing advanced Rust codebase (Brownfield)

Never attempt a "Big Bang" crate split on an existing, heavily developed Rust project.
Follow [brownfield-migration.md](references/brownfield-migration.md) in strict order:
1. Run `node scripts/check-rust-arch.mjs . --plan` to X-ray existing debt and generate
   the 5-phase Strangler-Fig migration plan.
2. Run `node scripts/check-rust-arch.mjs . --write-baseline` to freeze existing legacy
   violations in `.codex-team/arch-baseline.json` (**Ratchet Mode**: existing debt is
   tolerated so feature work continues, while any **new** violation fails immediately).
3. Execute the 5 phases incrementally (Phase 0 zero-code linker/profile wins → Phase 1
   unify `[workspace.dependencies]` + merge `tests/it/main.rs` → Phase 2 extract
   `crates/platform` & `crates/telemetry` → Phase 3 carve out `crates/domain` with
   `pub use` re-export shims → Phase 4 extract heavy adapters in parallel behind
   `Arc<dyn Port>`), tightening `--write-baseline` after each phase until debt hits 0.

---

## Non-negotiable defaults (apply silently unless the owner objects)

- Edition **2024**, `resolver = "3"`, toolchain pinned in `rust-toolchain.toml`.
- Shared deps in `[workspace.dependencies]`; lints in `[workspace.lints]`.
- Dev profile: `debug = "line-tables-only"`, no debuginfo for third-party deps.
- Thin binary crates; logic in libs.
- One integration-test binary per crate (`tests/it/main.rs`). Measured 3.4× faster
  rebuild and ~10× faster test start on macOS against 20 separate files.
- TDD loop: scope to one crate (`-p`), red phase via `cargo check --tests` /
  rust-analyzer, `bacon` watcher (template `resources/templates/bacon.toml`), and
  workspace-wide tests only before push or in CI ([fast-tdd.md](references/fast-tdd.md)).
- rust-analyzer gets its own target dir. Use `cargo nextest` for tests.
- No lifetimes on domain/service structs; entities link by ID.
- `Arc<dyn Trait>` at subsystem boundaries. Native `async fn` in traits is **not**
  dyn-compatible, so use `async-trait`/`dynosaur`/manual boxing for `dyn`.
- Libraries: `thiserror` (one error type per crate). Binaries: `anyhow`/`color-eyre`.
- `tracing` for observability in domain crates; isolate `sentry` + `sentry-tracing` in a single `crates/telemetry` adapter crate (template: [telemetry.rs](resources/templates/telemetry.rs), guide + closed-loop Sentry→worktree triage: [telemetry-and-sentry.md](references/telemetry-and-sentry.md)). Every `unsafe` needs a `// SAFETY:` comment.
- OS-specific code only in the `platform` crate. OS-only deps are target-scoped. Every
  Ready OS is compile-checked in CI.

## What NOT to do

- Don't skip the platform intake or silently assume one OS.
- Don't put `-Z` flags or ad-hoc `RUSTFLAGS` in the shared config or shell profiles.
  Stable rejects `-Z`, and changing flags invalidates the cache. Use the fast-lane
  wrappers with their own target dir.
- Don't split into dozens of tiny crates. Split by change frequency and dependency
  weight.
- Don't use fat LTO / `codegen-units = 1` in day-to-day profiles (only in `dist`).
- Don't recommend Cranelift for tests on macOS/Windows: no unwinding there, so
  `#[should_panic]` breaks.
- Don't rent a bigger VM before measuring `max useful cores`.
- Don't run benchmarks or experiments that create extra target dirs without checking
  free disk first. Delete each experiment's target dir before the next.
- Don't claim a speed-up without timings.
