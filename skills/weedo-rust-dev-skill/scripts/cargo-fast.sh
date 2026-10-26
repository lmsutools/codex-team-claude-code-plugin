#!/usr/bin/env bash
# cargo-fast.sh: opt-in NIGHTLY fast lane for local dev builds (macOS / Linux).
#   * parallel frontend (-Zthreads=N)
#   * Cranelift codegen for the dev profile
#   * own target dir (target-fast/) so the stable cache is never invalidated
#
# Usage: scripts/cargo-fast.sh build|run|check [cargo args...]
# Env:   FAST_THREADS (default 8), FAST_NIGHTLY (default "nightly"; pin e.g. nightly-2026-10-20),
#        FAST_CRANELIFT=0 to disable Cranelift (e.g. when running tests on macOS/Windows).
#
# NOTE: on macOS/Windows Cranelift has no unwinding (panics abort), so `test` uses LLVM.
set -euo pipefail

if [ "$(uname -s)" = Darwin ]; then
  RAM_GB=$(( $(sysctl -n hw.memsize 2>/dev/null || echo 17179869184) / 1073741824 ))
else
  RAM_GB=$(( $(awk '/MemTotal/{print $2}' /proc/meminfo 2>/dev/null || echo 16777216) / 1048576 ))
fi
if [ "$RAM_GB" -le 8 ]; then
  DEF_THREADS=2; DEF_JOBS=2
elif [ "$RAM_GB" -le 16 ]; then
  DEF_THREADS=4; DEF_JOBS=$(( RAM_GB / 3 ))
else
  DEF_THREADS=8; DEF_JOBS=""
fi

TC="${FAST_NIGHTLY:-nightly}"
THREADS="${FAST_THREADS:-$DEF_THREADS}"
CRANELIFT="${FAST_CRANELIFT:-1}"
if [ -z "${CARGO_BUILD_JOBS:-}" ] && [ -n "$DEF_JOBS" ]; then
  export CARGO_BUILD_JOBS="$DEF_JOBS"
fi
SUB="${1:-build}"; shift || true

if ! rustup run "$TC" rustc --version >/dev/null 2>&1; then
  echo "Installing $TC + Cranelift preview component..." >&2
  rustup toolchain install "$TC" --profile minimal -c rustc-codegen-cranelift-preview
fi

ARGS=(--config "build.rustflags=[\"-Zthreads=${THREADS}\"]")
case "$SUB" in test|nextest|bench) CRANELIFT=0 ;; esac
if [ "$CRANELIFT" = 1 ]; then
  if rustup component list --toolchain "$TC" --installed 2>/dev/null | grep -q cranelift; then
    ARGS+=(--config 'profile.dev.codegen-backend="cranelift"' -Zcodegen-backend)
  else
    echo "warn: Cranelift component missing for $TC on this host; using LLVM." >&2
  fi
fi

exec cargo "+$TC" "${ARGS[@]}" "$SUB" --target-dir target-fast "$@"
