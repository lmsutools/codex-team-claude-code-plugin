# Platforms: Intake, Support Tiers, and Per-OS Guide (Windows · macOS · Linux)

## 1. Platform intake (MANDATORY before planning, scaffolding, CI, or release work)

If the project has no `PLATFORMS.md`, **ask the owner** (use the `ask_question` tool if
available) before doing anything platform-dependent:

1. **Ship now**: which OSes must this release run on? Windows / macOS / Linux (multi-select)
2. **Likely later**: which might clients need within ~12 months? (multi-select; default: all not chosen above)
3. **App kind**: desktop GUI / CLI tool / server or background service / library
4. **CPU architectures**: x64 / arm64 / both

Then write `PLATFORMS.md` from [resources/templates/PLATFORMS.md](../resources/templates/PLATFORMS.md)
and pass the choices to `scaffold_workspace.sh` (`--ship`, `--ready`, `--kind`, `--arch`).

If `PLATFORMS.md` exists, **read it instead of asking**. Re-ask only when the user signals
a change ("clients on Mac now", "need a Linux server build"), then run the expansion
playbook (§4).

## 2. Support tiers

| Tier | Meaning | What runs | Cost |
| :-- | :-- | :-- | :-- |
| **Ship** | Released to users | Build + test on that OS, package, sign, release | Full CI runner per OS |
| **Ready** (default for every "likely later" OS) | Not released, but kept compiling | `cargo check` + `cargo clippy --target <triple>` on the cheap Linux runner on every PR | Seconds |
| **Out** | Explicitly not supported | Nothing | Only if the owner says so |

**Why Ready matters:** "Windows only, I'm in a hurry" is fine, as long as nobody adds
Windows-only code to the core along the way. The Ready check catches that the day it
happens, while the fix is still one line. Three months later, adding macOS/Linux is
then a playbook, not a rewrite.

## 3. Portability rules (always on, even with a single Ship target)

- **One `platform` crate** holds all OS-specific code behind traits defined in `app`.
  No `#[cfg(target_os)]` in `domain`/`app`.
- **OS-only deps are target-scoped:**
  ```toml
  [target.'cfg(windows)'.dependencies]
  windows-sys = { workspace = true }
  [target.'cfg(target_os = "macos")'.dependencies]
  objc2-foundation = { workspace = true }
  ```
- **Prefer cross-platform choices at decision points**: GUI framework (Tauri, Slint,
  egui, Iced, Dioxus over Win32/WinUI-only or AppKit-only), storage paths (`directories`),
  service management behind a trait (Windows Service / launchd / systemd), keychain via
  `keyring`, notifications/tray via cross-platform crates.
- **Filesystem/process hygiene:** `Path::join` (never string concat), `OsStr`/`PathBuf`
  end to end, `dunce::canonicalize`, `EXE_SUFFIX`, no shell assumptions in `Command`,
  assume case-insensitive filesystems, close files before rename/delete (Windows).
- `.gitattributes`: `* text=auto eol=lf`; snapshot tests normalize newlines.
- `rust-toolchain.toml` `targets = [...]` lists every Ship **and** Ready triple, so
  `rustup` installs them automatically.

## 4. Expansion playbook ("my clients are on Mac/Linux now")

1. Update `PLATFORMS.md`: move the OS from Ready → Ship. Record the date and reason.
2. CI: add a native runner for the OS (build + nextest), plus packaging/signing jobs.
3. `platform` crate: implement the traits for the new OS (the Ready check guarantees it
   already compiles, so this step fills in behavior, not structure).
4. Packaging and signing (see §5 for each OS).
5. Smoke-test on real hardware: install, first run, update, uninstall.
6. Add the OS to the release checklist and to support docs.

## 5. Per-OS guide

### Windows
| Item | Choice |
| :-- | :-- |
| Targets | `x86_64-pc-windows-msvc` (primary), `aarch64-pc-windows-msvc` (Snapdragon PCs) |
| Toolchain | **MSVC**, not GNU (native debuggers, best crate support) |
| Dev machine speed | Dev Drive (ReFS, trusted → Defender performance mode); `linker = "rust-lld.exe"` |
| OS APIs | `windows-sys` (plain FFI, lighter) or `windows` (rich wrappers). Enable only needed features. |
| Packaging | MSI (`cargo-wix`), MSIX, or the Tauri / `dist` installers |
| Signing | Authenticode (Azure Trusted Signing, or an OV/EV certificate via `signtool`). Unsigned apps hit SmartScreen warnings. |
| Services | `windows-service` crate |
| Build from Mac/Linux | `cargo check --target x86_64-pc-windows-msvc` (no linker needed); full binaries via `cargo xwin build`. Test on real Windows. |

