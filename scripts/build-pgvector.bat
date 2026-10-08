@echo off
REM ---------------------------------------------------------------------------
REM Builds and installs the pgvector extension into a local Windows PostgreSQL
REM installation using the MSVC toolchain. Must be run from an elevated shell
REM because the install step writes into "C:\Program Files\PostgreSQL\<ver>".
REM
REM Usage: build-pgvector.bat <source-dir> <pg-root> <vcvars64-path> [install]
REM ---------------------------------------------------------------------------
setlocal

set "SRC=%~1"
set "PGROOT=%~2"
set "VCVARS=%~3"
set "DO_INSTALL=%~4"

if "%SRC%"=="" echo ERROR: source dir required & exit /b 1
if "%PGROOT%"=="" echo ERROR: pg root required & exit /b 1
if not exist "%VCVARS%" echo ERROR: vcvars64.bat not found at "%VCVARS%" & exit /b 1

call "%VCVARS%" >nul
if errorlevel 1 echo ERROR: failed to initialise MSVC environment & exit /b 1

cd /d "%SRC%" || exit /b 1

echo === Building pgvector against %PGROOT% ===
nmake /NOLOGO /F Makefile.win
if errorlevel 1 echo ERROR: build failed & exit /b 1

if /i "%DO_INSTALL%"=="install" (
  echo === Installing pgvector into %PGROOT% ===
  nmake /NOLOGO /F Makefile.win install
  if errorlevel 1 echo ERROR: install failed & exit /b 1
)

echo === pgvector done ===
endlocal
