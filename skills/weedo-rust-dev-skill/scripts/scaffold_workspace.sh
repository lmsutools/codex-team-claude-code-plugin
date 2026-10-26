#!/usr/bin/env bash
# scaffold_workspace.sh: generate a wide/shallow, multi-platform Rust workspace.
#
# Usage:
#   scaffold_workspace.sh <name> [parent-dir] --ship <oses> [--ready <oses>] [--out <oses>]
#                         [--kind desktop|cli|server|lib] [--arch x64,arm64] [--force]
#   <oses> = comma list of: windows, macos, linux
#   OSes not listed in --ship or --out default to --ready (compile-checked in CI).
#
# Example:
#   scaffold_workspace.sh acme ~/code --ship windows --kind desktop --arch x64,arm64
#
# The platform decision must come from the owner (platform intake). This script refuses
# to guess: --ship is required.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TPL="$SKILL_DIR/resources/templates"

die() { echo "error: $*" >&2; exit 1; }

NAME="${1:-}"; [ -n "$NAME" ] || die "missing <name>. See header for usage."
shift
PARENT="."
if [ $# -gt 0 ] && [ "${1#--}" = "$1" ]; then PARENT="$1"; shift; fi

SHIP=""; READY=""; OUT=""; KIND="cli"; ARCH="x64,arm64"; FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --ship)  SHIP="$2"; shift 2 ;;
    --ready) READY="$2"; shift 2 ;;
    --out)   OUT="$2"; shift 2 ;;
    --kind)  KIND="$2"; shift 2 ;;
    --arch)  ARCH="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    *) die "unknown option $1" ;;
  esac
done

echo "$NAME" | grep -Eq '^[a-z][a-z0-9-]*$' || die "name must match ^[a-z][a-z0-9-]*$"
[ -n "$SHIP" ] || die "--ship is required. Run the platform intake (ask the owner: Windows / macOS / Linux?) first."
case "$KIND" in desktop|cli|server|lib) ;; *) die "--kind must be desktop|cli|server|lib" ;; esac

has() { echo ",$1," | grep -q ",$2,"; }
for os in $(echo "$SHIP,$READY,$OUT" | tr ',' ' '); do
  case "$os" in windows|macos|linux) ;; *) die "unknown OS '$os' (use windows, macos, linux)";; esac
done
for os in windows macos linux; do
  if ! has "$SHIP" "$os" && ! has "$READY" "$os" && ! has "$OUT" "$os"; then
    READY="${READY:+$READY,}$os"
  fi
done

triples_for() { # os -> space-separated triples
  local os=$1 t=""
  case "$os" in
    windows) has "$ARCH" x64 && t="$t x86_64-pc-windows-msvc"; has "$ARCH" arm64 && t="$t aarch64-pc-windows-msvc" ;;
    macos)   t=" aarch64-apple-darwin"; has "$ARCH" x64 && t="$t x86_64-apple-darwin" ;;
    linux)   has "$ARCH" x64 && t="$t x86_64-unknown-linux-gnu"; has "$ARCH" arm64 && t="$t aarch64-unknown-linux-gnu" ;;
  esac
  echo $t
}
tier_of() { if has "$SHIP" "$1"; then echo Ship; elif has "$OUT" "$1"; then echo Out; else echo Ready; fi; }

ALL_TRIPLES=""
for os in windows macos linux; do
  [ "$(tier_of $os)" = Out ] && continue
  ALL_TRIPLES="$ALL_TRIPLES $(triples_for $os)"
done

# Toolchain version: pin to the installed stable if available.
if command -v rustc >/dev/null 2>&1; then
  FULL_VER="$(rustc --version | awk '{print $2}' | sed 's/-.*//')"
else
  FULL_VER="1.99.1"
fi
RUST_VERSION="$(echo "$FULL_VER" | cut -d. -f1-2)"
NAME_ID="$(echo "$NAME" | tr '-' '_')"
DATE="$(date +%Y-%m-%d)"

ROOT="$PARENT/$NAME"
if [ -e "$ROOT" ] && [ "$FORCE" -ne 1 ]; then die "$ROOT already exists (use --force to overwrite files)"; fi
mkdir -p "$ROOT"/{.cargo,.config,.codex-team,.github/workflows,.vscode,scripts,apps/"$NAME"/src}
mkdir -p "$ROOT"/crates/{domain,app,platform,store-memory,telemetry,test-support}/src "$ROOT"/crates/app/tests/it

