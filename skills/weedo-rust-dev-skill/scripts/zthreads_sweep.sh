#!/usr/bin/env bash
# zthreads_sweep.sh: find the best -Zthreads value for THIS machine and THIS workspace.
# Runs clean nightly builds for several thread counts, records wall time + peak RSS,
# deletes each target dir afterwards (disk safety), and prints a Markdown table plus a
# recommendation (smallest N within 5% of the best time).
#
# Usage: scripts/zthreads_sweep.sh [-p <package>] [--release] [--counts "4 8 12 16 24 32"]
# Env:   SWEEP_NIGHTLY (default nightly)
set -euo pipefail

TC="${SWEEP_NIGHTLY:-nightly}"
PKG_ARGS=(); PROFILE_ARGS=(); COUNTS=""
while [ $# -gt 0 ]; do
  case "$1" in
    -p) PKG_ARGS=(-p "$2"); shift 2 ;;
    --release) PROFILE_ARGS=(--release); shift ;;
    --counts) COUNTS="$2"; shift 2 ;;
    *) echo "unknown arg $1" >&2; exit 1 ;;
  esac
done

if [ "$(uname)" = Darwin ]; then
  CORES=$(sysctl -n hw.ncpu); RAM_GB=$(( $(sysctl -n hw.memsize) / 1073741824 ))
  TIME_CMD=(/usr/bin/time -l)
else
  CORES=$(nproc); RAM_GB=$(( $(awk '/MemTotal/{print $2}' /proc/meminfo) / 1048576 ))
  TIME_CMD=(/usr/bin/time -v)
fi
[ -n "$COUNTS" ] || COUNTS="1 4 8 12 16 24 32 48 64"

# Disk guard: need ~2x the size of a normal target dir; refuse if < 10 GB free.
FREE_GB=$(df -Pk . | awk 'NR==2{print int($4/1048576)}')
if [ "$FREE_GB" -lt 10 ]; then
  echo "error: only ${FREE_GB} GB free; need >= 10 GB for a safe sweep." >&2; exit 1
fi

rustup run "$TC" rustc --version >/dev/null 2>&1 || rustup toolchain install "$TC" --profile minimal
cargo "+$TC" fetch -q

echo "# -Zthreads sweep ($(hostname), ${CORES} cores, ${RAM_GB} GB RAM, $(rustup run "$TC" rustc --version))"
echo
echo "| -Zthreads | Wall (s) | Peak RSS of largest rustc (GB) |"
echo "| --: | --: | --: |"

RESULTS=""
TD="target-sweep"
for n in $COUNTS; do
  [ "$n" -gt "$CORES" ] && continue
  rm -rf "$TD"
  LOG=$(mktemp)
  start=$(python3 -c 'import time; print(time.time())')
  if ! "${TIME_CMD[@]}" cargo "+$TC" build -q --target-dir "$TD" ${PKG_ARGS[@]+"${PKG_ARGS[@]}"} ${PROFILE_ARGS[@]+"${PROFILE_ARGS[@]}"} \
       --config "build.rustflags=[\"-Zthreads=$n\"]" 2> "$LOG" >/dev/null; then
    echo "| $n | FAILED | see $LOG |"; continue
  fi
  end=$(python3 -c 'import time; print(time.time())')
  wall=$(python3 -c "print(round($end - $start, 1))")
  if [ "$(uname)" = Darwin ]; then
    rss=$(awk '/maximum resident set size/{print $1}' "$LOG" | sort -n | tail -1)
    rss_gb=$(python3 -c "print(round(${rss:-0}/1073741824, 2))")
  else
    rss=$(awk -F: '/Maximum resident set size/{gsub(/ /,"",$2); print $2}' "$LOG" | sort -n | tail -1)
    rss_gb=$(python3 -c "print(round(${rss:-0}/1048576, 2))")
  fi
  echo "| $n | $wall | $rss_gb |"
  RESULTS="$RESULTS $n:$wall"
  rm -rf "$TD" "$LOG"
done

python3 - "$RESULTS" <<'EOF'
import sys
pairs = [p.split(":") for p in sys.argv[1].split()]
if not pairs:
    sys.exit(0)
pairs = [(int(n), float(w)) for n, w in pairs]
best = min(w for _, w in pairs)
rec = min(n for n, w in pairs if w <= best * 1.05)
base = dict(pairs).get(1)
print()
if rec == 1:
    print(f"**Recommendation:** skip -Zthreads on this machine/workspace: no value beat single-threaded by >5% "
          f"(best {best:.1f}s). The cores are already busy with separate crates. Fix the critical path or use a "
          f"bigger machine first.")
else:
    print(f"**Recommendation:** -Zthreads={rec} (smallest value within 5% of the best wall time {best:.1f}s).")
if base:
    print(f"Speed-up vs -Zthreads=1: {base / dict(pairs)[rec]:.2f}x.")
print("Record it in PLATFORMS.md > Build machines. Note: peak RSS above is the largest single process (GNU/BSD time reports the max child).")
EOF
