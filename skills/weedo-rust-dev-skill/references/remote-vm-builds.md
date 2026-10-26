# Using Rented Remote VMs to the Max

A 64-core VM doesn't make a build 6× faster than a 10-core laptop unless the **crate
graph can use 64 cores**. Before renting anything, work through these steps in order.

---

## Step 1: Measure the build's useful parallelism (always first)

On the current machine:

```bash
cargo clean && cargo build --timings          # or --release, matching what you'll offload
python3 <skill>/scripts/timings_parallelism.py target/cargo-timings/cargo-timing.html
```

Read three numbers:

| Number | Meaning | Decision |
| :-- | :-- | :-- |
| `work` (sum of unit time) | Total CPU-seconds the build needs | Sets how long a clean build takes when cores are plentiful |
| `critical path` | Wall-time lower bound with infinite cores | No VM can beat this |
| `max useful cores = work / critical path` | Cores beyond this sit idle | **Upper limit for VM size** |

Predicted wall time on a machine with `N` cores, relative per-core speed `s`
(1.0 = current machine), ignoring I/O:

$$
T(N) \approx \frac{\max\left(\dfrac{work}{N},\ critical\_path\right)}{s}
$$

Example: work = 900 s, critical path = 60 s gives max useful cores ≈ 15. A 10-core M4
(s = 1.0) takes ~90 s. A 32-core VM with s = 0.7 takes max(28, 60) / 0.7 ≈ 86 s, which
is **no faster**. Fix the critical path first (step 2). After that, the same VM wins
easily.

> [!IMPORTANT]
> Per-core speed matters. An Apple M4 core is among the fastest available. Many cloud
> vCPUs are hyperthreads at lower clocks (s ≈ 0.5–0.8 against an M4). The incremental
> dev loop is mostly serial (one crate + link), so it's usually **faster on the local
> M4**. Remote VMs win on clean builds, full test suites, multi-target release builds,
> and CI.

---

## Step 2: Make the build able to use the cores

If `max useful cores` < the VM's cores:

1. **Shorten the critical path**: split the crates on it (architecture.md §1), move
   heavy codegen/proc-macro crates off the chain, thin the binary crate.
2. **Parallelize inside big crates** (nightly lane): `-Zthreads`. This helps exactly
   when a big crate on the critical path leaves cores idle. Don't guess the value: run
   [zthreads_sweep.sh](../scripts/zthreads_sweep.sh) on the VM and record the result in
   `PLATFORMS.md` → Build machines (reasoning in build-performance.md §7).
3. **Keep release codegen parallel**: `codegen-units = 16`, `lto = "thin"`. Fat LTO +
   `codegen-units = 1` makes the final step single-threaded.
4. **Use spare cores for independent jobs** at the same time, each with its own target
   dir: e.g. `cargo build --release --target x86_64-pc-windows-msvc`,
   `cargo nextest run`, and `cargo clippy` in parallel.

Re-run step 1 after changes. Rent big only once `max useful cores` justifies it.

---

## Step 3: Pick what to offload

| Workload | Best place | Why |
| :-- | :-- | :-- |
| Edit → check → test one crate | **Local M4** (or a remote dev box if the laptop is weak) | Mostly serial and latency-sensitive. Fast single core wins. |
| Clean builds / dependency upgrades / `cargo update` fallout | Remote VM | Wide work, uses many cores |
| Full test suite | Remote VM(s), nextest partitioned | Tests run in parallel across processes and machines |
| Release builds for Windows + macOS | CI or VMs per target, in parallel | Independent targets |
| Windows-native testing | Windows VM (Dev Drive) | You can't fully test MSVC binaries off Windows |
| macOS builds, signing, notarization | **Apple hardware** (local M4, CI macOS runner, rented Mac) | Apple SDK licensing. Cross-compiling to macOS from Linux is fragile. |

---

## Step 4: Size and configure the VM

**CPU**: choose high per-core performance over the raw vCPU count. Prefer current-gen
AMD EPYC / Intel Xeon compute-optimized or Arm (Graviton/Ampere/Axion) instances. Size
cores ≤ `max useful cores` × 1.2.