subst() { sed -e "s/{{NAME}}/$NAME/g" -e "s/{{NAME_ID}}/$NAME_ID/g" -e "s/{{RUST_VERSION}}/$RUST_VERSION/g" -e "s/{{DATE}}/$DATE/g" -e "s/{{KIND}}/$KIND/g"; }

# ---------- root files ----------
subst < "$TPL/Cargo.toml" > "$ROOT/Cargo.toml"
cp "$TPL/cargo-config.toml" "$ROOT/.cargo/config.toml"
cp "$TPL/deny.toml" "$ROOT/deny.toml"
cp "$TPL/nextest.toml" "$ROOT/.config/nextest.toml"
cp "$TPL/bacon.toml" "$ROOT/bacon.toml"
subst < "$TPL/AGENTS.md" > "$ROOT/AGENTS.md"
cp "$SKILL_DIR/scripts/cargo-fast.sh" "$SKILL_DIR/scripts/cargo-fast.ps1" "$ROOT/scripts/"
cp "$SKILL_DIR/scripts/zthreads_sweep.sh" "$SKILL_DIR/scripts/timings_parallelism.py" "$SKILL_DIR/scripts/check-rust-arch.mjs" "$SKILL_DIR/scripts/rust-add-crate.mjs" "$ROOT/scripts/"

cat > "$ROOT/.codex-team/profile.json" <<'EOF'
{
  "version": "1.0",
  "extends": "rust",
  "components": {
    "gates": {
      "level": "enforce",
      "checks": {
        "arch": {
          "level": "enforce",
          "when": { "changed": ["**/*.rs", "**/Cargo.toml"] },
          "command": ["node", "${pluginRoot}/scripts/check-rust-arch.mjs"],
          "timeoutSeconds": 60
        }
      }
    }
  }
}
EOF

{
  echo '[toolchain]'
  echo "channel = \"$FULL_VER\""
  echo 'profile = "minimal"'
  echo 'components = ["rustfmt", "clippy"]'
  printf 'targets = ['
  first=1; for t in $ALL_TRIPLES; do [ $first -eq 1 ] && first=0 || printf ', '; printf '"%s"' "$t"; done
  echo ']'
} > "$ROOT/rust-toolchain.toml"

cat > "$ROOT/clippy.toml" <<'EOF'
allow-unwrap-in-tests = true
allow-expect-in-tests = true
allow-dbg-in-tests = true
EOF

cat > "$ROOT/.gitattributes" <<'EOF'
* text=auto eol=lf
*.ps1 text eol=crlf
*.png binary
*.jpg binary
*.ico binary
*.icns binary
EOF

cat > "$ROOT/.gitignore" <<'EOF'
/target
/target-*
junit.xml
EOF

cat > "$ROOT/.vscode/settings.json" <<'EOF'
{
  "rust-analyzer.cargo.targetDir": true,
  "rust-analyzer.check.command": "clippy"
}
EOF

# PLATFORMS.md
ROWS=""
for os in windows macos linux; do
  label=$os; [ $os = macos ] && label=macOS; [ $os = windows ] && label=Windows; [ $os = linux ] && label=Linux
  tier=$(tier_of $os); trip=$(triples_for $os)
  archs=$(echo "$trip" | sed -e 's/x86_64[^ ]*/x64/g' -e 's/aarch64[^ ]*/arm64/g')
  [ "$tier" = Out ] && { trip="-"; archs="-"; }
  ROWS="${ROWS}| ${label} | **${tier}** | ${archs} | \`${trip}\` |\\
"
done
subst < "$TPL/PLATFORMS.md" | sed "s/{{PLATFORM_ROWS}}/$ROWS/" | cat -s > "$ROOT/PLATFORMS.md"

# ---------- crates ----------
member_toml() { # dir pkg-name kind(lib|bin) deps-block [dev-deps-block] [extra]
  cat > "$ROOT/$1/Cargo.toml" <<EOF
[package]
name = "$2"
version.workspace = true
edition.workspace = true
rust-version.workspace = true
publish.workspace = true
license.workspace = true

[lints]
workspace = true
$6
[dependencies]
$4

[dev-dependencies]
$5
EOF
}

member_toml crates/domain "$NAME-domain" lib "" "" "
[lib]
doctest = false
"
cat > "$ROOT/crates/domain/src/lib.rs" <<'EOF'
//! Pure domain types and rules. No I/O, no async runtime, near-zero dependencies.
//! Entities reference each other by ID newtypes (Copy + 'static + Send + Sync).

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct CustomerId(pub u64);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct OrderId(pub u64);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Order {
    pub id: OrderId,
    pub customer: CustomerId,
    pub total_cents: i64,
}

