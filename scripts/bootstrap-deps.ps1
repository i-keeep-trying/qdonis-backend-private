# ---------------------------------------------------------------------------
# Clean-installs all project dependencies.
# Useful on Windows where a partially-removed node_modules can leave npm in an
# ENOTEMPTY state that blocks any further install.
#
#   pwsh -File scripts/bootstrap-deps.ps1
# ---------------------------------------------------------------------------
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "=== workspace: $root ==="

# --- clean -----------------------------------------------------------------
foreach ($target in @('node_modules', 'package-lock.json')) {
    $path = Join-Path $root $target
    if (Test-Path $path) {
        Write-Host "removing $target ..."
        cmd /c "rmdir /s /q `"$path`"" 2>$null
        cmd /c "del /f /q `"$path`"" 2>$null
        if (Test-Path $path) {
            Write-Host "WARN: $target still present, retrying with robocopy mirror"
            $empty = Join-Path $env:TEMP '_empty_for_purge'
            New-Item -ItemType Directory -Force -Path $empty | Out-Null
            robocopy $empty $path /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
            cmd /c "rmdir /s /q `"$path`"" 2>$null
        }
    }
    Write-Host "$target removed: $(-not (Test-Path $path))"
}

# --- install ---------------------------------------------------------------
Write-Host "=== npm install ==="
& npm install --no-fund --no-audit --loglevel=warn
Write-Host "NPM_INSTALL_EXIT=$LASTEXITCODE"

Write-Host "=== done ==="
