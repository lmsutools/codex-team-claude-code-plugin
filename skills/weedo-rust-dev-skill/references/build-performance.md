# Build Performance Playbook (macOS + Windows first, Linux for remote/CI)

Apply fixes **in this order**: cheapest and highest-impact first. After each change,
re-measure and keep it only if it helps. Never quote a speed-up without timings from
*this* project.

---

## 0. Measure first

```bash
cargo build --timings                    # stable. Writes target/cargo-timings/cargo-timing.html
python3 <skill>/scripts/timings_parallelism.py target/cargo-timings/cargo-timing.html
```

The parallelism script reports **work** (sum of all unit times), **wall time**, average
parallelism, and an estimated **critical path**. `work / critical_path` is the maximum
number of cores this build can ever use. This one number drives most decisions,
including how big a remote VM to rent ([remote-vm-builds.md](remote-vm-builds.md)).

Other tools:

| Tool | Answers | Channel |
| :-- | :-- | :-- |
| `cargo build --timings` | Which crates sit on the critical path? Are cores idle? | stable |
| `cargo llvm-lines -p <crate>` | Which generic functions blow up codegen? | stable (cargo install) |
| `cargo bloat --crates` | What takes up space in the binary? | stable |
| `cargo tree -d` | Duplicate dependency versions | stable |
| `cargo +nightly rustc -p <c> -- -Zself-profile` + `summarize` | Where does rustc spend time inside one crate? | nightly |
| `cargo +nightly rustc -p <c> -- -Zmacro-stats` | Which macros expand to the most code? | nightly |

Measure the **three loops** separately: incremental `check`, incremental `test`, clean
`build`. They have different bottlenecks.

---

## 1. Fix the OS environment (free, often the biggest local win)

### macOS
- **XProtect scans every new executable** (build scripts, proc-macro dylibs, test
  binaries, doctests) on first run, through a single-threaded scanner. Fix:
  ```bash
  sudo spctl developer-mode enable-terminal
  ```
  Then go to System Settings → Privacy & Security → **Developer Tools** and enable your
  terminal, your IDE (VS Code/Zed/RustRover), and tmux/zellij if you use them. Restart
  those apps.
- Exclude `target/` from Spotlight (`touch target/.metadata_never_index` or System
  Settings → Spotlight → Privacy) and from Time Machine
  (`tmutil addexclusion -p target`).

### Windows (11)
- **Use a Dev Drive** (ReFS, marked *trusted*). Defender then runs in *performance mode*
  (asynchronous scanning), which avoids blocking on every file Cargo writes. Microsoft
  reports up to ~30% faster builds. Put the **repo, `CARGO_HOME`, and the target dir** on
  it:
  ```powershell
  setx CARGO_HOME D:\cargo
  setx RUSTUP_HOME D:\rustup
  ```
- On Windows 10 or without a Dev Drive: add Defender exclusions for the repo,
  `%USERPROFILE%\.cargo`, `%USERPROFILE%\.rustup`, and the target dir. This is less safe;
  prefer a Dev Drive.
- Prefer the **MSVC** toolchain (`x86_64-pc-windows-msvc`). It's the best-supported
  target, and its debuggers (VS, WinDbg) are what Windows users expect.
- Enable long paths (`git config --system core.longpaths true` + the OS policy). Deep
  `target/` paths can exceed MAX_PATH.

### All platforms
- **rust-analyzer gets its own target dir** so it stops taking Cargo's build lock and
  invalidating your artifacts:
  `"rust-analyzer.cargo.targetDir": true` (VS Code / Zed settings).
- `build.build-dir` (stable since Rust 1.91) moves intermediate artifacts, e.g. onto a
  Dev Drive or a fast local disk, while final artifacts stay in `target/`.
- Don't put `target/` in iCloud, OneDrive, or Dropbox folders.

---

## 2. Shape the crate graph for parallelism

This is the main source of multi-core usage. Cargo runs independent crates
concurrently, and pipelining (`rmeta`) lets dependents start type-checking before a
dependency finishes codegen. See [architecture.md §1](architecture.md). Checklist:

