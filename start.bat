@echo off
setlocal

REM ============================================================
REM  start.bat - Launch Expo dev server with the correct Node,
REM              then show a SCANNABLE QR code in the browser.
REM
REM  WHY THIS FILE EXISTS
REM    1) This machine has more than one Node install. The one that
REM       comes first on PATH is E:\nodejs\node (v18.19.0), but
REM       Expo SDK 57 requires Node >= 20.19.4.
REM       v18 lacks Array.prototype.toReversed, so Metro crashes while
REM       loading its config:
REM           TypeError: configs.toReversed is not a function
REM
REM    2) The QR code printed in the terminal is made of block
REM       characters (U+2580/2584/2588) and spaces. Terminal fonts are
REM       NOT square, so the code gets stretched and phones can't scan
REM       it. So we open a real bitmap QR in the browser instead.
REM
REM  NOTE: keep this file ASCII-only. Chinese text in a .bat gets
REM        mangled under the default GBK console codepage, which also
REM        breaks parsing of "if (" blocks.
REM
REM  NODE RESOLUTION ORDER (first hit wins)
REM    1) .node-path in this folder  (written by: npm run setup:node)
REM    2) the "current" pointer file under the managed versions dir
REM    3) auto-scan the managed versions dir (last dir NAME = newest,
REM       since for /d yields names in ascending order)
REM    4) the hardcoded v22 path below (last-resort fallback)
REM
REM  WHY (2) AND (3) EXIST -- 2026-10-09 incident
REM    The managed Node folder is VERSIONED, e.g.
REM        ...\versions\22.22.2-3\node.exe
REM    and a patch upgrade swaps that number for a new one (that day -3
REM    was deleted and -6 appeared). BOTH .node-path and the hardcoded
REM    path below still said -3, so both missed and the launcher died
REM    printing "No suitable Node >= 20.19.4 found".
REM    => Never trust a pinned patch version. Ask the pointer, then scan.
REM
REM  NOTE: "current" in that folder is a FILE containing the version
REM        name (not a directory), so for /d does NOT see it -- hence
REM        step (2) reads it explicitly.
REM ============================================================

set "NODE22="
set "NODECFG=%~dp0.node-path"
set "NODEBASE=%USERPROFILE%\.workbuddy\binaries\node\versions"

REM --- 1) explicit config file ---
if exist "%NODECFG%" (
  for /f "usebackq delims=" %%p in ("%NODECFG%") do (
    if not defined NODE22 if exist "%%p" set "NODE22=%%p"
  )
)

REM --- 2) "current" pointer file: a text file holding the version name ---
if not defined NODE22 if exist "%NODEBASE%\current" (
  for /f "usebackq delims=" %%v in ("%NODEBASE%\current") do (
    if not defined NODE22 if exist "%NODEBASE%\%%v\node.exe" set "NODE22=%NODEBASE%\%%v\node.exe"
  )
)

REM --- 3) auto-scan the versions dir ---
REM     for /d yields names sorted ascending => the last assignment wins
REM     and is the highest version NAME. Good enough as a fallback.
if not defined NODE22 (
  for /d %%d in ("%NODEBASE%\*") do (
    if exist "%%d\node.exe" set "NODE22=%%d\node.exe"
  )
)

REM --- 4) last-resort hardcoded fallback ---
if not defined NODE22 if exist "C:\Users\luerse\.workbuddy\binaries\node\versions\22.22.2-6\node.exe" set "NODE22=C:\Users\luerse\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"

set "PORT=8081"

if not defined NODE22 (
  echo [ERROR] No suitable Node ^>= 20.19.4 found.
  echo         Tried, in order:
  echo           1. .node-path
  echo           2. %NODEBASE%\current
  echo           3. an auto-scan of %NODEBASE%
  echo           4. the pinned v22 fallback
  echo         Fix:   run  npm run setup:node   once,
  echo                or install a Node ^>= 20.19.4 and re-run it.
  pause
  exit /b 1
)

cd /d "%~dp0"

echo ============================================
echo   paipan-app dev server
echo   Node: %NODE22%
for /f "delims=" %%v in ('"%NODE22%" --version') do echo   Version: %%v
echo ============================================
echo.

echo [1/5] checking metro ...
"%NODE22%" tools\fix-metro.js
if errorlevel 1 goto fail
echo.

echo [2/5] checking module integrity ...
"%NODE22%" tools\repair-modules.js
if errorlevel 1 (
  REM repair-modules may have written tools\link-fix.bat when it cannot
  REM create a junction itself (sandboxes block cmd.exe / symlink with EBUSY).
  if exist "tools\link-fix.bat" (
    echo   running tools\link-fix.bat ...
    call "tools\link-fix.bat"
  )
  "%NODE22%" tools\repair-modules.js --check
  if errorlevel 1 goto fail
)
echo.

echo [3/5] preparing a scannable QR page ...
"%NODE22%" tools\qr.js %PORT%
echo.

echo [4/5] starting Metro ...
echo   Keep this window OPEN while you test on the phone.
echo   Press Ctrl+C to stop.
echo.
"%NODE22%" node_modules\expo\bin\cli start --port %PORT%
goto :eof

:fail
echo.
echo [FAILED] A check above did not pass. Please share the output.
pause
exit /b 1
