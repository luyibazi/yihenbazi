@echo off
setlocal

REM ============================================================
REM  start-web.bat - Run the app in the BROWSER.
REM
REM  Double-click this. A browser window opens at
REM  http://localhost:8081 automatically. Close this window
REM  (or press Ctrl+C) to stop the server.
REM
REM  Node resolution below is IDENTICAL to start.bat. See that
REM  file for the full story (Expo 57 needs Node >= 20.19.4, and
REM  pinned patch versions break when the managed folder is
REM  upgraded, so we ask the pointer file, then scan).
REM
REM  WHY repair-modules RUNS HERE (2026-10-14 incident)
REM    Babel resolves the preset 'babel-preset-expo' from the
REM    PROJECT ROOT, but npm nests that package inside
REM    node_modules/expo/node_modules/. repair-modules.js creates
REM    a root-level junction for it.
REM    Any later `npm install` treats that junction as extraneous
REM    and DELETES it, and Metro then dies with:
REM        Failed to construct transformer:
REM        Error: Cannot find module 'babel-preset-expo'
REM    Running repair-modules.js here rebuilds the junction in
REM    about one second, so the server self-heals on every start.
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

REM --- 2) "current" pointer file ---
if not defined NODE22 if exist "%NODEBASE%\current" (
  for /f "usebackq delims=" %%v in ("%NODEBASE%\current") do (
    if not defined NODE22 if exist "%NODEBASE%\%%v\node.exe" set "NODE22=%NODEBASE%\%%v\node.exe"
  )
)

REM --- 3) auto-scan the versions dir ---
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
  echo         Fix: run  npm run setup:node   once, then retry.
  pause
  exit /b 1
)

cd /d "%~dp0"

echo ============================================
echo   paipan-app WEB dev server
echo   Node: %NODE22%
for /f "delims=" %%v in ('"%NODE22%" --version') do echo   Version: %%v
echo   URL : http://localhost:%PORT%
echo ============================================
echo.

echo [1/3] checking metro ...
"%NODE22%" tools\fix-metro.js
if errorlevel 1 goto fail
echo.

echo [2/3] checking module integrity ...
"%NODE22%" tools\repair-modules.js
if errorlevel 1 (
  REM repair-modules may hand off to tools\link-fix.bat when it
  REM cannot create the junction itself (sandbox blocks cmd.exe).
  if exist "tools\link-fix.bat" (
    echo   running tools\link-fix.bat ...
    call "tools\link-fix.bat"
  )
  "%NODE22%" tools\repair-modules.js --check
  if errorlevel 1 goto fail
)
echo.

echo [3/3] starting web server ...
echo   Keep this window OPEN while you use the app.
echo   Press Ctrl+C to stop. A browser tab opens by itself;
echo   if it does not, open http://localhost:%PORT% manually.
echo.
"%NODE22%" node_modules\expo\bin\cli start --web --port %PORT%
goto :eof

:fail
echo.
echo [FAILED] A check above did not pass. Please share the output.
pause
exit /b 1
