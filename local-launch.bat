@echo off
setlocal

cd /d "%~dp0"
set "APP_HOST=127.0.0.1"
set "APP_PORT=5173"
set "APP_URL=http://%APP_HOST%:%APP_PORT%"

echo Auto Subtitle local launcher
echo Working directory: "%CD%"
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required but was not found in PATH.
  echo Install the current LTS release from https://nodejs.org/ and run this launcher again.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm is required but was not found in PATH.
  echo Reinstall Node.js with npm enabled, then run this launcher again.
  pause
  exit /b 1
)

if not exist "package.json" (
  echo package.json was not found. Run this launcher from the Auto Subtitle repository root.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Installing local dependencies...
  if exist "package-lock.json" (
    call npm.cmd ci
    if errorlevel 1 (
      echo npm ci failed. Trying npm install instead...
      call npm.cmd install
    )
  ) else (
    call npm.cmd install
  )

  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$client = New-Object Net.Sockets.TcpClient; try { $client.Connect('%APP_HOST%', %APP_PORT%); $client.Close(); exit 0 } catch { exit 1 }"
if "%ERRORLEVEL%"=="0" (
  echo A local server already appears to be running at %APP_URL%.
  if /i not "%AUTO_SUBTITLE_NO_BROWSER%"=="1" start "" "%APP_URL%"
  exit /b 0
)

if not exist "scripts\local-launch.ps1" (
  echo scripts\local-launch.ps1 was not found. The launcher is incomplete.
  pause
  exit /b 1
)

if /i not "%AUTO_SUBTITLE_NO_BROWSER%"=="1" (
  echo Opening %APP_URL%
  start "" "%APP_URL%"
) else (
  echo Browser launch skipped because AUTO_SUBTITLE_NO_BROWSER=1.
)

echo Starting Vite. Press ENTER in this window to stop Auto Subtitle.
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\local-launch.ps1" -HostAddress "%APP_HOST%" -Port %APP_PORT% -Url "%APP_URL%"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo The development server stopped with exit code %EXIT_CODE%.
  pause
)

exit /b %EXIT_CODE%
