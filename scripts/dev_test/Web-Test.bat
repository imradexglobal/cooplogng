@echo off
setlocal EnableDelayedExpansion
title Web Test - CoopLog
echo ==========================================
echo  CoopLog - Web TEST (clean rebuild + dev^)
echo ==========================================
echo.

:: Project root = two levels up from scripts\dev_test
cd /d "%~dp0..\.."
if not exist "package.json" (
    echo [ERROR] Could not find project root.
    echo Window stays open so you can copy. Press Enter when done...
set /p DONE=Press Enter to close...
    exit /b 1
)

echo [1/4] Checking Node.js...
:: Refresh PATH for standard per-machine Node.js installs. This also fixes
:: batch files launched from an older terminal opened before Node was installed.
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LocalAppData%\Programs\node\node.exe" set "NODE_EXE=%LocalAppData%\Programs\node\node.exe"
if defined NODE_EXE set "PATH=%~dp0;%ProgramFiles%\nodejs;%LocalAppData%\Programs\node;%PATH%"
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found. Install from https://nodejs.org/
    echo Window stays open so you can copy. Press Enter when done...
set /p DONE=Press Enter to close...
    exit /b 1
)

echo [2/4] Checking dependencies...
if not exist "node_modules\.bin\vite.cmd" goto install_dependencies
if not exist "node_modules\vite\bin\vite.js" goto install_dependencies
goto dependencies_ready

:install_dependencies
    echo [INFO] Installing dependencies...
    call npm ci
    if errorlevel 1 (
        echo [ERROR] npm ci failed. Check the npm error above and retry.
        echo Window stays open so you can copy. Press Enter when done...
set /p DONE=Press Enter to close...
        exit /b 1
    )
    if not exist "node_modules\vite\bin\vite.js" (
        echo [ERROR] Vite installation is incomplete after npm ci.
        echo Window stays open so you can copy. Press Enter when done...
set /p DONE=Press Enter to close...
        exit /b 1
    )

:dependencies_ready

echo [3/4] Cleaning stale output (full rebuild, no leftovers)...
if exist "dist" rmdir /s /q "dist"
if exist "dist" (
    echo [ERROR] Could not delete dist\ - close anything locking it, then retry.
    echo Window stays open so you can copy. Press Enter when done...
set /p DONE=Press Enter to close...
    exit /b 1
)
echo [OK] dist\ cleared.

echo [4/4] Stamping build time + rebuilding web app from current source...
echo ------------------------------------------
call node scripts/stamp-build.mjs
if errorlevel 1 (
    echo [ERROR] Build stamp failed.
    echo Window stays open so you can copy. Press Enter when done...
set /p DONE=Press Enter to close...
    exit /b 1
)
call npm run build
if errorlevel 1 (
    echo [ERROR] Web build failed. Fix errors and re-run.
    echo Window stays open so you can copy. Press Enter when done...
set /p DONE=Press Enter to close...
    exit /b 1
)
if not exist "dist\index.html" (
    echo [ERROR] Build produced no dist\index.html.
    echo Window stays open so you can copy. Press Enter when done...
set /p DONE=Press Enter to close...
    exit /b 1
)
echo [OK] dist/ freshly rebuilt - no stale code.
echo.
echo Starting dev server at http://localhost:3000 ...
echo Press Ctrl+C to stop.
start /b cmd /c "timeout /t 6 /nobreak >nul & start http://localhost:3000"
call npm run dev
echo Window stays open so you can copy. Press Enter when done...
set /p DONE=Press Enter to close...
