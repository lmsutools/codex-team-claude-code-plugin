# Modern Rust Baseline (stable 1.99, edition 2024, October 2026)

Use these defaults in new code. Check the installed toolchain with `rustc -V` before
using anything newer than it.

## Edition 2024 (stable since 1.85). Use it for every crate.

| Change | Practical effect |
| :-- | :-- |
| `resolver = "3"` | MSRV-aware dependency resolution: Cargo prefers versions compatible with `rust-version`. |
| Merged doctests | One doctest binary per crate, so far faster `cargo test`. |
| RPIT lifetime capture | `-> impl Trait` captures all in-scope lifetimes. Narrow it with `+ use<'a, T>`. |
| `if let` / tail-expression temporary scopes | Fewer surprising lock guards living too long (fewer deadlocks). |
| `unsafe extern "C" { }`, `#[unsafe(no_mangle)]` | Unsafety is explicit in FFI declarations and attributes. |
| `unsafe_op_in_unsafe_fn` warns | Unsafe operations need an `unsafe {}` block even inside `unsafe fn`. |
| References to `static mut` denied | Use atomics, `OnceLock`, `LazyLock`, or `Mutex`. |
| `gen` keyword reserved | Room for generators later. |
| `Future`/`IntoFuture` in prelude | Fewer imports. |
| Let chains (1.88, edition 2024) | `if let Some(x) = a && let Ok(y) = f(x) && y > 3 { … }` |

Migrate existing crates with `cargo fix --edition`, then set `edition = "2024"`.

## Language and std features to use

- `async fn` in traits / RPITIT (1.75), **static dispatch only**. For `dyn`, use
  `async-trait`, `dynosaur`, manual `Pin<Box<dyn Future>>`, or enum dispatch. Use
  `trait_variant::make(Send)` when futures must be `Send`.
- Async closures `async || {}` and `AsyncFn*` bounds (1.85).
- `std::sync::{LazyLock, OnceLock}` (1.80) replace `lazy_static`/`once_cell`.
- `#[expect(lint)]` (1.81) instead of `#[allow]`: it warns when the allow is no longer
  needed.
- Trait upcasting `&dyn Sub → &dyn Super` (1.86).
- Precise capturing `use<..>` (1.82), `&raw const/mut` (1.82), inline `const {}` blocks (1.79).
- `core::error::Error` (1.81), so `no_std`-friendly error types work.
- Build scripts use `cargo::` directives (1.77): `cargo::rerun-if-changed=…`.
- `build.build-dir` in Cargo config (1.91).

To verify before relying on it (these were seen only in release-note summaries; check
`releases.rs` or the official blog): v0 symbol mangling default (1.97), Cargo-native
"deny warnings" setting (1.97), a built-in `debug` profile (1.99), incremental disabled
by default under `CI` (1.99), workspace-inherited dependency `default-features`
override (edition 2024).

## Unstable features worth tracking (nightly only)

| Feature | Why it matters | Status (Oct 2026) |
| :-- | :-- | :-- |
| Parallel frontend `-Zthreads` | Multi-core compilation inside one crate | Stabilization plan accepted Jul 2026, still nightly |
| Cranelift backend | Fast debug codegen | Preview rustup component. No unwinding on macOS/Windows. |
| `resolver.feature-unification` | Native replacement for cargo-hakari | Nightly (cargo#14774) |
| Dyn-compatible async traits | Drop `async-trait` | Not available |

## Ecosystem defaults (reasonable picks, not mandates)

| Need | Default | Alternatives |
| :-- | :-- | :-- |
| Async runtime | `tokio` | `smol` for small tools |
| HTTP server | `axum` (+ `tower`, `tower-http`) | `actix-web` |
| HTTP client | `reqwest` | `hyper` directly |
| SQL | `sqlx` (keep its macros in one crate) | `diesel`, `sea-orm` |
| Serialization | `serde` + `serde_json` | `rkyv`, `postcard` for binary |
| Errors | `thiserror` 2 (libs), `anyhow` / `color-eyre` (bins) | `snafu` |
| Observability | `tracing`, `tracing-subscriber`, `opentelemetry` | |
| CLI | `clap` 4 (derive) | `argh` for compile-time-sensitive tools |
| Config | `figment` or `config` | |
| Date/time | `jiff` | `chrono`, `time` |
| CPU parallelism | `rayon` | `crossbeam` |
| Shared state | `parking_lot`, `arc-swap`, `dashmap` | |
| Arenas / IDs | `slotmap`, `la-arena` | `generational-arena` |
| Testing | `insta`, `proptest`, `rstest`, `nextest` | `divan` / `criterion` for benchmarks |

Compile-time awareness: `clap` derive, `serde` derive, `sqlx` macros, and the full
`tokio` feature set all cost build time. Enable only the features you need, and keep
them out of the crates you edit most.
