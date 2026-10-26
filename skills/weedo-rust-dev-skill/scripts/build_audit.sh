#!/usr/bin/env bash
# build_audit.sh: diagnose why a Cargo workspace builds slowly. Writes build-audit.md.
#
# Usage (from the workspace root):
#   build_audit.sh            # static analysis only (fast, no build)
#   build_audit.sh --full     # + clean build with --timings and incremental rebuild timings
#                             #   (uses a separate target dir `target-audit`, deleted afterwards
#                             #    unless --keep; never touches your normal target/)
set -euo pipefail
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FULL=0; KEEP=0
for a in "$@"; do case "$a" in --full) FULL=1;; --keep) KEEP=1;; *) echo "unknown arg $a" >&2; exit 1;; esac; done
[ -f Cargo.toml ] || { echo "run from a workspace root" >&2; exit 1; }

OUT=build-audit.md
META=$(mktemp)
cargo metadata --format-version 1 --locked 2>/dev/null > "$META" || cargo metadata --format-version 1 > "$META"

{
echo "# Build audit: $(basename "$PWD") ($(date '+%Y-%m-%d %H:%M'))"
echo
echo "Toolchain: \`$(rustc --version)\` · Host cores: $( (nproc 2>/dev/null || sysctl -n hw.ncpu) )"
echo

python3 - "$META" <<'PY'
import json, sys, os, collections
m = json.load(open(sys.argv[1]))
pk = {p["id"]: p for p in m["packages"]}
members = set(m["workspace_members"])
nodes = {n["id"]: n for n in m["resolve"]["nodes"]}

def kinds(p):
    return {k for t in p["targets"] for k in t["kind"]}

all_ids = list(nodes)
proc = [pk[i]["name"] for i in all_ids if "proc-macro" in kinds(pk[i])]
bscripts = [pk[i]["name"] for i in all_ids if "custom-build" in kinds(pk[i])]
byname = collections.defaultdict(set)
for i in all_ids:
    byname[pk[i]["name"]].add(pk[i]["version"])
dups = {n: sorted(v) for n, v in byname.items() if len(v) > 1}

# workspace-internal depth
def internal_deps(i):
    return [d["pkg"] for d in nodes[i]["deps"] if d["pkg"] in members
            and any(k.get("kind") in (None, "normal") for k in d["dep_kinds"])]
memo = {}
def depth(i):
    if i in memo: return memo[i]
    memo[i] = 1 + max((depth(d) for d in internal_deps(i)), default=0)
    return memo[i]
max_depth = max(depth(i) for i in members)

def loc(p):
    root = os.path.dirname(p["manifest_path"]); n = 0
    for dp, _, fs in os.walk(root):
        if "/target" in dp: continue
        for f in fs:
            if f.endswith(".rs"):
                try: n += sum(1 for _ in open(os.path.join(dp, f), errors="ignore"))
                except OSError: pass
    return n

rows = []
total_loc = 0
for i in members:
    p = pk[i]; l = loc(p); total_loc += l
    tests = [t for t in p["targets"] if "test" in t["kind"]]
    rows.append((p["name"], l, depth(i), len(tests), len(internal_deps(i)),
                 len([d for d in nodes[i]["deps"] if d["pkg"] not in members])))
rows.sort(key=lambda r: -r[1])

print("## Workspace shape\n")
print(f"- Members: **{len(members)}**, Rust LOC: **{total_loc:,}**, total packages in graph: **{len(all_ids)}**")
print(f"- Max internal depth: **{max_depth}** " + ("✅" if max_depth <= 4 else "⚠️ (> 4: long serial chain; flatten)"))
big = rows[0] if rows else None
if big and total_loc and big[1] / total_loc > 0.35 and len(members) > 1:
    print(f"- ⚠️ `{big[0]}` holds {big[1]/total_loc:.0%} of the code: split it by change frequency")
if len(members) == 1:
    print("- ⚠️ Single-crate project: no inter-crate parallelism. Split into a workspace (architecture.md §1).")
print()
print("| Member | LOC | Depth | Integration test binaries | Internal deps | External deps |")
print("| :-- | --: | --: | --: | --: | --: |")
for r in rows:
    flag = " ⚠️" if r[3] > 1 else ""
    print(f"| {r[0]} | {r[1]:,} | {r[2]} | {r[3]}{flag} | {r[4]} | {r[5]} |")
if any(r[3] > 1 for r in rows):
    print("\n⚠️ Crates with >1 integration test binary: merge into `tests/it/main.rs` (one link step each).")

print("\n## Dependency weight\n")
print(f"- Proc-macro crates: **{len(proc)}** — {', '.join(sorted(set(proc))[:25])}{' …' if len(set(proc)) > 25 else ''}")
print(f"- Build scripts: **{len(bscripts)}** — {', '.join(sorted(set(bscripts))[:25])}{' …' if len(set(bscripts)) > 25 else ''}")
print(f"- Duplicate versions: **{len(dups)}**" + (" — " + ", ".join(f"{n} {v}" for n, v in sorted(dups.items())[:20]) if dups else ""))
PY

echo
echo "## Profiles and config"
echo
chk() { if grep -Eq "$1" "$2" 2>/dev/null; then echo "- ✅ $3"; else echo "- ⚠️ $4"; fi; }
chk 'line-tables-only' Cargo.toml "dev debuginfo reduced (line-tables-only)" "set \`[profile.dev] debug = \"line-tables-only\"\` (typically 10–30% faster builds)"
chk 'profile\.dev\.package\."\*"' Cargo.toml "dependency profile override present" "add \`[profile.dev.package.\"*\"] debug = false\`"
if awk '/^\[profile\.(release|dev)\]/{p=1;next} /^\[/{p=0} p&&/codegen-units *= *1([^0-9]|$)/{f=1} END{exit !f}' Cargo.toml; then
  echo "- ⚠️ codegen-units = 1 in [profile.release]/[profile.dev]: serial codegen. Move it to a separate \`dist\` profile"
else
  echo "- ✅ release/dev codegen stays parallel (no codegen-units = 1)"
fi
chk 'workspace\.dependencies' Cargo.toml "[workspace.dependencies] used" "centralize versions in [workspace.dependencies]"
chk 'workspace\.lints' Cargo.toml "[workspace.lints] used" "centralize lints in [workspace.lints]"
[ -f rust-toolchain.toml ] && echo "- ✅ rust-toolchain.toml present" || echo "- ⚠️ pin the toolchain (rust-toolchain.toml)"
[ -f PLATFORMS.md ] && echo "- ✅ PLATFORMS.md present" || echo "- ⚠️ no PLATFORMS.md: run the platform intake"
if grep -v '^[[:space:]]*#' .cargo/config.toml 2>/dev/null | grep -q -- '-Z'; then echo "- ⚠️ -Z flags in .cargo/config.toml (breaks stable; move to cargo-fast)"; fi
if [ "$(uname)" = Darwin ]; then
  echo "- ℹ️ macOS: make sure terminal + IDE are enabled under Privacy & Security > Developer Tools (\`sudo spctl developer-mode enable-terminal\`), otherwise XProtect slows every build script and test binary (can't be detected from the CLI)"
fi

if [ "$FULL" = 1 ]; then
  FREE_GB=$(df -Pk . | awk 'NR==2{print int($4/1048576)}')
  echo
  echo "## Timed builds (separate target dir \`target-audit\`)"
  echo
  if [ "$FREE_GB" -lt 15 ]; then
    echo "Skipped: only ${FREE_GB} GB free (need ≥ 15 GB)."
  else
    TD=target-audit; rm -rf "$TD"
    t0=$(python3 -c 'import time;print(time.time())')
    cargo build --workspace --timings --target-dir "$TD" -q 2>/dev/null
    t1=$(python3 -c 'import time;print(time.time())')
    echo "- Clean build: **$(python3 -c "print(round($t1-$t0,1))") s**"
    LEAF_SRC=$(python3 - "$META" <<'PY'
import json,sys,os
m=json.load(open(sys.argv[1])); pk={p["id"]:p for p in m["packages"]}
bins=[t["src_path"] for i in m["workspace_members"] for t in pk[i]["targets"] if "bin" in t["kind"]]
libs=[t["src_path"] for i in m["workspace_members"] for t in pk[i]["targets"] if "lib" in t["kind"]]
print((bins or libs)[0])
PY
)
    touch "$LEAF_SRC"
    t2=$(python3 -c 'import time;print(time.time())')
    cargo build --workspace --target-dir "$TD" -q 2>/dev/null
    t3=$(python3 -c 'import time;print(time.time())')
    echo "- Incremental rebuild after touching \`${LEAF_SRC#$PWD/}\`: **$(python3 -c "print(round($t3-$t2,2))") s**"
    echo
    python3 "$SKILL_DIR/scripts/timings_parallelism.py" "$TD/cargo-timings/cargo-timing.html" --top 8 | sed 's/^# /### /'
    [ "$KEEP" = 1 ] || rm -rf "$TD"
  fi
fi
} | tee "$OUT"
rm -f "$META"
echo
echo "(report written to $OUT)"
