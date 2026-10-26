# Telemetry, Crash Reporting & Sentry Closed-Loop Triage

Large Rust applications across Windows, macOS, and Linux need production crash/error visibility **without** slowing down local compile times or leaking user secrets.

---

## 1. Architectural Rule: Keep `sentry` Out of Domain Crates

The `sentry` crate pulls in HTTP/TLS/serialization dependencies. If Layer 2 domain crates depend on `sentry` directly, every crate in your workspace waits on network/TLS compilation and couples business logic to a vendor SDK.

**Enforce this strict boundary:**
- **Layer 1 (`types`, `error`):** Zero telemetry dependencies (or `tracing` only if span context is part of a trait).
- **Layer 2 (Domain crates: `billing`, `search`, `sync`, etc.):** Depend **only** on `tracing = { workspace = true }` (tiny, <0.5s compile). Emit structured spans (`#[tracing::instrument(skip_all, fields(id = %id))]`) and events (`tracing::info!`, `tracing::warn!`, `tracing::error!`).
- **Layer 2 Adapter (`crates/telemetry`):** The **only** crate in the workspace that compiles `tracing-subscriber`, `sentry`, and `sentry-tracing` (behind a Cargo feature `sentry`).
- **Layer 3 (`bins/*`):** Calls `let _guard = telemetry::init(telemetry::Config::from_env("app-name", env!("CARGO_PKG_VERSION")))?;` on startup.

```text
Layer 2 Domain Crates ──(tracing only)──► Layer 3 Binary ──► crates/telemetry (sentry + tracing-subscriber)
```

---

## 2. How `tracing` Maps to Sentry Automatically

With `sentry-tracing` wired into `tracing_subscriber::registry()`:
1. **`tracing::info!` / `tracing::debug!` / `tracing::warn!`** → Recorded automatically as **Sentry Breadcrumbs** (the trail of events leading up to an error).
2. **`tracing::error!`** → Captures a **Sentry Error Event** with the active `#[tracing::instrument]` span stack and structured fields attached.
3. **`panic!` / `unwrap()`** → `sentry::integrations::panic::PanicIntegration` captures the panic message and backtrace before unwinding or aborting.

See [`resources/templates/telemetry.rs`](../resources/templates/telemetry.rs) for a drop-in implementation featuring:
- **Zero-cost no-op when `SENTRY_DSN` is unset:** Local dev, tests, and offline agent sandboxes make zero network calls.
- **PII & Local Path Scrubbing (`before_send`):** Automatically scrubs home directory paths (`/Users/<name>`, `/home/<name>`, `C:\Users\<name>`) and bearer/API tokens before any event leaves the machine.
- **Platform Matrix Tagging:** Attaches `os`, `arch`, and `target_triple` tags matching [`PLATFORMS.md`](../resources/templates/PLATFORMS.md).

---

## 3. Fast Builds + Full Stacktraces (`split-debuginfo` & Symbol Upload)

Never ship unstripped release binaries to users just to get stacktraces, and never pay link-time penalties during local TDD:

1. **Local Dev / TDD (`.cargo/config.toml`):**
   - Uses `split-debuginfo = "unpacked"` on macOS (skips `dsymutil`), DWARF splitting on Linux, and `.pdb` on Windows.
2. **Release Profile (`Cargo.toml`):**
   ```toml
   [profile.release]
   lto = "thin"
   codegen-units = 1
   debug = "line-tables-only" # Enough for exact file:line in Sentry without huge DWARF bloat
   strip = "symbols"          # Strip user-facing binary after splitting debug files
   ```
3. **CI Symbol Upload (`sentry-cli`):**
   - Before stripping (or using split `.dSYM` / `.pdb` / `.debug` artifacts), upload debug symbols in CI:
     ```bash
     sentry-cli debug-files upload --include-sources target/release/
     ```

---

## 4. Vendor-Agnostic: Sentry SaaS, BugSink, or GlitchTip

Because the Rust `sentry` crate speaks the standard Sentry envelope/DSN protocol, **your Rust code is 100% portable across backends** simply by changing `SENTRY_DSN`:

| Backend | Best For | Setup |
| :--- | :--- | :--- |
| **Sentry SaaS** | Managed symbolication, GitHub PR linking, and official `@sentry/mcp-server` | Standard `https://<key>@o<org>.ingest.sentry.io/<project>` DSN |
| **BugSink** (Self-Hosted) | High-volume Rust apps on a single \$5–\$10 VM (single binary, SQLite/Postgres, zero event-quota anxiety) | Point `SENTRY_DSN` at your BugSink host |
| **GlitchTip** (Self-Hosted) | Open-source team error + uptime tracking | Point `SENTRY_DSN` at your GlitchTip host |

---

## 5. Closed-Loop Agent Triage: Sentry Issue → Worktree Regression Fix

Because our Flat-DAG workspace places each domain in `crates/<domain>/src/...`, every production stacktrace immediately identifies the owning Cargo package and blast radius.

### Automated Triage Workflow (`codex-team`)
1. **Extract Issue Context:**
   Run the `codex-team` triage helper against a Sentry issue JSON file or live Sentry/BugSink/GlitchTip API:
   ```bash
   node <pluginRoot>/scripts/sentry-triage.mjs --issue <issue-id-or-json-path> --cwd /path/to/workspace
   ```
2. **What `sentry-triage.mjs` Produces:**
   - Parses the stacktrace frames to identify the affected workspace crates (`crates/<name>/src/<file>.rs:<line>`).
   - Builds a scoped `codex_start` payload with:
     - `isolation: "worktree"` (gets a 50ms APFS/CoW warm `target/` clone).
     - `scope: ["crates/<name>/**"]`
     - `verification`: `cargo test -p <name> -- --nocapture` + `rust` profile gates (`cargo-affected` clippy & tests).
     - **Strict TDD Criteria:**
       1. Write a unit test in `crates/<name>` that reproduces the exact panic/error from the Sentry issue.
       2. Fix the root cause using proper `Result` / domain error handling (no `.unwrap()` / `.expect()`).
       3. Verify all affected crates pass `clippy -D warnings` and `cargo test`.
