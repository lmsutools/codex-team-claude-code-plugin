# Fast TDD Loop in Large Rust Workspaces

A TDD cycle in Rust costs **compile + link + run** for every red→green→refactor step.
In big workspaces the compile and link part dominates, often 5–30 s of mostly *waiting*.
The target: **≤ 1 s to see a compile error, ≤ 3–5 s to see a test result** for the
crate you're working on, no matter how big the workspace is.

## Where the time goes (per cycle)

```mermaid
flowchart LR
    A["save file"] --> B["cargo freshness scan"]
    B --> C["recompile edited crate (frontend + codegen)"]
    C --> D["recompile DEPENDENT crates' test targets (if selected)"]
    D --> E["link each test binary"]
    E --> F["OS scans new executables (XProtect / Defender)"]
    F --> G["run tests (process start, setup, I/O, sleeps)"]
```

Each box has its own fix, listed below in order of impact.

## Measured on an Apple M4 (stable 1.99.1, Oct 2026)

**A. 20 integration-test files (20 binaries) vs one `tests/it/` binary** (small crate
with `regex` + `serde_json`, `line-tables-only`):

| Layout | First test build | Rebuild after editing `lib.rs` | Run the tests after rebuild |
| :-- | --: | --: | --: |
| 20 files → 20 binaries | 2.82 s | 0.68 s | **5.82 s** |
| `tests/it/main.rs` → 1 binary | 2.03 s | **0.20 s** (3.4× faster) | **0.59 s** (~10× faster) |

The run step is the surprise. Every rebuilt binary is a *new executable* that macOS
scans before it starts, plus process startup ×20. Consolidating removes most of it, and
the Developer Tools exemption (§6) removes the rest.

**B. Helix (327 units): edit `helix-core`, then:**

| Command | Time |
| :-- | --: |
| `cargo check -p helix-core --tests` (red phase via type checker) | **0.30 s** |
| `cargo test -p helix-core --no-run` (build that crate's tests) | 0.70 s |
| `cargo test --workspace --no-run` (warm; rebuilds + relinks every dependent's tests) | 4.70 s (6.7× slower) |
| `cargo test --workspace --no-run` (first time after the edit) | 33.8 s |

Takeaway: **scope + check-first + one test binary per crate** turns a 5–30 s cycle into a
sub-second to ~1 s cycle without any nightly features.

---

## 1. Scope the loop: test only what you're changing (biggest win, free)

- Run **one crate**, and **one test filter** while red:
  `cargo nextest run -p <crate> <test_name_substring>`.
- `cargo test --workspace` after editing a low-level crate rebuilds and relinks **every
  dependent crate's tests**. Keep it for pre-push / CI, not for every save.
- Keep the scope stable. Switching between `-p a` and `--workspace` can change feature
  unification and rebuild dependencies (fix: `cargo-hakari`, see architecture.md §1).

## 2. Red phase = the type checker (sub-second), not a test run

In Rust, much of "red" is a **compile error**: a missing function, wrong signature,
unhandled variant. You don't need codegen or linking to see it:

- Let rust-analyzer show errors as you type (with its own target dir:
  `"rust-analyzer.cargo.targetDir": true`).
- Or run `cargo check -p <crate> --tests`: no codegen, no linking, no test run.
- Only run the tests once it compiles.

## 3. Automate the loop with a watcher: `bacon`

`bacon` (actively maintained; `cargo-watch` is no longer maintained) reruns a job on
save, shows only the first relevant error, and switches jobs with one key:

```bash
cargo binstall bacon
bacon                         # default job from bacon.toml: check --tests
bacon nextest -- -p my-crate  # run one crate's tests on every save
```

Template: [resources/templates/bacon.toml](../resources/templates/bacon.toml)
(`c` = check tests, `t` = nextest for the current crate, `w` = workspace tests).

## 4. Make tests *cheap to build*: structure

- **Pure logic in sans-IO crates** (`domain`, `app`) with almost no dependencies. Their
  unit tests compile and link fast, so TDD in them is near-instant.
- **Unit tests in the same file** (`#[cfg(test)] mod tests`). They compile into the lib's
  single test binary.
- **One integration-test binary per crate** (`tests/it/main.rs` + `mod x;`). Every file
  in `tests/` is a separate binary with its own link step, and on macOS its own XProtect
  scan.
- `doctest = false` on internal crates without doc examples.
- **Ports + fakes**: test use-cases against in-memory fakes (`Arc<dyn Repo>` with a
  `FakeRepo` from `test-support`), not real databases or networks.
- **Avoid `test-support` → big-crate chains.** The fake crate should depend on `app`
  only, never on adapters.

## 5. Make tests *cheap to run*

| Problem | Fix |
| :-- | :-- |
| Tests run sequentially | `cargo nextest run`: process per test, parallel across all cores |
| `sleep`/timeouts in async tests | `#[tokio::test(start_paused = true)]` + `tokio::time::advance`: virtual time, zero waiting |
| Real DB per test | Fakes for unit/use-case tests. For DB adapter tests: one container per run (testcontainers), a template DB cloned per test, or a transaction rolled back per test |
| Slow property tests locally | `PROPTEST_CASES=32` locally, default/higher in CI |
| Hand-writing expected outputs | `insta` snapshots: write the test, `cargo insta review` to accept |
| Slow tests in every run | nextest filtersets: `-E 'not test(/slow_/)'` locally; slow group in CI |
| Expensive shared setup | `std::sync::LazyLock` fixtures inside the test binary (works for libtest; nextest runs a process per test, so prefer cheap setup or nextest *setup scripts*) |
| CPU-heavy deps very slow in debug (regex, crypto, image, serde on big data) | `[profile.dev.package.<dep>] opt-level = 2` (paid once, deps are cached) |

## 6. Make compile + link of the test binary faster

- `debug = "line-tables-only"` (measured −21% rebuild on Helix, see build-performance.md §7).
- **macOS:** add terminal + IDE to **Developer Tools**. Every rebuilt test binary is a
  *new executable*, which XProtect otherwise scans before it can run, on every cycle.
- **Windows:** Dev Drive (Defender performance mode) + `rust-lld.exe` linker. Test
  binaries get rewritten every cycle.
- Thin generic APIs (non-generic inner fn) so tests don't re-monomorphize big generic
  code.
- Nightly fast lane: Cranelift speeds up codegen of the test binary. On macOS/Windows
  there is no unwinding (panics abort). With **nextest** that only kills the one test's
  process, so failures are still reported per test, but `#[should_panic]` tests break.
  Prefer returning `Result` and asserting on `Err`. Verify on your project before
  adopting.

## 7. The recommended loop

```text
1. Write the test (rust-analyzer shows compile errors instantly)       ~0 s
2. bacon "check --tests" job: red by compile error                    < 1 s
3. Implement until it compiles                                        < 1 s per save
4. bacon nextest -p <crate> <filter>: red → green                     2-5 s
5. Refactor with the same job running
6. Before pushing: cargo nextest run --workspace (or let CI do it)
```

## 8. Measure the loop

```bash
touch crates/<crate>/src/lib.rs
time cargo check -p <crate> --tests
time cargo nextest run -p <crate> --no-run   # build only
time cargo nextest run -p <crate>
```

If the build-only step is > 5 s for a mid-level crate, run `build_audit.sh` and look at
integration-test binary counts, dependency weight of the crate, and debuginfo.
