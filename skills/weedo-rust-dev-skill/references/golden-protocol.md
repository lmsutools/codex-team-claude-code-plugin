# The Golden Protocol for Multi-Agent Rust Development

When multiple AI coding agents (`codex_batch` worktrees led by Claude Code, Antigravity, or Codex) build ambitious Rust software concurrently, naive parallelism hits four classic walls:

1. **Manifest & Lockfile Collisions:** Two parallel workers add crates or features to root `Cargo.toml` / `Cargo.lock`, causing merge conflicts and invalidating the entire workspace's Cargo feature hash.
2. **Cold Worktree Compiles or Lock Starvation:** Sharing `CARGO_TARGET_DIR` across parallel agents serializes every build on `.cargo-lock`; not sharing it forces 3-minute cold rebuilds per worktree.
3. **Silent AI Runtime & Security Bugs:** LLMs frequently write `std::fs::read_to_string` or `std::thread::sleep` inside `async fn` (starving Tokio workers), use `mpsc::unbounded_channel` (causing production OOMs under load), or put `#[derive(Debug)]` on structs holding `api_key` / `password` (leaking secrets into `tracing` and Sentry).
4. **Tautological AI Tests & Dependency Drift:** Agents write weak tests (`assert!(result.is_ok())`) that pass even when business rules are broken, or leave unused crates in `Cargo.toml` after refactors.

The **Golden Protocol** eliminates all four walls by combining **3-Beat Contract-First Fan-Out**, **50ms CoW Target Seeding**, **The 9 Golden Laws (`check-rust-arch.mjs`)**, and **Targeted Domain Mutation Testing**.

---

## 1. The 3-Beat "Contract-First Fan-Out" Wave Protocol

Never allow parallel `codex_batch` workers to edit root `Cargo.toml`, `Cargo.lock`, `crates/domain`, or `crates/app` at the same time. Every multi-task feature wave executes in **three distinct beats**:

```
Beat 1: Spine & Contracts (Serial, ~30-60s)
  ├── Define types in crates/domain + Arc<dyn Port> traits in crates/app
  ├── Scaffold new sibling crates via: node scripts/rust-add-crate.mjs <name>
  └── Run cargo check --workspace once (locks Cargo.lock + warms target/)
          │
          ▼  (50ms APFS / Btrfs / XFS CoW warmTarget per worktree)
Beat 2: Conflict-Free Adapter Fan-Out (Parallel codex_batch Worktrees)
  ├── Worker A: scope = ["crates/billing/**"]        (2-4s cargo check -p)
  ├── Worker B: scope = ["crates/store-postgres/**"] (2-4s cargo check -p)
  └── Worker C: scope = ["crates/notifier-smtp/**"]  (2-4s cargo check -p)
          │
          ▼  (Zero merge conflicts — disjoint directories, untouched Cargo.lock)
Beat 3: Composition Root & Verification (Serial, ~15-30s)
  ├── Wire Arc::new(Adapter::new(...)) in apps/<bin>/src/main.rs
  ├── Run node scripts/check-rust-arch.mjs (<50ms, enforces all 9 Golden Laws)
  └── Run cargo nextest run --workspace (+ cargo mutants -p <ws>-domain)
```

### Beat 1: Spine & Contracts (Serial)
Before spawning parallel workers:
1. **Scaffold any new sibling adapter crates** with the zero-dependency generator:
   ```bash
   node scripts/rust-add-crate.mjs billing
   node scripts/rust-add-crate.mjs notifier-smtp
   ```
   This registers `<ws>-billing` and `<ws>-notifier-smtp` in root `[workspace.dependencies]` and creates compliant `crates/<name>/Cargo.toml`, `src/lib.rs`, and `tests/it/main.rs` stubs in `<50ms`.
2. **Add shared third-party dependencies once** in root `[workspace.dependencies]` (with `default-features = false` and unified features).
3. **Define the contracts:** Add pure value types/invariants in `crates/domain` and object-safe port traits (`pub trait BillingPort: Send + Sync`) in `crates/app`.
4. **Warm the host cache once:** Run `cargo check --workspace --tests` on the main checkout. This resolves `Cargo.lock` and populates `target/debug/deps/`.

### Beat 2: Conflict-Free Adapter Fan-Out (Parallel `codex_batch`)
Launch parallel `codex_batch` tasks with `isolation: "worktree"`:
- **Strict Scope Enforcement:** Set each worker's `scope` to `["crates/<adapter>/**"]`. Root `Cargo.toml`, `Cargo.lock`, `crates/domain`, and `crates/app` are **out of scope**.
- **Instant CoW Target Seeding:** `warmTarget` (`scripts/rust.mjs`) clones `target/debug/{deps,build,.fingerprint}` into each worktree in ~50ms on macOS APFS (`cp -c -R`) and Linux XFS/Btrfs (`cp --reflink=always`).
- **Scoped Verification:** Each worker runs `cargo check -p <ws>-<adapter> --tests --message-format=json` and `cargo nextest run -p <ws>-<adapter>`, finishing in **1–4 seconds** with zero `.cargo-lock` contention.

