# PLATFORMS: source of truth for target OSes (read by agents before platform work)

> Owner decisions. Agents: read this file instead of re-asking. Update it (with date +
> reason) when the owner changes scope, then run the expansion playbook
> (weedo-rust-dev-skill → references/platforms.md §4).

## Decisions ({{DATE}})

| OS | Tier | Architectures | Target triples |
| :-- | :-- | :-- | :-- |
{{PLATFORM_ROWS}}

- **App kind:** {{KIND}}
- **Tiers:** Ship = built, tested, packaged, signed, released · Ready = compile-checked
  (`cargo check` + `clippy --target`) in CI on every PR, not released · Out = unsupported.

## Rules that keep Ready OSes cheap to promote

- All OS-specific code lives in `crates/platform`, behind traits from `crates/app`.
  No `#[cfg(target_os)]` elsewhere.
- OS-only dependencies go under `[target.'cfg(...)'.dependencies]`.
- Prefer cross-platform crates (GUI, paths, keychain, services, notifications).
- CI must keep every Ship and Ready target green.

## Build machines

| Machine | Cores / RAM | Linker | `-Zthreads` (nightly lane) | Notes |
| :-- | :-- | :-- | :-- | :-- |
| Dev laptop | | | 8 (default) | |
| Remote VM | | | measure with `zthreads_sweep.sh` | |

## Change log

- {{DATE}}: initial intake.
