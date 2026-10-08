@echo off
REM ---------------------------------------------------------------------------
REM Installs the already-compiled pgvector extension into PostgreSQL 18.
REM MUST be run as Administrator (writes into C:\Program Files).
REM
REM Right-click this file -> "Run as administrator", or from an admin terminal:
REM   scripts\install-pgvector.bat
REM ---------------------------------------------------------------------------
setlocal

set "PGROOT=C:\Program Files\PostgreSQL\18"
set "VCVARS=C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
set "LOGFILE=%~dp0..\.pgvector-install.log"

call :main > "%LOGFILE%" 2>&1
set "RC=%ERRORLEVEL%"
type "%LOGFILE%"
exit /b %RC%

:main
echo === pgvector install started %DATE% %TIME% ===

if not exist "%SRC%" set "SRC=%TEMP%\pgvector-build"
if not exist "%SRC%\Makefile.win" (
  echo ERROR: pgvector source not found at "%SRC%"
  echo Clone it first: git clone --depth 1 --branch v0.8.6 https://github.com/pgvector/pgvector.git "%SRC%"
  exit /b 1
)

if not exist "%PGROOT%\lib\postgres.lib" (
  echo ERROR: PostgreSQL dev files not found under "%PGROOT%"
  exit /b 1
)

call "%VCVARS%" >nul
if errorlevel 1 ( echo ERROR: MSVC env init failed & exit /b 1 )

cd /d "%SRC%" || exit /b 1

echo --- building ---
nmake /NOLOGO /F Makefile.win
if errorlevel 1 ( echo ERROR: build failed & exit /b 1 )

echo --- installing into %PGROOT% ---
nmake /NOLOGO /F Makefile.win install
if errorlevel 1 ( echo ERROR: install failed - are you running as Administrator? & exit /b 1 )

echo --- verifying ---
if not exist "%PGROOT%\share\extension\vector.control" (
  echo ERROR: vector.control missing after install
  exit /b 1
)
if not exist "%PGROOT%\lib\vector.dll" (
  echo ERROR: vector.dll missing after install
  exit /b 1
)

echo SUCCESS: pgvector installed
exit /b 0