**RAM**: ≥ 2 GB per core. Use ≥ 3–4 GB per core with `-Zthreads`, LTO, or very large
crates. An OOM kill wastes the whole build. If RAM is short, cap with
`build.jobs = N` in `.cargo/config.toml` rather than starving every job.

**Disk**: local NVMe, not network block storage, for `target/` and `CARGO_HOME`. On
Linux, `tmpfs` for `target/` works if RAM allows. On Windows VMs, use a **Dev Drive**.

**OS per target** (driven by the Ship/Ready tiers in `PLATFORMS.md`):
- Linux VM: fastest builder and linker (mold/wild). It runs the cheap **Ready** checks
  for every OS (`cargo clippy --target …`), builds Linux Ship artifacts, and can
  **cross-build Windows MSVC** binaries with `cargo-xwin`. Run Windows tests on a
  Windows VM or runner.
- Windows VM: native MSVC build + test; `linker = "rust-lld.exe"`; Dev Drive.
- macOS: rented Mac minis or CI macOS runners for builds, signing, notarization.

**Toolchain**: the same pinned `rust-toolchain.toml` as local. Install `cargo-nextest`,
`sccache`, mold/wild (Linux), and `cargo-binstall` for fast tool installs.

**Ephemeral VMs** (spot/preemptible, auto-shutdown): a cold VM rebuilds everything.
Warm it with:
- `sccache` backed by S3/GCS/Azure Blob (`RUSTC_WRAPPER=sccache`, `CARGO_INCREMENTAL=0`),
  which caches dependency compilations across VMs;
- or a persistent disk / snapshot holding `CARGO_HOME` + `target/`.

---

## Step 5: Choose a workflow

### A. Remote dev box (simplest, best for weak laptops)
VS Code Remote-SSH / Zed remote / JetBrains Gateway. The source, rust-analyzer, and
cargo all run on the VM, so incremental builds stay incremental. Keep the VM in a nearby
region for low latency.

### B. Local editing, remote building (keeps the M4 for the inner loop)
- Sync with `mutagen` (or `rsync -a --delete --exclude target/`).
- Run builds over SSH:
  `ssh vm 'cd proj && cargo build --release --target x86_64-pc-windows-msvc'`
  (wrapped by [remote_build.sh](../scripts/remote_build.sh)).
- Copy back only the artifacts you need.

### C. Build once, test on many machines (CI fan-out)
```bash
cargo nextest archive --workspace --archive-file tests.tar.zst     # on the big builder
# copy tests.tar.zst to K runners, then on runner i:
cargo nextest run --archive-file tests.tar.zst --partition count:i/K
```

### D. Distributed compilation (only for very large orgs)
- `sccache-dist`: farms rustc jobs to Linux servers. Setup is complex (scheduler,
  TLS, toolchain packaging), it's network-heavy, and results are mixed when the
  workstation is already fast.
- Bazel / Buck2 with remote execution: real distributed builds and caching for huge
  monorepos, at the cost of leaving Cargo-native workflows. Consider it past roughly 1M
  LOC or 100+ engineers.

---

## Step 6: Verify you're getting your money's worth

On the VM, after a clean build:

- `timings_parallelism.py` → average core utilization should be **> 60%** for clean
  builds. If not, go back to step 2.
- Watch `htop` / `btop` during the build. Long single-core phases mean critical-path
  crates or linking.
- Compare cost per build (VM price per hour × wall time) against developer time saved.
  Shut down idle VMs automatically.

## Decision checklist (copy into the project plan)

- [ ] `max useful cores` measured: ____
- [ ] Critical-path crates identified and split (target: utilization > 60% on the VM)
- [ ] VM: ____ vCPU, ____ GB RAM (≥ 2 GB/core), local NVMe / Dev Drive
- [ ] Targets per machine: Linux VM (lint, test, Windows cross-build) · Windows VM/runner (native test) · Mac (build, sign, notarize)
- [ ] Cache: sccache + object storage, or a persistent disk
- [ ] Workflow: A / B / C / D
- [ ] Auto-shutdown + spot/preemptible
