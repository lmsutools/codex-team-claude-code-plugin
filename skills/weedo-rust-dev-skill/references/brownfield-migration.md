# Brownfield Rescue: Migrating an Advanced Rust Codebase Without Stopping Feature Work

When an ambitious Rust project is already deep in development — with a monolithic crate,
deep dependency chains (`a → b → c → d → e → f`), scattered `#[cfg(target_os = ...)]`,
20 separate `tests/*.rs` files, or `tokio`/`sqlx` tangled into domain types — **never
attempt a "Big Bang" rewrite.**

A Big Bang split breaks hundreds of imports and borrow-checker lifetimes at once. Instead,
use this **5-Phase Strangler-Fig + Ratchet Playbook**, ordered by highest compile-speed
ROI and lowest risk per step.

---

## Step 0: Run the Automated Brownfield X-Ray & Freeze the Ratchet

Before changing a single `.rs` file:

```bash
# 1. Inspect the exact architectural debt and generate the 5-phase plan:
node scripts/check-rust-arch.mjs . --plan

# 2. Freeze existing debt into .codex-team/arch-baseline.json ("Stop the Bleeding"):
node scripts/check-rust-arch.mjs . --write-baseline
```

**Why Ratchet Mode (`arch-baseline.json`) is critical:**
- Existing legacy violations are tolerated so you can ship urgent fixes today.
- **Any NEW violation introduced by a human or AI worker fails immediately** (`error[arch::*]`).
- Each time you complete a migration phase below, re-run `node scripts/check-rust-arch.mjs . --write-baseline` to tighten the ratchet downward until `baselined = 0`.

---

## Phase 0: Zero-Code Build Accelerators (15 Minutes, Zero Code Risk)

Fix the compiler/linker setup *before* refactoring so every subsequent `cargo check` and
`cargo test` runs 2–3× faster:

1. Drop in `.cargo/config.toml` from [`resources/templates/cargo-config.toml`](../resources/templates/cargo-config.toml) (`lld`/`wild`, `split-debuginfo = "unpacked"`, `sccache` if installed).
2. Add `[profile.dev]` (`debug = "line-tables-only"`) and `[profile.dev.package."*"]` (`debug = false`) to the root `Cargo.toml`.
3. Run `scripts/build_audit.sh` once to record the baseline `cargo build --timings` critical path and `Max Useful Cores`.

---

## Phase 1: Kill Cache Thrashing & Test Link Storms (30–60 Minutes, 2–5× Faster TDD)

1. **Unify `[workspace.dependencies]` features:**
   - If the repo is already a workspace, hoist all shared crates (`serde`, `tokio`, `tracing`, `reqwest`, `sqlx`) and their union of features into root `[workspace.dependencies]`.
   - Remove per-crate `features = [...]` overrides in member `Cargo.toml` files so `cargo test -p <crate>` and `cargo test --workspace` share one artifact cache hash.
   - If the repo is a single-crate monolith, add a `[workspace]` section (`resolver = "3"`, `members = ["crates/*"]`) to the root `Cargo.toml` while keeping the root package in place as the temporary composition root.
2. **Consolidate `tests/*.rs` into `tests/it/main.rs`:**
   - Move `tests/foo.rs`, `tests/bar.rs`, etc. into `tests/it/foo.rs`, `tests/it/bar.rs` with a single `tests/it/main.rs` (`mod foo; mod bar;`).
   - This eliminates $N - 1$ heavy link steps immediately with zero logic changes.

---

## Phase 2: Extract Leaf Infrastructure Crates (`crates/platform` & `crates/telemetry`)

Start at the **leaves** (things that don't need business logic):

1. **`crates/platform`:**
   - Create `crates/platform` and move scattered `#[cfg(target_os = ...)]`, `#[cfg(unix)]`, and `#[cfg(windows)]` helpers into OS modules (`windows.rs`, `macos.rs`, `linux.rs`).
   - **The Re-Export Shim Trick:** At the old module path in the legacy crate, leave a 1-line re-export:
     ```rust
     pub use my_app_platform::os_data_dir;
     ```
     Existing callers continue to compile with zero edits while the OS conditional compilation is now cleanly isolated.
2. **`crates/telemetry`:**
   - Move `tracing-subscriber` and `sentry` initialization into `crates/telemetry` ([`resources/templates/telemetry.rs`](../resources/templates/telemetry.rs)) so only the binary crate links Sentry/TLS.

---

## Phase 3: Carve Out Pure `crates/domain` via Re-Export Shims (The Strangler Seam)

To break up a "god crate" without fixing 500 import statements at once:

1. Create `crates/domain` (zero `tokio`, `sqlx`, `reqwest`, `axum`).
2. Move pure value types, IDs (`CustomerId(u64)`), enums, and pure validation functions into `crates/domain`.
3. In the legacy crate's old module (`src/models.rs` or `src/types.rs`), replace the moved definitions with:
   ```rust
   pub use my_app_domain::*;
   ```
4. **Result:** 100% of legacy code still compiles without changing a single import path, **and** every new adapter crate you extract next can depend cleanly on `crates/domain` without pulling in the legacy monolith!

> **Untangling `<'a>` lifetimes or `Arc<Mutex<GodState>>` during extraction:**
> - Replace borrowed struct references (`struct Node<'a> { parent: &'a Node<'a> }`) with typed ID handles (`NodeId(u32)` or `slotmap::DefaultKey`) step by step.
> - Split a single `Arc<Mutex<AppState>>` by subsystem: extract read-mostly config into `ArcSwap<Config>` and subsystem state into dedicated actors (`mpsc::Receiver<Cmd>`) or narrow `parking_lot::Mutex` fields.

---

## Phase 4: Extract Heavy Adapters in Parallel (`codex_batch` + `Arc<dyn Port>`)

Look at `cargo build --timings` from Phase 0 and pick the heaviest I/O or codegen subsystems (e.g., `sqlx`/Postgres, `axum` HTTP routes, gRPC/Protobuf codegen, S3/cloud SDKs):

1. Define an object-safe port trait in `crates/app` (e.g., `pub trait BillingStore: Send + Sync { ... }`).
2. Dispatch isolated `codex_start` (or parallel `codex_batch`) worktree jobs—each scoped to one new sibling adapter crate (`crates/db`, `crates/http`, `crates/proto`) implementing that port trait.
3. In the binary crate (`main.rs`), construct the concrete adapters and pass `Arc::new(adapter)` into the application services.
4. Tighten `.codex-team/arch-baseline.json` with `node scripts/check-rust-arch.mjs . --write-baseline` after each extraction until legacy violations hit **0**.