### macOS
| Item | Choice |
| :-- | :-- |
| Targets | `aarch64-apple-darwin` (primary), `x86_64-apple-darwin` (Intel; ship a universal binary via `lipo`) |
| Build where | Apple hardware only (local Mac, CI macOS runner, rented Mac). Cross-compiling from Linux isn't worth it. |
| Dev machine speed | XProtect: `sudo spctl developer-mode enable-terminal` + Developer Tools toggle. Exclude `target/` from Spotlight/Time Machine. |
| OS APIs | `objc2` family (`objc2-foundation`, `objc2-app-kit`, …) |
| Packaging | `.app` bundle + `.dmg` (Tauri bundler, `cargo-packager`, `dist`) |
| Signing | Developer ID + hardened runtime → `xcrun notarytool submit --wait` → `xcrun stapler staple` |
| Services | launchd plist (LaunchAgent / LaunchDaemon) |

### Linux
| Item | Choice |
| :-- | :-- |
| Targets | `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`. Optional `*-linux-musl` for a single static binary (CLI/server). |
| Baseline | Current distros only. Build on the CI runner's current image (e.g. `ubuntu-latest`). No old-glibc compatibility work. |
| Linker | rust-lld (default on x86_64 since 1.90). mold or wild for even faster links. |
| GUI | Wayland first, X11 fallback (handled by winit/Tauri/Slint/egui). Tauri needs `webkit2gtk` dev packages in CI. |
| Packaging | `.deb` (`cargo-deb`), `.rpm` (`cargo-generate-rpm`), AppImage or Flatpak for desktop apps, OCI image for servers |
| Services | systemd unit file (`Type=notify` via `sd-notify` if useful) |
| Signing | Package-repo signing (GPG) if you host repos. Otherwise checksums + signatures on releases (e.g. `minisign`/`cosign`). |

## 6. CI shape derived from tiers

- **Always** (`ubuntu-latest`): fmt, clippy, cargo-deny, and **`cargo check` + `clippy`
  for every Ship and Ready target triple** (Linux, and Windows/macOS triples without
  linking).
- **Per Ship OS**: native runner with build + `cargo nextest run`; release jobs on tags
  (package, sign, notarize).
- `scaffold_workspace.sh` writes `.github/workflows/ci.yml` with exactly this matrix
  from `--ship` / `--ready`.

## 7. Cross-platform GUI options (desktop apps)

| Framework | UI model | Build-time footprint | Notes |
| :-- | :-- | :-- | :-- |
| Tauri 2 | Web frontend + Rust backend | Medium-large | Mature bundler, signing, updater. System WebView (WebView2 / WKWebView / WebKitGTK). |
| Slint | Declarative DSL, native rendering | Medium | Good tooling, live preview |
| egui / eframe | Immediate mode | Small-medium | Fastest to iterate. Ideal for tools. |
| Iced | Elm architecture | Medium | Pure Rust |
| Dioxus desktop | React-like (RSX) | Medium | Pairs with Subsecond hot-patching (`dx serve --hotpatch`) |
| gpui | GPU, Zed's framework | Large | High performance. API still moving. |

---

## 8. Building for Windows, macOS & Linux from a Single Mac

An Apple Silicon Mac can type-check, lint, and cross-compile for all three OSes locally
without waiting on CI:

1. **Instant Cross-Target Type & Lint Check (Zero Linker / Zero SDK Needed):**
   `cargo check` and `cargo clippy` do **not** invoke a linker. With target triples in
   `rust-toolchain.toml`, run these directly on macOS in 1–2 seconds:
   ```bash
   cargo clippy --workspace --all-targets --target x86_64-pc-windows-msvc -- -D warnings
   cargo clippy --workspace --all-targets --target x86_64-unknown-linux-gnu -- -D warnings
   ```
2. **Pure-Rust Dependency Rule (Eliminates 95% of C Cross-Toolchain Failures):**
   - Always select **`rustls`** instead of `native-tls` / `openssl-sys` (in `reqwest`,
     `sqlx`, `tokio-tungstenite`, `tonic`).
   - If using SQLite (`rusqlite`) or compression (`zstd`), enable `bundled` only when pure
     Rust alternatives aren't used, and keep C `-sys` crates isolated in one adapter crate.
