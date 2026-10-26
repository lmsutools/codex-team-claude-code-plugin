#!/usr/bin/env bash
# remote_build.sh: sync the workspace to a remote VM over SSH, build there, fetch artifacts.
# Keeps the fast local machine for the inner loop; offloads wide/clean/multi-target builds.
#
# Usage:
#   scripts/remote_build.sh <ssh-host> [--dir ~/src/<name>] [--fetch <path-glob>] -- <cargo args...>
# Examples:
#   scripts/remote_build.sh buildvm -- build --release --target x86_64-unknown-linux-gnu
#   scripts/remote_build.sh buildvm --fetch 'target/x86_64-pc-windows-msvc/release/*.exe' \
#       -- xwin build --release --target x86_64-pc-windows-msvc
#   scripts/remote_build.sh buildvm -- nextest run --workspace
#
# Prereqs on the VM: rustup (toolchain auto-installed from rust-toolchain.toml), rsync.
set -euo pipefail

HOST="${1:?ssh host required}"; shift
NAME="$(basename "$PWD")"
RDIR="~/src/$NAME"; FETCH=""
while [ $# -gt 0 ] && [ "$1" != "--" ]; do
  case "$1" in
    --dir) RDIR="$2"; shift 2 ;;
    --fetch) FETCH="$2"; shift 2 ;;
    *) echo "unknown arg $1" >&2; exit 1 ;;
  esac
done
[ "${1:-}" = "--" ] && shift
[ $# -gt 0 ] || { echo "missing cargo args after --" >&2; exit 1; }

echo "==> sync $PWD -> $HOST:$RDIR"
ssh "$HOST" "mkdir -p $RDIR"
rsync -az --delete \
  --exclude '/target' --exclude '/target-*' --exclude '.git/objects' \
  ./ "$HOST:$RDIR/"

echo "==> remote: cargo $*"
# shellcheck disable=SC2029
ssh -t "$HOST" "cd $RDIR && source ~/.cargo/env 2>/dev/null; rustup toolchain install >/dev/null 2>&1; \
  echo \"cores: \$(nproc 2>/dev/null || sysctl -n hw.ncpu), free disk: \$(df -h . | awk 'NR==2{print \$4}')\"; \
  time cargo $*"

if [ -n "$FETCH" ]; then
  echo "==> fetch $FETCH"
  mkdir -p remote-artifacts
  rsync -az "$HOST:$RDIR/$FETCH" remote-artifacts/
  ls -la remote-artifacts
fi
