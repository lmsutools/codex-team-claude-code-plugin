# cargo-fast.ps1: opt-in NIGHTLY fast lane for local dev builds (Windows).
#   * parallel frontend (-Zthreads=N)
#   * Cranelift codegen for the dev profile (Windows support is the least mature; falls back to LLVM)
#   * own target dir (target-fast\) so the stable cache is never invalidated
#
# Usage: .\scripts\cargo-fast.ps1 build|run|check [cargo args...]
# Env:   FAST_THREADS (default 8), FAST_NIGHTLY (default nightly), FAST_CRANELIFT=0 to disable.
# Cranelift has no unwinding on Windows (panics abort), so `test` always uses LLVM.
param(
  [Parameter(Position = 0)][string]$Sub = "build",
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest
)
$ErrorActionPreference = "Stop"

$os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
$ramGB = if ($os) { [math]::Round($os.TotalVisibleMemorySize / 1MB) } else { 16 }
$defThreads = if ($ramGB -le 8) { "2" } elseif ($ramGB -le 16) { "4" } else { "8" }
if (-not $env:CARGO_BUILD_JOBS) {
  if ($ramGB -le 8) { $env:CARGO_BUILD_JOBS = "2" }
  elseif ($ramGB -le 16) { $env:CARGO_BUILD_JOBS = [string][math]::Max(2, [math]::Floor($ramGB / 3)) }
}

$tc = if ($env:FAST_NIGHTLY) { $env:FAST_NIGHTLY } else { "nightly" }
$threads = if ($env:FAST_THREADS) { $env:FAST_THREADS } else { $defThreads }
$cranelift = if ($env:FAST_CRANELIFT) { $env:FAST_CRANELIFT } else { "1" }

& rustup run $tc rustc --version *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host "Installing $tc + Cranelift preview component..."
  & rustup toolchain install $tc --profile minimal -c rustc-codegen-cranelift-preview
}

$cargoArgs = @("+$tc", "--config", "build.rustflags=[`"-Zthreads=$threads`"]")
if ($Sub -in @("test", "nextest", "bench")) { $cranelift = "0" }
if ($cranelift -eq "1") {
  $installed = & rustup component list --toolchain $tc --installed 2>$null
  if ($installed -match "cranelift") {
    $cargoArgs += @("--config", "profile.dev.codegen-backend=`"cranelift`"", "-Zcodegen-backend")
  } else {
    Write-Warning "Cranelift component missing for $tc on this host; using LLVM."
  }
}
$cargoArgs += @($Sub, "--target-dir", "target-fast")
if ($Rest) { $cargoArgs += $Rest }
& cargo @cargoArgs
exit $LASTEXITCODE