impl Order {
    /// Domain rule example: totals can't be negative.
    pub fn new(id: OrderId, customer: CustomerId, total_cents: i64) -> Option<Self> {
        (total_cents >= 0).then_some(Self { id, customer, total_cents })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_negative_totals() {
        assert!(Order::new(OrderId(1), CustomerId(1), -5).is_none());
        assert!(Order::new(OrderId(1), CustomerId(1), 5).is_some());
    }
}
EOF

member_toml crates/app "$NAME-app" lib "$NAME-domain = { workspace = true }
thiserror = { workspace = true }
tracing = { workspace = true }" "$NAME-test-support = { workspace = true }" "
[lib]
doctest = false
"
cat > "$ROOT/crates/app/src/lib.rs" <<EOF
//! Use-cases and port traits. Adapters and the platform crate implement the ports.
//! Ports are object-safe and used as \`Arc<dyn Port>\` at subsystem boundaries.
//! For async ports used through \`dyn\`, add \`#[async_trait::async_trait]\`
//! (native async fn in traits is not dyn-compatible).

use std::path::PathBuf;
use std::sync::Arc;

pub use ${NAME_ID}_domain as domain;
use ${NAME_ID}_domain::{Order, OrderId};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("order {0:?} not found")]
    NotFound(OrderId),
    #[error("invalid order")]
    Invalid,
    #[error("storage failure: {0}")]
    Storage(String),
}

/// Storage port.
pub trait OrderRepo: Send + Sync {
    fn get(&self, id: OrderId) -> Result<Option<Order>, AppError>;
    fn put(&self, order: Order) -> Result<(), AppError>;
}

/// OS integration port, implemented once per OS in the \`platform\` crate.
pub trait Platform: Send + Sync {
    fn os_name(&self) -> &'static str;
    fn data_dir(&self, app_name: &str) -> PathBuf;
}

#[derive(Clone)]
pub struct OrderService {
    repo: Arc<dyn OrderRepo>,
}

impl std::fmt::Debug for OrderService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OrderService").finish_non_exhaustive()
    }
}

impl OrderService {
    pub fn new(repo: Arc<dyn OrderRepo>) -> Self {
        Self { repo }
    }

    pub fn place(&self, order: Order) -> Result<(), AppError> {
        tracing::debug!(id = ?order.id, "placing order");
        self.repo.put(order)
    }

    pub fn fetch(&self, id: OrderId) -> Result<Order, AppError> {
        self.repo.get(id)?.ok_or(AppError::NotFound(id))
    }
}
EOF
cat > "$ROOT/crates/app/tests/it/main.rs" <<'EOF'
//! Single integration-test binary for this crate (one link step).
//! Add modules here instead of new files under tests/.
mod orders;
EOF
cat > "$ROOT/crates/app/tests/it/orders.rs" <<EOF
use std::sync::Arc;

use ${NAME_ID}_app::OrderService;
use ${NAME_ID}_app::domain::{CustomerId, Order, OrderId};
use ${NAME_ID}_test_support::FakeRepo;

#[test]
fn place_then_fetch() {
    let svc = OrderService::new(Arc::new(FakeRepo::default()));
    let order = Order::new(OrderId(7), CustomerId(1), 1200).unwrap();
    svc.place(order.clone()).unwrap();
    assert_eq!(svc.fetch(OrderId(7)).unwrap(), order);
}
EOF

member_toml crates/platform "$NAME-platform" lib "$NAME-app = { workspace = true }

# OS-only dependencies stay target-scoped so other OSes never compile them:
# [target.'cfg(windows)'.dependencies]
# windows-sys = { workspace = true }
# [target.'cfg(target_os = \"macos\")'.dependencies]
# objc2-foundation = { workspace = true }" "" "
[lib]
doctest = false
"
cat > "$ROOT/crates/platform/src/lib.rs" <<EOF
//! The ONLY crate allowed to contain \`#[cfg(target_os = ...)]\`.
//! Each OS module implements the same ports from \`app\`.

use std::path::PathBuf;

use ${NAME_ID}_app::Platform;

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
use windows as os;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos as os;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
use linux as os;

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
compile_error!("unsupported OS: add a module in crates/platform and update PLATFORMS.md");

/// The current OS implementation.
#[derive(Debug, Default, Clone, Copy)]
pub struct OsPlatform;

impl Platform for OsPlatform {
    fn os_name(&self) -> &'static str {
        os::NAME
    }

    fn data_dir(&self, app_name: &str) -> PathBuf {
        os::data_dir().join(app_name)
    }
}