3. **Cross-Compiling Real Windows (`.exe`) and Linux (ELF) Binaries on macOS:**
   - **Mac → Windows (`.exe`):**
     ```bash
     brew install llvm && cargo install cargo-xwin
     cargo xwin build --release --target x86_64-pc-windows-msvc
     ```
     `cargo-xwin` caches the official Microsoft CRT/SDK headers locally and links `.exe`
     binaries using `lld-link`.
   - **Mac → Linux (ELF):**
     ```bash
     brew install zig && cargo install cargo-zigbuild
     cargo zigbuild --release --target x86_64-unknown-linux-gnu
     cargo zigbuild --release --target aarch64-unknown-linux-gnu
     ```
     `cargo-zigbuild` uses Zig as a zero-config cross C compiler and linker.
4. **Running Foreign Tests Locally on Apple Silicon (When Needed Before CI):**
   - **Linux:** Use **OrbStack** (or Docker Desktop) — `linux/arm64` containers run at
     near-native M-series CPU speed.
   - **Windows:** Use **UTM** (free) or **Parallels** with Windows 11 ARM64, which runs
     both `aarch64-pc-windows-msvc` and `x86_64-pc-windows-msvc` binaries built by
     `cargo xwin`.

---

## 9. Using Linux (Workstation or Rented VM) to Build for Windows & macOS

A high-core Linux machine (or rented NVMe VM) is the fastest host for heavy Rust builds.
Use this stack to target **Windows** and **macOS** directly from Linux:

### 1. Instant Cross-OS Type & Lint Check on Linux (Zero SDK Needed)
With the target triples in `rust-toolchain.toml`, Linux type-checks and lints both Windows
(`#[cfg(windows)]`, `windows-sys`) and macOS (`#[cfg(target_os = "macos")]`, `objc2`) in
1–2 seconds without any linker:
```bash
cargo clippy --workspace --all-targets --target x86_64-pc-windows-msvc -- -D warnings
cargo clippy --workspace --all-targets --target aarch64-apple-darwin -- -D warnings
```

### 2. Linux → Windows: Build `.exe` with `cargo-xwin` + Run Tests Under `wine64`
Linux can both compile **and execute** Windows MSVC test binaries without booting a
Windows VM:
1. **Install `cargo-xwin` + `lld` + `wine64`:**
   ```bash
   sudo apt-get install -y clang lld wine64
   cargo install cargo-xwin
   ```
2. **Build real Windows `.exe` binaries (`x86_64` or `aarch64`):**
   ```bash
   cargo xwin build --release --target x86_64-pc-windows-msvc
   ```
3. **Run Windows unit & integration tests directly on Linux via `wine64`:**
   ```bash
   CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUNNER="wine64" \
     cargo xwin nextest run --target x86_64-pc-windows-msvc
   ```
   Running under `wine64` catches real Windows bugs (backslash path handling, `os error 32`
   exclusive file locks on open files, and Win32 API calls) in seconds on Linux.

### 3. Linux → macOS: Cross-Compile with `cargo-zigbuild` & Sign with `rcodesign`
- **Pure-Rust CLI / server / daemon crates:** Cross-compile `aarch64-apple-darwin` and
  `x86_64-apple-darwin` directly on Linux with Zig:
  ```bash
  cargo install cargo-zigbuild
  cargo zigbuild --release --target aarch64-apple-darwin
  cargo zigbuild --release --target x86_64-apple-darwin
  ```
  *(If a dependency links macOS system frameworks like `Security` or `CoreFoundation`,
  point `SDKROOT=/path/to/MacOSX.sdk` at an extracted Xcode macOS SDK tarball.)*
- **Sign & Notarize macOS binaries from Linux (`apple-codesign`):**
  Use pure-Rust `rcodesign` (`cargo install apple-codesign`) to sign Mach-O binaries/DMGs
  and submit them to Apple's Notary API directly from Linux without Xcode.
- **When to hand off to real Apple hardware (your Mac or `macos-latest` CI):**
  Native macOS runtime tests (`crates/platform` launchd/Keychain/AppKit/WebKit tests) and
  heavy Swift/Objective-C bridge builds must run on macOS hardware.

### 4. Linux Filesystem Tip for Instant Worktree `target/` Clones (`XFS` or `Btrfs`)
`codex-team`'s `warmTarget` uses `FICLONE` copy-on-write reflinks to clone `target/` into
each parallel worktree in milliseconds.
- Default `ext4` **does not** support reflinks (`FICLONE` returns `EOPNOTSUPP`).
- On a Linux workstation or rented VM, place your workspace on **XFS** (`mkfs.xfs -m reflink=1`,
  default on modern XFS) or **Btrfs** so parallel `codex_batch` worktrees get instant,
  zero-disk-cost `target/` clones just like APFS on macOS.

Keep the GUI framework in the bin crate (or one `ui` crate) only, so UI dependency
churn doesn't rebuild the rest of the workspace.
