#!/usr/bin/env python3
"""Analyze a `cargo build --timings` HTML report and estimate usable parallelism.

Usage:
    python3 timings_parallelism.py target/cargo-timings/cargo-timing.html [--cores N] [--top 10]

Reports:
  * wall time, total work (sum of unit durations), average parallelism
  * the dependency-bound critical path (lower bound on wall time with infinite cores)
  * max useful cores ~= work / critical_path  -> how big a machine is worth paying for
  * the units on the critical path, and the slowest units overall

Works with Python 3.8+ and no third-party packages.
"""
import argparse
import json
import os
import re
import sys


def load_units(path):
    with open(path, encoding="utf-8") as f:
        html = f.read()
    m = re.search(r"const\s+UNIT_DATA\s*=\s*(\[.*?\]);\s*\n", html, re.S)
    if not m:
        sys.exit("error: could not find UNIT_DATA in %s (cargo timing format changed?)" % path)
    units = json.loads(m.group(1))
    cpu = None
    m2 = re.search(r"const\s+CPU_USAGE\s*=\s*(\[.*?\]);\s*\n", html, re.S)
    if m2:
        try:
            cpu = json.loads(m2.group(1))
        except ValueError:
            cpu = None
    return units, cpu


def label(u):
    t = u.get("target") or ""
    mode = u.get("mode") or ""
    s = "%s v%s%s" % (u.get("name"), u.get("version"), t)
    if mode and mode != "todo":
        s += " (%s)" % mode
    return s


def rmeta_time(u):
    """Seconds after unit start when metadata (rmeta) was ready, if known."""
    if u.get("rmeta_time") is not None:          # older cargo
        return u["rmeta_time"]
    for name, span in u.get("sections") or []:   # newer cargo: frontend ends ~ at rmeta
        if name == "frontend" and isinstance(span, dict) and span.get("end") is not None:
            return span["end"]
    return None


def analyze(units):
    by_i = {u["i"]: u for u in units}
    # Who unblocked whom: Cargo records, for each unit, the units that became runnable
    # when it finished (full) or when its metadata was ready (rmeta). Field names differ
    # across cargo versions (unlocked_* / unblocked_*).
    unlocker = {}
    for u in units:
        for key in ("unlocked_units", "unblocked_units"):
            for v in u.get(key) or []:
                unlocker[v] = (u["i"], "full")
        for key in ("unlocked_rmeta_units", "unblocked_rmeta_units"):
            for v in u.get(key) or []:
                unlocker[v] = (u["i"], "rmeta")

    # Earliest possible finish with infinite cores, following the recorded unlock edges.
    memo = {}

    def earliest_finish(i, depth=0):
        if i in memo:
            return memo[i]
        if depth > 10000:
            return 0.0
        u = by_i[i]
        start = 0.0
        if i in unlocker:
            p, kind = unlocker[i]
            pu = by_i[p]
            pf = earliest_finish(p, depth + 1)
            if kind == "rmeta" and rmeta_time(pu) is not None:
                # dependent could start once the parent's metadata was ready
                start = pf - pu["duration"] + rmeta_time(pu)
            else:
                start = pf
        memo[i] = start + u["duration"]
        return memo[i]

    sys.setrecursionlimit(20000)
    finishes = {u["i"]: earliest_finish(u["i"]) for u in units}
    crit_end = max(finishes, key=finishes.get)
    crit_len = finishes[crit_end]

    chain = []
    cur = crit_end
    while cur is not None:
        chain.append(cur)
        cur = unlocker.get(cur, (None,))[0]
    chain.reverse()

    wall = max(u["start"] + u["duration"] for u in units)
    work = sum(u["duration"] for u in units)
    return wall, work, crit_len, chain, by_i


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("html")
    ap.add_argument("--cores", type=int, default=os.cpu_count() or 1)
    ap.add_argument("--top", type=int, default=10)
    args = ap.parse_args()

    units, cpu = load_units(args.html)
    if not units:
        sys.exit("no units in report (everything was fresh?). Run `cargo clean -p <crate>` or a clean build.")
    wall, work, crit, chain, by_i = analyze(units)

    avg_par = work / wall if wall else 0
    max_useful = work / crit if crit else 0
    util = avg_par / args.cores * 100 if args.cores else 0

    print("# Cargo build parallelism report\n")
    print("| Metric | Value |")
    print("| :-- | --: |")
    print("| Units compiled | %d |" % len(units))
    print("| Wall time | %.1f s |" % wall)
    print("| Total work (sum of unit time) | %.1f s |" % work)
    print("| Average parallelism | %.2f |" % avg_par)
    print("| Cores on this machine | %d |" % args.cores)
    print("| Average core utilization | %.0f %% |" % util)
    print("| Critical path (infinite-core lower bound) | %.1f s |" % crit)
    print("| **Max useful cores (work / critical path)** | **%.1f** |" % max_useful)
    if cpu:
        try:
            vals = [c[1] for c in cpu if isinstance(c, list) and len(c) > 1]
            if vals:
                print("| Mean sampled CPU usage | %.0f %% |" % (sum(vals) / len(vals)))
        except (TypeError, IndexError):
            pass

    print("\n## Critical path\n")
    print("| # | Unit | Duration (s) | rmeta at (s) |")
    print("| --: | :-- | --: | --: |")
    for n, i in enumerate(chain, 1):
        u = by_i[i]
        rm = rmeta_time(u)
        print("| %d | %s | %.2f | %s |" % (n, label(u), u["duration"], "%.2f" % rm if rm is not None else "-"))

    print("\n## Slowest units\n")
    print("| Unit | Duration (s) | Share of work |")
    print("| :-- | --: | --: |")
    for u in sorted(units, key=lambda u: -u["duration"])[: args.top]:
        print("| %s | %.2f | %.1f %% |" % (label(u), u["duration"], u["duration"] / work * 100))

    print("\n## Interpretation\n")
    if max_useful < args.cores * 0.5:
        print("- The build can use at most ~%.0f cores. **More cores won't help** until the critical path"
              " gets shorter: split or flatten the crates listed above, thin the binary crate, or (nightly lane)"
              " use `-Zthreads=8` so the big crates on the path compile in parallel internally." % max_useful)
    else:
        print("- The crate graph is wide enough to use ~%.0f cores. A bigger machine (more cores, enough RAM)"
              " will cut clean-build time roughly until it has that many cores." % max_useful)
    if util < 50:
        print("- Cores were idle for most of this build (utilization %.0f%%). The build is limited by its"
              " dependency chain, not by CPU count." % util)
    top = max(units, key=lambda u: u["duration"])
    if top["duration"] / work > 0.25:
        print("- `%s` is %.0f%% of all work, so it's the top candidate to split." % (label(top), top["duration"] / work * 100))


if __name__ == "__main__":
    main()
