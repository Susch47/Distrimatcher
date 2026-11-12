@echo off
echo Downloading the latest Distrimatcher test build ...
cd /d "%~dp0.."
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $u='https://github.com/Susch47/Distrimatcher/releases/download/test-build/Distrimatcher-Windows.zip'; $z=Join-Path $env:TEMP 'Distrimatcher-Windows.zip'; Invoke-WebRequest $u -OutFile $z; Get-Process Distrimatcher -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep 1; if (Test-Path 'Distrimatcher-Test\App') { Remove-Item 'Distrimatcher-Test\App' -Recurse -Force }; Expand-Archive $z -DestinationPath . -Force; Remove-Item $z; Write-Host 'Done - Distrimatcher is up to date.'"
pause