fn env_path(key: &str) -> Option<PathBuf> {
    std::env::var_os(key).filter(|v| !v.is_empty()).map(PathBuf::from)
}
EOF
cat > "$ROOT/crates/platform/src/windows.rs" <<'EOF'
use std::path::PathBuf;

pub(crate) const NAME: &str = "windows";

pub(crate) fn data_dir() -> PathBuf {
    super::env_path("APPDATA").unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"))
}
EOF
cat > "$ROOT/crates/platform/src/macos.rs" <<'EOF'
use std::path::PathBuf;

pub(crate) const NAME: &str = "macos";

pub(crate) fn data_dir() -> PathBuf {
    super::env_path("HOME")
        .map(|h| h.join("Library").join("Application Support"))
        .unwrap_or_else(|| PathBuf::from("/tmp"))
}
EOF
cat > "$ROOT/crates/platform/src/linux.rs" <<'EOF'
use std::path::PathBuf;

pub(crate) const NAME: &str = "linux";

pub(crate) fn data_dir() -> PathBuf {
    super::env_path("XDG_DATA_HOME")
        .or_else(|| super::env_path("HOME").map(|h| h.join(".local").join("share")))
        .unwrap_or_else(|| PathBuf::from("/tmp"))
}
EOF

member_toml crates/store-memory "$NAME-store-memory" lib "$NAME-app = { workspace = true }" "" "
[lib]
doctest = false
"
cat > "$ROOT/crates/store-memory/src/lib.rs" <<EOF
//! In-memory adapter for the \`OrderRepo\` port. Sibling of other adapters (db, http, ...).

use std::collections::HashMap;
use std::sync::Mutex;

use ${NAME_ID}_app::domain::{Order, OrderId};
use ${NAME_ID}_app::{AppError, OrderRepo};

#[derive(Debug, Default)]
pub struct MemoryOrderRepo {
    // Short critical sections, never held across .await.
    orders: Mutex<HashMap<OrderId, Order>>,
}

impl OrderRepo for MemoryOrderRepo {
    fn get(&self, id: OrderId) -> Result<Option<Order>, AppError> {
        let map = self.orders.lock().map_err(|e| AppError::Storage(e.to_string()))?;
        Ok(map.get(&id).cloned())
    }

    fn put(&self, order: Order) -> Result<(), AppError> {
        let mut map = self.orders.lock().map_err(|e| AppError::Storage(e.to_string()))?;
        map.insert(order.id, order);
        Ok(())
    }
}
EOF

member_toml crates/telemetry "$NAME-telemetry" lib "tracing = { workspace = true }
tracing-subscriber = { workspace = true }" "" "
[lib]
doctest = false
"
cp "$TPL/telemetry.rs" "$ROOT/crates/telemetry/src/lib.rs"

member_toml crates/test-support "$NAME-test-support" lib "$NAME-app = { workspace = true }" "" "
[lib]
doctest = false
"
cat > "$ROOT/crates/test-support/src/lib.rs" <<EOF
//! Shared fakes/fixtures. Use ONLY as a dev-dependency.

use std::collections::HashMap;
use std::sync::Mutex;

use ${NAME_ID}_app::domain::{Order, OrderId};
use ${NAME_ID}_app::{AppError, OrderRepo};

#[derive(Debug, Default)]
pub struct FakeRepo(Mutex<HashMap<OrderId, Order>>);

impl OrderRepo for FakeRepo {
    fn get(&self, id: OrderId) -> Result<Option<Order>, AppError> {
        Ok(self.0.lock().expect("fake repo lock poisoned").get(&id).cloned())
    }

    fn put(&self, order: Order) -> Result<(), AppError> {
        self.0.lock().expect("fake repo lock poisoned").insert(order.id, order);
        Ok(())
    }
}
EOF

member_toml "apps/$NAME" "$NAME" bin "$NAME-app = { workspace = true }
$NAME-platform = { workspace = true }
$NAME-store-memory = { workspace = true }
$NAME-telemetry = { workspace = true }
anyhow = { workspace = true }
tracing = { workspace = true }" "" ""
cat > "$ROOT/apps/$NAME/src/main.rs" <<EOF
//! Composition root: read config, build adapters, inject, run. Keep it thin:
//! this crate is re-linked on every change.

use std::sync::Arc;

use ${NAME_ID}_app::domain::{CustomerId, Order, OrderId};
use ${NAME_ID}_app::{OrderService, Platform};
use ${NAME_ID}_platform::OsPlatform;
use ${NAME_ID}_store_memory::MemoryOrderRepo;
use ${NAME_ID}_telemetry::{TelemetryConfig, init as init_telemetry};

