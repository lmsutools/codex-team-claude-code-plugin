#!/usr/bin/env bash
# remote_build.sh: sync the workspace to a remote VM over SSH, build there, fetch artifacts,
# and prevent idle-VM cloud bill waste while the local LLM reviews results.
#
# Usage:
#   scripts/remote_build.sh <ssh-host> [options] -- <cargo args...>
#   scripts/remote_build.sh <ssh-host> --install-watchdog [idle-minutes]
#
# Options:
#   --dir <remote-path>          Remote workspace directory (default: ~/src/<repo-name>)
#   --fetch <path-glob>          Rsync matching remote artifacts into ./remote-artifacts/
#   --poweroff                   Immediately power off the VM right after fetching artifacts
#                                (use before handing results to the local LLM for review!)
#   --install-watchdog [mins]    Install a dead-man's switch on the Linux VM that powers it
#                                off after <mins> (default: 15) of zero cargo/rustc activity.
#
# Examples:
#   scripts/remote_build.sh buildvm --install-watchdog 15
#   scripts/remote_build.sh buildvm --poweroff -- nextest run --workspace --profile ci
#   scripts/remote_build.sh buildvm --poweroff --fetch 'target/x86_64-pc-windows-msvc/release/*.exe' \
#       -- xwin build --release --target x86_64-pc-windows-msvc
set -euo pipefail

HOST="${1:?ssh host required}"; shift
NAME="$(basename "$PWD")"
RDIR="~/src/$NAME"; FETCH=""; POWEROFF=0; INSTALL_WATCHDOG=""

while [ $# -gt 0 ] && [ "$1" != "--" ]; do
  case "$1" in
    --dir) RDIR="$2"; shift 2 ;;
    --fetch) FETCH="$2"; shift 2 ;;
    --poweroff) POWEROFF=1; shift ;;
    --install-watchdog)
      if [ $# -ge 2 ] && [[ "${2:-}" =~ ^[0-9]+$ ]]; then
        INSTALL_WATCHDOG="$2"; shift 2
      else
        INSTALL_WATCHDOG="15"; shift
      fi
      ;;
    *) echo "unknown arg $1" >&2; exit 1 ;;
  esac
done
[ "${1:-}" = "--" ] && shift

if [ -n "$INSTALL_WATCHDOG" ]; then
  echo "==> installing ${INSTALL_WATCHDOG}-minute idle auto-shutdown watchdog on $HOST"
  # shellcheck disable=SC2029
  ssh "$HOST" "sudo tee /usr/local/bin/rust-vm-watchdog.sh >/dev/null <<'EOF'
#!/usr/bin/env bash
IDLE_MINS=${INSTALL_WATCHDOG}
HB=/tmp/.remote-build-heartbeat
[ -f \"\$HB\" ] || touch \"\$HB\"
if pgrep -x 'cargo|rustc|rustdoc|cargo-nextest|lld|rust-lld|mold|wild|cc1' >/dev/null 2>&1; then
  touch \"\$HB\"
  exit 0
fi
LAST=\$(stat -c %Y \"\$HB\" 2>/dev/null || date +%s)
NOW=\$(date +%s)
if [ \$(( (NOW - LAST) / 60 )) -ge \"\$IDLE_MINS\" ]; then
  logger -t rust-vm-watchdog \"No Rust build activity for \${IDLE_MINS}m; powering off VM.\"
  /sbin/poweroff || systemctl poweroff
fi
EOF
  sudo chmod +x /usr/local/bin/rust-vm-watchdog.sh
  echo '* * * * * root /usr/local/bin/rust-vm-watchdog.sh' | sudo tee /etc/cron.d/rust-vm-watchdog >/dev/null
  sudo chmod 644 /etc/cron.d/rust-vm-watchdog
  touch /tmp/.remote-build-heartbeat"
  echo "==> watchdog active on $HOST (powers off after ${INSTALL_WATCHDOG}m of zero cargo/rustc activity)"
  [ $# -eq 0 ] && exit 0
fi

[ $# -gt 0 ] || { echo "missing cargo args after --" >&2; exit 1; }

echo "==> sync $PWD -> $HOST:$RDIR"
ssh "$HOST" "mkdir -p $RDIR && touch /tmp/.remote-build-heartbeat"
rsync -az --delete \
  --exclude '/target' --exclude '/target-*' --exclude '.git/objects' \
  ./ "$HOST:$RDIR/"

echo "==> remote: cargo $*"
BUILD_STATUS=0
# shellcheck disable=SC2029
ssh -t "$HOST" "touch /tmp/.remote-build-heartbeat && cd $RDIR && source ~/.cargo/env 2>/dev/null; rustup toolchain install >/dev/null 2>&1; \
  echo \"cores: \$(nproc 2>/dev/null || sysctl -n hw.ncpu), free disk: \$(df -h . | awk 'NR==2{print \$4}')\"; \
  time cargo $*; STATUS=\$?; touch /tmp/.remote-build-heartbeat; exit \$STATUS" || BUILD_STATUS=$?

if [ -n "$FETCH" ] && [ "$BUILD_STATUS" -eq 0 ]; then
  echo "==> fetch $FETCH"
  mkdir -p remote-artifacts
  rsync -az "$HOST:$RDIR/$FETCH" remote-artifacts/
  ls -la remote-artifacts
fi

if [ "$POWEROFF" -eq 1 ]; then
  echo "==> --poweroff: shutting down $HOST immediately so VM costs \$0 while local LLM reviews"
  ssh "$HOST" "sudo nohup sh -c 'sleep 1 && (systemctl poweroff || /sbin/poweroff)' >/dev/null 2>&1 &" || true
fi

exit "$BUILD_STATUS"
