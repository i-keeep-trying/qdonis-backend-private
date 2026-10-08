# ---------------------------------------------------------------------------
# Second Nest CLI generation pass: DTOs, entities, repositories and the
# sessions service. Kept separate from generate-architecture.ps1 so the module
# skeleton and the classes inside it can be regenerated independently.
#
#   pwsh -File scripts/generate-classes.ps1
# ---------------------------------------------------------------------------
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$nest = Join-Path $root 'node_modules\.bin\nest.cmd'
if (-not (Test-Path $nest)) { throw "Nest CLI not found at $nest - run npm install first" }

$classes = @(
    'common/dto/pagination-query.dto',
    'common/dto/paginated-result.dto',
    'common/types/authenticated-request',
    'users/dto/create-user.dto',
    'users/dto/update-user.dto',
    'users/entities/user.entity',
    'users/users.repository',
    'auth/dto/register.dto',
    'auth/dto/login.dto',
    'auth/dto/auth-result.dto',
    'auth/dto/session.dto',
    'auth/auth.types',
    'documents/dto/create-document.dto',
    'documents/dto/search-documents.dto',
    'documents/entities/document.entity',
    'documents/documents.repository'
)

foreach ($class in $classes) {
    Write-Host "`n>>> nest g class $class"
    & $nest g class $class --flat --no-spec 2>&1 | ForEach-Object { "    $_" }
}

Write-Host "`n>>> nest g service auth/sessions --flat --no-spec"
& $nest g service auth/sessions --flat --no-spec 2>&1 | ForEach-Object { "    $_" }

Write-Host "`n=== class generation complete ==="
