# Architecture for Large Rust Codebases

These rules keep the borrow checker from becoming an architecture problem, and they keep
the crate graph parallel. Each rule has a **why** so you can tell when it's OK to break it.

---

## 1. Crate topology: the build graph *is* the architecture

Cargo compiles crates in parallel when they don't depend on each other. Codegen and
incremental compilation also work per crate. So the shape of your workspace decides how
many cores are busy, and how much gets rebuilt after an edit.

### Recommended layering

```text
                       apps/<name>   (thin bin: main.rs = wiring only)
                      /     |      |      \
          crates/http  crates/db  crates/platform  crates/ui ...   <- adapters + OS layer (siblings!)
                      \     |      |      /
                         crates/app            <- use-cases + port traits (no I/O deps)
                              |
                         crates/domain         <- pure types + logic, near-zero deps
                              |
               crates/test-support (dev-dep only)
```

`crates/platform` is the only crate allowed to contain `#[cfg(target_os = ...)]`. It
implements OS ports (paths, services, keychain, notifications) for every Ship and Ready
OS listed in `PLATFORMS.md` (see platforms.md §3).

Rules:

- **Adapters are siblings.** `db` must not depend on `http`. Sibling crates compile
  concurrently and are invalidated independently.
- **`domain` is tiny and stable.** It changes rarely, so the layers above it rarely
  rebuild. Keep heavy deps out of it (no `tokio`, `sqlx`, `axum`, `reqwest`). `serde`
  derives are acceptable, but put them behind a `serde` feature if the domain crate
  is large.
- **Port traits live in `app`**, implemented in adapters (dependency inversion). Adapters
  then build in parallel with each other and with `app`'s dependents.
- **The binary is a composition root.** It's always re-linked, so keep it to a few hundred
  lines that read config, build adapters, inject them, and run.
- **Depth ≤ 4** from the binary to the deepest workspace crate. A chain like
  `a→b→c→d→e→f` compiles one crate at a time.
- **Split by change frequency and dependency weight, not by file count.** A good split
  separates code that changes daily from code that changes monthly, or isolates a heavy
  dependency (e.g. `aws-sdk-*`, `sqlx`, `tonic`/`prost` codegen) so only one crate pays
  for it.
- **Codegen crates (protobuf, OpenAPI, GraphQL) go in their own crate.** Generated code is
  large and changes rarely, so put it behind a stable boundary.
- **Avoid "god" crates** like `common`/`utils` that everything depends on and everyone
  edits. They turn every change into a full rebuild. Prefer small, purpose-named crates.
- **Too many tiny crates also hurts**: each crate has fixed costs (metadata, a rustc
  process, link inputs). Rough guide: 2k–30k LOC per crate. Measure with `--timings`.

### Feature flags

- Features are **additive and unified across the build**. If one crate enables
  `tokio/full`, every crate that uses tokio gets it.
- Building `-p some-crate` alone can select different features than `--workspace`, which
  forces dependencies to rebuild when you switch. Fixes:
  - `cargo-hakari` (a generated "workspace-hack" crate) is the stable, proven fix for
    big monorepos.
  - `resolver.feature-unification = "workspace"` in `.cargo/config.toml` is the native
    fix, but it's **nightly-only** (cargo#14774). Check the status before recommending it.
- Set `default-features = false` for heavy dependencies in `[workspace.dependencies]`
  and enable only what each crate needs.

---

## 2. Ownership & state rules

### 2.1 Entities reference each other by ID, never by `&` or `Rc`

```rust
// ✗ spreads lifetimes, can't cross await / threads / serialization
struct Order<'a> { customer: &'a Customer }

// ✓ Copy + 'static + Send + Sync, serializable, cache-friendly
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct CustomerId(u64);
struct Order { customer: CustomerId }
```

For in-memory graphs (ASTs, scene graphs, dependency graphs), use arenas with typed
handles: `slotmap`, `generational-arena`, `la-arena`, or `Vec<T>` + `u32` newtype indices.

### 2.2 No lifetimes on domain or service types

- Struct fields use owned or shared-immutable types: `String`, `Vec<T>`, `Arc<str>`,
  `Arc<[T]>`, `bytes::Bytes`, `Arc<T>`. Cloning an `Arc` costs one atomic increment.
- **Lifetimes are fine** in function parameters (`fn f(x: &str)`), in short-lived
  view/iterator types, and in zero-copy parsers. The rule is about types that get
  stored or passed across layers.
- Make it a code-review rule in `AGENTS.md`: "No `<'a>` on structs in `domain`/`app`
  without a perf justification."

### 2.3 Choose a state model **per subsystem**, deliberately

