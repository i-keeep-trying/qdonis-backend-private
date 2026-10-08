# ---------------------------------------------------------------------------
# Generates the application skeleton using the Nest CLI schematics so that the
# folder layout, file naming and module wiring all follow NestJS conventions
# rather than being hand-rolled.
#
# Idempotent-ish: the Nest CLI refuses to overwrite existing files, so re-runs
# simply report what already exists.
#
#   pwsh -File scripts/generate-architecture.ps1
# ---------------------------------------------------------------------------
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$nest = Join-Path $root 'node_modules\.bin\nest.cmd'
if (-not (Test-Path $nest)) { throw "Nest CLI not found at $nest - run npm install first" }

function Invoke-Nest {
    param([string[]] $NestArgs)
    Write-Host "`n>>> nest $($NestArgs -join ' ')"
    & $nest @NestArgs 2>&1 | ForEach-Object { "    $_" }
}

# --- feature modules -------------------------------------------------------
# Each `g module` also wires the new module into the closest parent module.
Invoke-Nest @('g', 'module', 'config', '--no-spec')

Invoke-Nest @('g', 'module', 'prisma', '--no-spec')
Invoke-Nest @('g', 'service', 'prisma', '--no-spec')

Invoke-Nest @('g', 'module', 'users', '--no-spec')
Invoke-Nest @('g', 'service', 'users', '--no-spec')
Invoke-Nest @('g', 'controller', 'users', '--no-spec')

Invoke-Nest @('g', 'module', 'auth', '--no-spec')
Invoke-Nest @('g', 'service', 'auth', '--no-spec')
Invoke-Nest @('g', 'controller', 'auth', '--no-spec')

Invoke-Nest @('g', 'module', 'documents', '--no-spec')
Invoke-Nest @('g', 'service', 'documents', '--no-spec')
Invoke-Nest @('g', 'controller', 'documents', '--no-spec')

Invoke-Nest @('g', 'module', 'health', '--no-spec')
Invoke-Nest @('g', 'controller', 'health', '--no-spec')

# --- auth building blocks --------------------------------------------------
Invoke-Nest @('g', 'class', 'auth/strategies/local.strategy', '--flat', '--no-spec')
Invoke-Nest @('g', 'class', 'auth/strategies/jwt.strategy', '--flat', '--no-spec')
Invoke-Nest @('g', 'class', 'auth/strategies/jwt-refresh.strategy', '--flat', '--no-spec')

Invoke-Nest @('g', 'guard', 'auth/guards/local-auth', '--flat', '--no-spec')
Invoke-Nest @('g', 'guard', 'auth/guards/jwt-auth', '--flat', '--no-spec')
Invoke-Nest @('g', 'guard', 'auth/guards/jwt-refresh-auth', '--flat', '--no-spec')
Invoke-Nest @('g', 'guard', 'auth/guards/roles', '--flat', '--no-spec')

# --- cross-cutting concerns ------------------------------------------------
Invoke-Nest @('g', 'filter', 'common/filters/all-exceptions', '--flat', '--no-spec')
Invoke-Nest @('g', 'interceptor', 'common/interceptors/response-transform', '--flat', '--no-spec')
Invoke-Nest @('g', 'decorator', 'common/decorators/current-user', '--flat')
Invoke-Nest @('g', 'decorator', 'common/decorators/roles', '--flat')
Invoke-Nest @('g', 'decorator', 'common/decorators/public', '--flat')

Write-Host "`n=== generation complete ==="
Get-ChildItem -Recurse -File -Path (Join-Path $root 'src') -Filter '*.ts' |
    Where-Object { $_.FullName -notmatch '\\generated\\' } |
    ForEach-Object { $_.FullName.Substring($root.Length + 1) } |
    Sort-Object