fn main() -> anyhow::Result<()> {
    let _telemetry = init_telemetry(TelemetryConfig::from_env(
        env!("CARGO_PKG_NAME"),
        env!("CARGO_PKG_VERSION"),
    ));

    let platform = OsPlatform;
    let service = OrderService::new(Arc::new(MemoryOrderRepo::default()));

    let order = Order::new(OrderId(1), CustomerId(42), 1999).ok_or_else(|| anyhow::anyhow!("invalid order"))?;
    service.place(order)?;
    let fetched = service.fetch(OrderId(1))?;

    println!(
        "{} on {}: order {:?} = {} cents (data dir: {})",
        env!("CARGO_PKG_NAME"),
        platform.os_name(),
        fetched.id,
        fetched.total_cents,
        platform.data_dir(env!("CARGO_PKG_NAME")).display()
    );
    Ok(())
}
EOF

# ---------- CI workflow (matrix derived from tiers) ----------
CROSS_TRIPLES=""
for os in windows macos linux; do
  [ "$(tier_of $os)" = Out ] && continue
  for t in $(triples_for $os); do
    [ "$t" = x86_64-unknown-linux-gnu ] && continue   # host of the lint runner
    CROSS_TRIPLES="$CROSS_TRIPLES $t"
  done
done
RUNNERS=""
has "$SHIP" windows && RUNNERS="$RUNNERS windows-latest"
has "$SHIP" macos   && RUNNERS="$RUNNERS macos-latest"
has "$SHIP" linux   && RUNNERS="$RUNNERS ubuntu-latest"

{
cat <<'EOF'
# Generated by weedo-rust-dev-skill from PLATFORMS.md tiers.
# lint: fmt, deny, clippy + check for EVERY Ship and Ready target (cheap Linux runner)
# test: native build + nextest on every Ship OS
name: CI
on:
  push:
    branches: [main]
  pull_request:

env:
  CARGO_TERM_COLOR: always
  RUST_BACKTRACE: 1

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install toolchain from rust-toolchain.toml
        run: rustup toolchain install
      - uses: Swatinem/rust-cache@v2
      - run: cargo fmt --all --check
      - run: cargo clippy --workspace --all-targets --locked --profile ci -- -D warnings
EOF
for t in $CROSS_TRIPLES; do
cat <<EOF
      - name: clippy (${t})
        run: cargo clippy --workspace --all-targets --locked --profile ci --target ${t} -- -D warnings
EOF
done
cat <<'EOF'
      - uses: EmbarkStudios/cargo-deny-action@v2
      - name: doctests
        run: cargo test --doc --workspace --locked
EOF
if [ -n "$RUNNERS" ]; then
cat <<'EOF'

  test:
    needs: lint
    strategy:
      fail-fast: false
      matrix:
EOF
printf '        os: ['
first=1; for r in $RUNNERS; do [ $first -eq 1 ] && first=0 || printf ', '; printf '%s' "$r"; done
echo ']'
cat <<'EOF'
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - name: Install toolchain from rust-toolchain.toml
        run: rustup toolchain install
      - uses: Swatinem/rust-cache@v2
      - uses: taiki-e/install-action@nextest
      - run: cargo nextest run --workspace --locked --cargo-profile ci --profile ci
      - name: build timings
        run: cargo build --workspace --locked --profile ci --timings
      - uses: actions/upload-artifact@v4
        with:
          name: cargo-timings-${{ matrix.os }}
          path: target/cargo-timings/cargo-timing.html
EOF
fi
} > "$ROOT/.github/workflows/ci.yml"

# Normalize formatting of generated Rust code (installs the pinned toolchain if needed).
if command -v cargo >/dev/null 2>&1; then
  (cd "$ROOT" && rustup toolchain install >/dev/null 2>&1; cargo fmt --all >/dev/null 2>&1; cargo generate-lockfile -q 2>/dev/null) || true
fi

echo "Scaffolded $ROOT"
echo "  Ship:  ${SHIP}"
echo "  Ready: ${READY:-none}"
echo "  Out:   ${OUT:-none}"
echo "  Targets in rust-toolchain.toml:${ALL_TRIPLES}"
echo
echo "Next:"
echo "  cd $ROOT && cargo check --workspace --all-targets"
for t in $ALL_TRIPLES; do echo "  cargo check --workspace --all-targets --target $t"; done
echo "  cargo build --timings && python3 scripts/timings_parallelism.py target/cargo-timings/cargo-timing.html"
