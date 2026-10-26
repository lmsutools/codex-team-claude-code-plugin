#!/usr/bin/env bash
# check_env.sh: report the Rust build environment and OS speed traps (macOS / Linux).
# Read-only: never changes system settings; prints suggested fixes instead.
set -uo pipefail

ok()   { printf "  [ok]   %s\n" "$*"; }
warn() { printf "  [warn] %s\n" "$*"; }
info() { printf "  [info] %s\n" "$*"; }

OS="$(uname -s)"
echo "== Machine"
if [ "$OS" = Darwin ]; then
  info "$(sw_vers -productName) $(sw_vers -productVersion), $(sysctl -n machdep.cpu.brand_string)"
  CORES=$(sysctl -n hw.ncpu); RAM_GB=$(( $(sysctl -n hw.memsize) / 1073741824 ))
else
  info "$(. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-Linux}"), $(awk -F: '/model name/{print $2; exit}' /proc/cpuinfo)"
  CORES=$(nproc); RAM_GB=$(( $(awk '/MemTotal/{print $2}' /proc/meminfo) / 1048576 ))
fi
info "cores: $CORES, RAM: ${RAM_GB} GB ($(( RAM_GB / (CORES>0?CORES:1) )) GB/core)"
if [ "$RAM_GB" -le 8 ]; then
  warn "Low-memory host (${RAM_GB} GB RAM): cap CARGO_BUILD_JOBS=2 (or 3), set rust-analyzer.numThreads=2 + CARGO_BUILD_JOBS=2, use debug=false in [profile.dev], and run at most 1-2 parallel codex_batch worktrees (see build-performance.md §12)"
elif [ "$RAM_GB" -le 16 ] || [ $(( RAM_GB / (CORES>0?CORES:1) )) -lt 2 ]; then
  warn "Memory-constrained ratio (${RAM_GB} GB RAM / ${CORES} cores): consider CARGO_BUILD_JOBS=$(( RAM_GB / 2 )) during full-workspace or -Zthreads builds, and cap parallel codex_batch worktrees to 2-3 (see build-performance.md §12)"
fi

FREE_GB=$(df -Pk . | awk 'NR==2{print int($4/1048576)}')
if [ "$FREE_GB" -lt 20 ]; then warn "free disk here: ${FREE_GB} GB. Large workspaces need 5-20 GB per target dir. Don't run benchmarks."
else ok "free disk here: ${FREE_GB} GB"; fi

echo "== Toolchain"
if command -v rustup >/dev/null 2>&1; then
  ok "rustup $(rustup --version 2>/dev/null | awk '{print $2}')"
  info "active: $(rustup show active-toolchain 2>/dev/null | head -1)"
  if rustup toolchain list 2>/dev/null | grep -q nightly; then
    info "nightly installed (fast lane available: scripts/cargo-fast.sh)"
    rustup component list --toolchain nightly --installed 2>/dev/null | grep -q cranelift \
      && info "Cranelift preview component installed" || info "Cranelift not installed (rustup component add rustc-codegen-cranelift-preview --toolchain nightly)"
  else
    info "no nightly toolchain (fast lane unavailable; that's fine)"
  fi
else
  warn "rustup not found: install from https://rustup.rs"
fi
command -v cargo >/dev/null 2>&1 && ok "$(cargo --version)" || warn "cargo not found"
command -v rustc >/dev/null 2>&1 && ok "$(rustc --version)"
for t in cargo-nextest cargo-deny cargo-shear cargo-llvm-lines sccache cargo-xwin cargo-zigbuild; do
  if command -v "$t" >/dev/null 2>&1; then ok "$t"; else info "$t not installed (cargo binstall $t)"; fi
done

echo "== Linker"
if [ "$OS" = Darwin ]; then
  if ld -v 2>&1 | grep -qi "ld-prime\|PROJECT:ld-"; then ok "Apple ld (ld-prime) - fast, nothing to change"
  else info "$(ld -v 2>&1 | head -1)"; fi
else
  command -v mold >/dev/null 2>&1 && ok "mold available" || info "mold not installed (optional: faster links on Linux)"
  command -v wild >/dev/null 2>&1 && ok "wild available"
  command -v clang >/dev/null 2>&1 && ok "clang available" || info "clang not installed (needed to use mold/lld via -fuse-ld)"
fi

echo "== OS speed traps"
if [ "$OS" = Darwin ]; then
  # macOS offers no CLI query for the Developer Tools list, so this is a reminder, not a check.
  info "XProtect scans every new build script/test binary unless your terminal/IDE is a Developer Tool. One-time fix: sudo spctl developer-mode enable-terminal, then System Settings > Privacy & Security > Developer Tools: enable terminal + IDE (+ tmux/zellij), restart them"
  if [ -d target ] && [ ! -e target/.metadata_never_index ]; then warn "target/ is Spotlight-indexed: touch target/.metadata_never_index"; fi
  case "$PWD" in *"Mobile Documents"*|*iCloud*|*Dropbox*|*OneDrive*) warn "project is inside a synced folder: move it out";; esac
else
  case "$(df -PT . 2>/dev/null | awk 'NR==2{print $2}')" in
    nfs*|cifs|fuse*) warn "project on a network/FUSE filesystem: use local NVMe";;
  esac
fi

echo "== Project (if run from a workspace root)"
if [ -f Cargo.toml ]; then
  grep -q 'line-tables-only' Cargo.toml && ok "dev debug = line-tables-only" || warn "set [profile.dev] debug = \"line-tables-only\""
  [ -f rust-toolchain.toml ] && ok "rust-toolchain.toml present" || warn "no rust-toolchain.toml (pin the toolchain)"
  [ -f PLATFORMS.md ] && ok "PLATFORMS.md present" || warn "no PLATFORMS.md: run the platform intake (ask the owner)"
  if [ -f .vscode/settings.json ] && grep -q 'rust-analyzer.cargo.targetDir' .vscode/settings.json; then ok "rust-analyzer has its own target dir"
  else info "set \"rust-analyzer.cargo.targetDir\": true in your editor settings"; fi
  grep -v '^[[:space:]]*#' .cargo/config.toml 2>/dev/null | grep -q -- '-Z' && warn ".cargo/config.toml contains -Z flags (breaks stable): move them to scripts/cargo-fast.sh"
  [ -n "${RUSTFLAGS:-}" ] && warn "RUSTFLAGS is set in the environment (\"$RUSTFLAGS\"): it invalidates caches across tools"
fi
exit 0
