# check_env.ps1: report the Rust build environment and Windows speed traps.
# Read-only: never changes system settings; prints suggested fixes instead.
$ErrorActionPreference = "SilentlyContinue"
function Ok($m)   { Write-Host "  [ok]   $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [warn] $m" -ForegroundColor Yellow }
function Info($m) { Write-Host "  [info] $m" }

Write-Host "== Machine"
$os = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$cores = [Environment]::ProcessorCount
$ramGB = [math]::Round($os.TotalVisibleMemorySize / 1MB)
Info "$($os.Caption) $($os.Version), $($cpu.Name)"
Info "logical cores: $cores, RAM: $ramGB GB"
if ($ramGB -le 8) {
  Warn "Low-memory host ($ramGB GB RAM): cap CARGO_BUILD_JOBS=2 (or 3), set rust-analyzer.numThreads=2, use debug=false in [profile.dev], and run at most 1-2 parallel codex_batch worktrees (see build-performance.md §12)"
} elseif ($ramGB -le 16 -or ($ramGB / [math]::Max($cores,1)) -lt 2) {
  Warn "Memory-constrained ratio ($ramGB GB RAM / $cores cores): consider build.jobs = $([math]::Floor($ramGB/2)) in .cargo\config.toml and cap parallel codex_batch worktrees to 2-3 (see build-performance.md §12)"
}

$drive = (Get-Item .).PSDrive
$freeGB = [math]::Round($drive.Free / 1GB)
if ($freeGB -lt 20) { Warn "free disk on $($drive.Name): $freeGB GB. Large workspaces need 5-20 GB per target dir." } else { Ok "free disk on $($drive.Name): $freeGB GB" }

Write-Host "== Toolchain"
if (Get-Command rustup) {
  Ok (rustup --version 2>$null | Select-Object -First 1)
  Info ("active: " + (rustup show active-toolchain 2>$null | Select-Object -First 1))
  $host_triple = (rustc -vV | Select-String "host:").ToString().Split(" ")[1]
  if ($host_triple -like "*-gnu") { Warn "host toolchain is GNU ($host_triple): prefer MSVC (rustup default stable-x86_64-pc-windows-msvc)" } else { Ok "host: $host_triple" }
  if (rustup toolchain list | Select-String nightly) { Info "nightly installed (fast lane: scripts\cargo-fast.ps1)" } else { Info "no nightly toolchain (fast lane unavailable; that's fine)" }
} else { Warn "rustup not found: install from https://rustup.rs" }
foreach ($t in "cargo-nextest","cargo-deny","cargo-shear","sccache") {
  if (Get-Command $t) { Ok $t } else { Info "$t not installed (cargo binstall $t)" }
}

Write-Host "== Windows speed traps"
# Dev Drive check (Windows 11 23H2+): fsutil devdrv query <drive>:
$dd = fsutil devdrv query "$($drive.Name):" 2>$null
if ($dd -match "trusted") { Ok "$($drive.Name): is a trusted Dev Drive (Defender performance mode)" }
elseif ($dd -match "Dev Drive") { Warn "$($drive.Name): is a Dev Drive but not trusted: fsutil devdrv trust $($drive.Name):" }
else { Warn "$($drive.Name): is not a Dev Drive. Create one (Settings > System > Storage > Disks & volumes > Create Dev Drive) and put the repo, CARGO_HOME, RUSTUP_HOME there." }
if ($env:CARGO_HOME) { Info "CARGO_HOME=$env:CARGO_HOME" } else { Info "CARGO_HOME not set (defaults to $env:USERPROFILE\.cargo; consider moving to the Dev Drive)" }
$lp = Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name LongPathsEnabled
if ($lp.LongPathsEnabled -eq 1) { Ok "long paths enabled" } else { Warn "long paths disabled (enable LongPathsEnabled + git config --system core.longpaths true)" }
if ((Get-Location).Path -match "OneDrive|Dropbox") { Warn "project is inside a synced folder: move it out" }

Write-Host "== Project (if run from a workspace root)"
if (Test-Path Cargo.toml) {
  if (Select-String -Path Cargo.toml -Pattern "line-tables-only" -Quiet) { Ok "dev debug = line-tables-only" } else { Warn "set [profile.dev] debug = `"line-tables-only`"" }
  if (Test-Path .cargo\config.toml) {
    if (Select-String -Path .cargo\config.toml -Pattern "rust-lld" -Quiet) { Ok "rust-lld configured for MSVC" } else { Warn "add [target.x86_64-pc-windows-msvc] linker = `"rust-lld.exe`" to .cargo\config.toml" }
  }
  if (Test-Path PLATFORMS.md) { Ok "PLATFORMS.md present" } else { Warn "no PLATFORMS.md: run the platform intake (ask the owner)" }
  if ($env:RUSTFLAGS) { Warn "RUSTFLAGS is set (`"$env:RUSTFLAGS`"): it invalidates caches across tools" }
}