- [ ] Thin binary crate (wiring only). Logic lives in libs.
- [ ] Adapters are siblings, never chained.
- [ ] Depth ≤ 4. No single crate is > ~25% of total work in `--timings`.
- [ ] Heavy deps (cloud SDKs, codegen'd protobufs, GUI toolkits) are isolated in
      one crate each.
- [ ] No `common`/`utils` crate that everyone depends on and everyone edits.
- [ ] Feature unification is stable: building `-p x` doesn't rebuild deps that a
      `--workspace` build already built (fix: `cargo-hakari`).

A big crate on the critical path shows up as a long bar with idle cores beside it.
Split it, or (nightly lane) use `-Zthreads` so rustc parallelizes *inside* that crate.

---

## 3. Linker

| Host / target | Default | Faster option | Notes |
| :-- | :-- | :-- | :-- |
| macOS (`aarch64-apple-darwin`) | Apple ld-prime (Xcode 15+) | usually none needed | ld-prime is already fast and parallel. Don't use the abandoned `sold`/`zld`. |
| Windows MSVC (`x86_64-pc-windows-msvc`) | `link.exe` | **`rust-lld`** (ships with rustup) | `linker = "rust-lld.exe"` in `.cargo/config.toml`. Fall back to `link.exe` if a native lib misbehaves. Often a big win for large binaries. |
| Linux x86_64 (remote VMs, CI) | rust-lld (default since 1.90) | **mold** or **wild** | `linker = "clang"`, `rustflags = ["-C", "link-arg=-fuse-ld=mold"]` |
| Linux aarch64 | system `cc`/`ld` | lld / mold | Configure explicitly. |

Linking matters most for **incremental** builds: the leaf binary and every test binary
are re-linked after any change below them.

---

## 4. Debug info and profiles

Generating and linking debug info costs a lot in dev builds. Most of the time you only
need file:line in backtraces.

```toml
[profile.dev]
debug = "line-tables-only"      # file:line backtraces. Use `debug = true` only when stepping in a debugger.

[profile.dev.package."*"]       # all non-workspace deps
debug = false
# opt-level = 1                 # uncomment if dev binaries are too slow at runtime (paid once, deps are cached)

# [profile.dev.build-override]  # proc-macros + build scripts
# opt-level = 3                 # only if --timings shows proc-macro *execution* dominates. Measure.

[profile.debugging]             # for real debugger sessions: cargo build --profile debugging
inherits = "dev"
debug = true

[profile.ci]                    # one-shot CI builds
inherits = "dev"
incremental = false
debug = false

[profile.release]
lto = "thin"
# codegen-units = 16 (default). Leave as is so codegen stays parallel.

[profile.dist]                  # final shipped artifacts only
inherits = "release"
lto = "fat"
codegen-units = 1               # serial codegen: slow build, best runtime
strip = "symbols"
panic = "abort"                 # only if nothing relies on catch_unwind

[profile.profiling]
inherits = "release"
debug = "line-tables-only"
```

- Windows MSVC: debug info goes into `.pdb` files. `line-tables-only` still gives
  usable stack traces.
- macOS: dev already uses `split-debuginfo = "unpacked"` (no `dsymutil` run). Keep it.

---

## 5. Monomorphization (generic code bloat)

Generic functions are compiled **in the crate that uses them**, once per type
combination, so the cost lands in your leaf crates. Fixes:

1. **Thin generic shell, non-generic inner fn**:
   ```rust
   pub fn open<P: AsRef<Path>>(p: P) -> io::Result<Doc> {
       fn inner(p: &Path) -> io::Result<Doc> { /* body compiled once */ }
       inner(p.as_ref())
   }
   ```
2. `dyn Trait` at subsystem boundaries instead of `Service<R, C, M>`.
3. Avoid generic-heavy builder and type-state APIs in hot leaf crates.
4. Watch closures passed into generic functions inside big `async fn`s. Each closure is
   a separate instantiation.
5. Verify with `cargo llvm-lines`: the top entries should not be your generic services.

---

## 6. Proc-macros and build scripts

- Each **build script** is a separate binary that must compile *and run* before its
  crate continues (and on macOS, pass XProtect). Count them:
  `cargo metadata --format-version 1 | jq '[.packages[].targets[] | select(.kind[]=="custom-build")] | length'`
- Each **proc-macro** crate is compiled for the host, often with heavy `syn` deps, and
  it runs on every expansion.
- Tactics:
  - Isolate macro-heavy code (`sqlx::query!`, OpenAPI/GraphQL codegen,
    `tonic-build`) in dedicated crates that rarely change.
  - Check generated code into the repo (protobuf/OpenAPI) when regeneration is rare.
    This removes the build script entirely.
  - Drop unused derives. Prefer `default-features = false`.
  - Build scripts must print precise `cargo::rerun-if-changed=` lines, otherwise they
    rerun on every change.
  - Use `cargo +nightly ... -Zmacro-stats` to find expansion hot spots.

---

## 7. The nightly "fast lane": the three optimizations, fact-checked

A popular video claims three changes give "up to 46.9% faster clean builds and 46%
faster rebuilds". Assessment:

| Claim | Verdict | Details |
| :-- | :-- | :-- |
| **`debug = "line-tables-only"`** saves ~21% on rebuilds | ✅ Real, **stable** (Cargo ≥ 1.71) | Keeps file:line tables, drops variable/type info. Expect 10–30% depending on project, OS, and linker. Not nightly; make it a default (§4). Go further with `debug = false` for third-party deps. |
| **Parallel frontend `-Zthreads=8`** | ✅ Real, **nightly-only** | Parallelizes the *frontend* (type checking, borrow checking, and other analysis queries) inside one crate. 8 is the Rust team's recommended starting point. Its stabilization plan was accepted in July 2026 but it's **not stable yet**. Helps most when a **big crate is on the critical path** and cores sit idle; helps little when Cargo already saturates cores with many crates; can slightly slow tiny crates; **raises peak RAM**. |
| **Cranelift backend** speeds up codegen | ✅ Real, **nightly-only**, ⚠️ **limited on your platforms** | Installed with `rustup component add rustc-codegen-cranelift-preview --toolchain nightly`. Generates unoptimized code much faster than LLVM, for dev only. **On macOS and Windows, unwinding isn't supported**, so panics abort: `#[should_panic]` tests and `catch_unwind` break. Some SIMD/`std::arch` intrinsics and inline asm may be missing. Windows support is the least mature. Check `rustup component list --toolchain nightly \| grep cranelift` on each host. |
| Combined "46.9% faster clean / 46% faster rebuild" | ⚠️ **One project on one machine** | Plausible for that benchmark, not a guarantee. "46% faster" usually means 46% less time (≈1.85× speed-up). Your results depend on crate graph shape, debug info size, linker, and how much time is frontend vs codegen. Measure on your project. |
| What the video leaves out | — | Bigger or equal wins are free and stable: crate graph (§2), OS fixes (§1: XProtect, Dev Drive), linker (§3: `rust-lld` on Windows), test-binary consolidation (§8), rust-analyzer target dir. |

### Measured reference: Helix editor (327 units), Apple M4 10-core / 16 GB, Oct 2026

Stable 1.99.1 vs nightly 1.101 (2026-10-24), `-p helix-term`, each config in a fresh
target dir. "Rebuild" = append a comment to `helix-term/src/commands.rs`, average of 2.

| Config | Clean (s) | Rebuild (s) | Target size |
| :-- | --: | --: | --: |
| A: stable, `debug = true` (full) | 32.7 | 2.34 | 3.2 GB |
| B: stable, `line-tables-only` | 24.7 (**−24%**) | 1.84 (**−21%**) | 2.2 GB |
| C: nightly, `line-tables-only` | 25.8 | 1.59 | 1.7 GB |
| D: C + `-Zthreads=8` | 25.4 (−2% vs C) | 1.60 (±0) | 1.7 GB |
| E: C + Cranelift | 22.6 (−12% vs C) | 1.57 (−1%) | 1.5 GB |
| F: C + `-Zthreads=8` + Cranelift | 22.2 (**−32% vs A**) | 1.55 (**−34% vs A**) | 1.5 GB |

Takeaways:
- **The stable change (line-tables-only) gives most of the win** (−21–24%) and also
  cuts disk use by a third. Make it the default everywhere.
- **`-Zthreads=8` gave ~0 here.** That's expected: `timings_parallelism.py` showed max
  useful cores 9.7 on a 10-core machine and 85% mean CPU, so the cores were already
  busy with separate crates. It pays off on bigger machines or narrower graphs where
  cores sit idle.
- Cranelift helped clean builds (−12%) but barely helped rebuilds, which are dominated
  by the frontend + incremental reuse + linking of one leaf crate.
- All three combined: −32 to −34% against full debuginfo, and only −10 to −16% against
  the stable best (B). The video's "46%" depends heavily on the project and machine.
- Critical path was 14.9 s of 24.7 s wall (`helix-lsp-types → helix-lsp → helix-view →
  helix-tui → helix-term → hx`). On a 32-core VM this build can't go below ~15 s until
  that chain is shortened. That's the step-1 math in remote-vm-builds.md.

### How to run the fast lane without breaking stable

Never put `-Z` flags in the shared `.cargo/config.toml`: stable `rustc` rejects them.
Changing flags also invalidates the cache, so give the lane its **own target dir**:

```bash
# macOS / Linux: scripts/cargo-fast.sh wraps this
cargo +nightly \
  --config 'build.rustflags=["-Zthreads=8"]' \
  --config 'profile.dev.codegen-backend="cranelift"' \
  -Zcodegen-backend \
  build --target-dir target/fast
```

```powershell
# Windows: scripts/cargo-fast.ps1 wraps this
cargo +nightly --config 'build.rustflags=[\"-Zthreads=8\"]' `
  --config 'profile.dev.codegen-backend=\"cranelift\"' -Zcodegen-backend `
  build --target-dir target\fast
```

Rules:
- Use the fast lane for `build`/`run`/`check`. On macOS/Windows, run **tests on the
  normal LLVM lane** (because of the unwinding limitation), or drop Cranelift for tests.
- If a crate fails under Cranelift (SIMD, asm), try a per-package override back to LLVM
  (`[profile.dev.package.<name>] codegen-backend = "llvm"`), if your nightly accepts it.
- Pin the nightly date (`nightly-2026-10-20`) in the wrapper so a bad nightly doesn't
  block the team.

### Choosing the `-Zthreads` value (why 8 is a default, not a cap)

`-Zthreads=N` accepts any N. More is not automatically better:

1. **Amdahl's law inside one crate.** Parsing, macro expansion, and name resolution are
   still largely serial. Only the per-item analysis (type check, borrow check, …) runs
   in parallel. With parallel fraction p, the frontend speed-up is $1/((1-p) + p/n)$.
   With p = 0.6: 8 threads → 2.1×, 16 → 2.3×, 64 → 2.5×.
2. **Contention.** Threads share the query caches and interners. Past roughly 8–16
   threads, locking and cache traffic eat the gain, and builds can get *slower*.
3. **Memory.** Peak RAM per rustc grows with threads, and Cargo runs many rustc
   processes at once. An OOM kill on a VM costs more than any speed-up.
4. **Cores may already be busy.** `-Zthreads` is *per rustc process*. On a wide crate
   graph, Cargo already fills every core with separate crates. Intra-crate threads only
   help when cores sit **idle** while a big crate is on the critical path (the long bars
   in `--timings`, typically the final large crates and the binary).

Procedure:
- If `timings_parallelism.py` shows high utilization, keep 8 (or skip the flag).
- If big critical-path crates leave cores idle (common on large VMs), run
  [zthreads_sweep.sh](../scripts/zthreads_sweep.sh). It does clean builds for
  N ∈ {4, 8, 12, 16, 24, 32} (capped at the core count), records wall time and peak
  RSS, deletes each target dir afterwards, and suggests the point where gains drop
  below 5%.
- Keep peak RAM under ~70% of the machine's total. On big VMs the best value usually
  lands at 8–16.
- Record the chosen value per machine class in `PLATFORMS.md` (Build machines section).
- Remember: **splitting crates scales almost linearly with cores. Threads inside one
  crate don't.** Fix the crate graph first.

---

## 8. Test builds

- **One integration-test binary per crate**: `tests/it/main.rs` + `mod a; mod b;`.
  N files means N binaries and N link steps. This is one of the biggest incremental
  `cargo test` wins.
- Edition 2024 merges doctests into one binary per crate. Set `doctest = false` on
  internal crates without examples.
- `cargo nextest run`: process-per-test, parallel across cores, CI partitioning
  (`--partition count:2/8`), retries, JUnit output. Nextest doesn't run doctests, so run
  `cargo test --doc` separately in CI.
- Use `cargo nextest archive` to build test binaries once, then run them on many
  machines (see remote-vm-builds.md).
- Iterate on one crate: `cargo nextest run -p <crate>`. Don't rebuild the world.

---

## 9. Caching

| Cache | Where it helps | Caveats |
| :-- | :-- | :-- |
| Incremental (`target/`) | Local dev loop | Big on disk. Clean old dirs with `cargo-sweep`. Off in CI. |
| `Swatinem/rust-cache` (GitHub Actions) | CI deps | Caches the registry + dependency artifacts per OS/toolchain/lockfile. |
| `sccache` (local disk, S3/GCS/Azure, GitHub Actions cache) | CI, many worktrees, ephemeral VMs | **Can't cache incremental crates or bin/proc-macro/dylib crates.** Gives little benefit for a single dev's local loop. |
| `cargo-chef` | Docker builds | Puts deps in their own image layer. |
| `build.build-dir` (1.91) | Moving or sharing intermediates | Groundwork for cross-workspace caching. Don't rely on its internal layout. |

---

## 10. Hot-patching (fastest edit loop)

**Dioxus Subsecond** (`dx serve --hotpatch`, Dioxus 0.7+) patches changed functions into
the running process in roughly 100–500 ms while keeping state. It works for non-Dioxus
apps too (axum servers, Bevy, ratatui, desktop GUIs) via `dioxus-devtools`. It works best
for code in the *tip* (leaf) crate, so keep the code you iterate on there. Struct layout
changes require a restart.

---

## 11. Release builds on many cores

- `codegen-units = 16` + `lto = "thin"` keeps release codegen parallel (good on big VMs).
- `lto = "fat"` + `codegen-units = 1` is **serial**. It belongs only in `dist`, and only
  if benchmarks show a runtime win.
- Build each target triple as its own job, concurrently, on separate machines or target
  dirs (see remote-vm-builds.md).
- PGO/BOLT (`cargo-pgo`) for the final few % of runtime. Do it in CI, never locally.
