# AGENTS.md: project rules for AI agents and humans

This workspace follows **weedo-rust-dev-skill**. Read `PLATFORMS.md` before any
platform, CI, or release work.

## Architecture
- Layering: `domain` → `app` (ports/traits, use-cases) → adapters + `platform`
  (siblings) → thin `apps/*` binaries. Keep crate depth ≤ 4. Adapters never depend on
  each other.
- Binaries only wire things together. Logic lives in library crates.
- Entities reference each other by ID newtypes, never by `&`/`Rc`.
- No lifetime parameters on structs in `domain`/`app` without a perf justification.
- Subsystem boundaries use `Arc<dyn Trait>`. Async methods used through `dyn` need
  `async-trait` (native async fn in traits isn't dyn-compatible).
- One error type per library crate (`thiserror`). `anyhow` only in binaries/tests.
  No workspace-wide error enum.
- Never hold a lock across `.await`.
- Never call `std::thread::sleep`, `std::fs::*`, or `reqwest::blocking` inside async modules; never use `unbounded_channel` in production code; never put raw `password`/`secret`/`api_key`/`access_token` fields inside `#[derive(Debug)]` structs.
- OS-specific code only in `crates/platform`. OS-only deps are target-scoped.

## Multi-agent parallel waves (The 3-Beat Golden Protocol)
- **Beat 1 (Spine & Contracts — Serial):** Define types in `crates/domain` and `Arc<dyn Port>` traits in `crates/app`. Add new sibling adapter crates with `node scripts/rust-add-crate.mjs <name>` and run `cargo check --workspace` once on the main checkout.
- **Beat 2 (Adapter Fan-Out — Parallel Worktrees):** Lock each worker's scope strictly to `crates/<adapter>/**` (never edit root `Cargo.toml`, `Cargo.lock`, `domain`, or `app` concurrently).
- **Beat 3 (Composition Root — Serial):** Wire concrete adapters in `apps/{{NAME}}/src/main.rs` and run `node scripts/check-rust-arch.mjs`.

## Build speed
- New dependency? Check `cargo tree -d`, transitive count, proc-macros/build scripts,
  and `default-features`. Put heavy deps in a single crate.
- Integration tests: one binary per crate (`tests/it/main.rs` + modules).
- Generic public fns with big bodies: use the non-generic inner-fn pattern.
- Don't add `-Z` flags or `RUSTFLAGS` to shared config. Use `scripts/cargo-fast.*`.
- Before experiments that create extra target dirs, check free disk space and clean up
  afterwards.

## Checks before finishing a change
```bash
node scripts/check-rust-arch.mjs   # <50ms static check of all 9 Golden Laws
cargo fmt --all
cargo clippy --workspace --all-targets
cargo nextest run --workspace      # or: cargo test --workspace
# plus, for each Ready/Ship target listed in PLATFORMS.md:
cargo check --workspace --all-targets --target <triple>
```