| Pattern | Use when | Watch out for |
| :-- | :-- | :-- |
| Owned by one task (actor: `mpsc` in, `oneshot` out) | Complex state machines, sequential consistency, I/O sessions | Bounded channels for backpressure, extra hop latency, error/shutdown plumbing |
| `Arc<Mutex<T>>` (std or `parking_lot`) | Small state, short critical sections, **never held across `.await`** | Lock ordering; contention under high write load |
| `Arc<RwLock<T>>` | Read-heavy, rare writes | Writer starvation; often slower than `Mutex` for tiny sections |
| `arc-swap` / `ArcSwap<Config>` | Read-mostly snapshots (config, routing tables) | Writers replace the whole value |
| `dashmap` / sharded maps | High-concurrency key-value caches | Iteration semantics; deadlocks if you hold refs |
| `tokio::sync::Mutex` | Only when the lock *must* be held across `.await` | Slower; usually a design smell |

Senior heuristic: **actors for complex stateful workflows, plain locks for simple shared
data.** Don't impose either everywhere. Enable the clippy lint `await_holding_lock` (on
by default as a warning; deny it in `[workspace.lints]`).

### 2.4 Async boundaries

- Assume anything spawned needs `Send + 'static`. Design service structs to be
  `Clone` (cheap `Arc` inside) so handlers can own a copy.
- Keep `tokio` out of `domain`. Ideally `app` holds sans-IO logic too (pure state
  machines fed by events), which gives fast, deterministic tests with no runtime.
- Use `tokio::task::JoinSet` / `tokio_util::task::TaskTracker` +
  `CancellationToken` for structured shutdown from day 1.
- Use `spawn_blocking` (or a dedicated `rayon` pool) for CPU-heavy work. Never block
  the async runtime.

---

## 3. Abstraction boundaries: generics vs `dyn`

**At subsystem boundaries (repositories, clients, plugins, clocks), default to `dyn`.**

```rust
pub struct OrderService {
    repo: Arc<dyn OrderRepo>,      // not OrderService<R: OrderRepo, C: Clock, M: Metrics>
    clock: Arc<dyn Clock>,
}
```

Why:

- Generic services get monomorphized into **every downstream crate** that instantiates
  them, so the codegen lands in the leaf crate you edit most. `dyn` keeps the code
  compiled once, in its home crate.
- Signatures stay readable, and type parameters don't spread up the stack.
- An indirect call costs nanoseconds, which is invisible next to I/O.

**Async + `dyn` caveat (important):** native `async fn` in traits (stable since 1.75) is
**not dyn-compatible**. Options:

1. `#[async_trait]` (the `async-trait` crate): boxes every future. Simple, and the overhead
   doesn't matter at I/O boundaries.
2. `dynosaur`: keeps native static dispatch and generates a `Dyn*` wrapper for `dyn` use.
3. Manual: `fn get(&self, id: Id) -> Pin<Box<dyn Future<Output = Result<T>> + Send + '_>>`.
4. Closed set of implementations → an `enum` with `match`, with no boxing at all.

Also add `trait_variant::make(Send)` when a trait must be usable with `tokio::spawn`.

**Use generics for** small, hot, inlined code: iterators, numeric kernels, codecs,
data structures. Keep generic functions thin (see build-performance.md §5).

---

## 4. Errors

- One error type per library crate (`thiserror`), at a coarse enough granularity that
  callers can act on it.
- Binaries and tests use `anyhow` / `color-eyre` for context chains.
- **Don't** create a workspace-wide `Error` enum in `common`. Every new variant then
  rebuilds every crate, and it couples unrelated subsystems.
- Map errors at layer boundaries (`impl From<DbError> for AppError` lives in the adapter
  or app crate, not in domain).

---

## 5. The skeleton spike (before committing to an architecture)

Write ~200 lines that include:

- every port trait, with real signatures (async, `Send` bounds, error types),
- one dummy adapter per port,
- the composition root that wires them, plus `tokio::spawn` of a handler that uses them,
- one plugin/callback/middleware path if the design has one.

Go/no-go: it compiles with **no explicit lifetimes on stored types, no `'static` hacks,
no `unsafe`, and no `Arc<Mutex<_>>` you can't justify**. If not, change the design now,
while that costs 200 lines instead of 200k.

---

## 6. Testing architecture

- Unit tests sit next to the code. Most logic lives in sans-IO `domain`/`app`, so these
  tests are fast and need no runtime.
- Integration tests: **one binary per crate** (`tests/it/main.rs` with `mod foo;`).
  Each `tests/*.rs` file is a separate binary with its own link step.
- A shared `test-support` crate (fixtures, fakes, builders) is a **dev-dependency only**.
- Snapshot tests with `insta`. Property tests with `proptest` in hot-path crates.
- `cargo nextest` runs each test in its own process, in parallel across cores.
- Since edition 2024, doctests are merged into one binary per crate. Still disable them
  (`[lib] doctest = false`) for internal crates that have no doc examples.