### Beat 3: Composition Root & Verification Gate (Serial)
After all Beat 2 workers pass review:
1. Merge their branches (guaranteed conflict-free because their file scopes are disjoint `crates/<adapter>/**` subtrees).
2. Wire the concrete adapters (`Arc::new(BillingAdapter::new(...))`) into `apps/<bin>/src/main.rs`.
3. Run the workspace verification suite:
   ```bash
   node scripts/check-rust-arch.mjs
   cargo nextest run --workspace
   ```

---

## 2. The 9 Golden Laws (`scripts/check-rust-arch.mjs`)

`scripts/check-rust-arch.mjs` runs in **<50ms** without invoking `rustc`. It enforces **6 Workspace & Compile-Graph Laws** plus **3 Semantic Runtime & Security Laws** that catch the most dangerous AI-generated Rust mistakes before compilation even starts:

| # | Rule ID | Category | What It Enforces & Why |
|---|---|---|---|
| **1** | `arch::no_workspace_feature_thrash` | Build Speed | Forbids `dep = { workspace = true, features = [...] }` in member crates (except `crates/telemetry`). Prevents `cargo test -p` vs `--workspace` cache invalidation. |
| **2** | `arch::single_integration_test_binary` | Link Speed | Forbids multiple `tests/*.rs` files per crate; requires a single `tests/it/main.rs` entry point so Cargo links 1 test binary instead of N. |
| **3** | `arch::platform_cfg_isolation` | Portability | Forbids `#[cfg(target_os / target_family / unix / windows)]` outside `crates/platform`. Keeps 95%+ of the workspace 100% OS-agnostic. |
| **4** | `arch::pure_domain` & `arch::sibling_adapter_isolation` | Parallelism | Forbids IO/async crates (`tokio`, `reqwest`, `sqlx`, `axum`, `sentry`) in `crates/domain` and forbids adapter-to-adapter dependencies. |
| **5** | `arch::workspace_lints` | Hygiene | Requires `[lints] workspace = true` in every member crate so `await_holding_lock = "deny"` and `unsafe_op_in_unsafe_fn = "deny"` cannot be bypassed. |
| **6** | `arch::max_workspace_depth` | CPU Utilization | Enforces internal workspace dependency chain depth `<= 4` (`domain -> app -> adapter -> bin`) so Cargo compiles all adapters concurrently. |
| **7** | `arch::no_blocking_in_async` | Runtime Safety | Forbids `std::thread::sleep`, `std::fs::*`, and `reqwest::blocking` inside modules containing `async fn` (outside `#[cfg(test)]`). Prevents Tokio executor thread starvation. |
| **8** | `arch::no_unbounded_channels` | Memory Safety | Forbids `unbounded_channel(` in production `src/` code. Forces explicit bounded channels so backpressure never turns into a production OOM. |
| **9** | `arch::no_unredacted_secrets` | Security | Forbids raw `String` / `&str` fields named `password`, `secret`, `api_key`, `access_token`, `refresh_token`, `private_key`, or `client_secret` inside `#[derive(Debug)]` structs. Prevents credential leaks in logs and Sentry crash dumps. |

---

## 3. SOTA Quality Amplifiers: Mutation Testing & Dead-Dep Pruning

To verify that AI-written tests actually test business logic and don't leave dependency cruft:

### A. Sub-5-Second Domain Mutation Testing (`cargo-mutants`)
Because Law 4 keeps `crates/domain` 100% pure (zero IO, zero Tokio, <0.5s compile time), you can run **mutation testing** (`cargo-mutants`) on `crates/domain` in seconds:
```bash
# Install once:
cargo install --locked cargo-mutants

# Mutate only lines changed in the current branch/diff inside crates/domain:
cargo mutants -p <ws>-domain --in-diff <(git diff main...HEAD)
```
- **Why it's a superpower for AI code:** If an agent writes a weak test like `assert!(Order::new(...).is_some())` and forgets to test boundary conditions (`total_cents == 0` vs `< 0`), `cargo-mutants` rewrites `>= 0` to `> 0`, sees the test still pass, and flags a **survived mutant** so the agent strengthens the test immediately.

### B. Instant Dead-Dependency Pruning (`cargo-shear`)
During iterative tasks, AI workers often import a crate in `Cargo.toml`, refactor their approach, and forget to remove the unused dependency—slowing down every future build.
```bash
# Install once:
cargo install --locked cargo-shear

# Detect and remove unused dependencies across the workspace in <1 second:
cargo shear --fix
```
