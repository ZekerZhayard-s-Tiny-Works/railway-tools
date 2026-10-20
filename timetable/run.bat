@echo off
chcp 65001 >nul
setlocal
rem .bat files must stay ASCII-only: cmd parses them in the ANSI codepage.
set "JAVA_HOME=C:\Program Files\Microsoft\jdk-21.0.12.101-hotspot"
if not defined JAVA_HOME (
  echo Error: JAVA_HOME is not set. Install JDK 17+ and set JAVA_HOME to its root.
  exit /b 1
)
if not exist "%JAVA_HOME%\bin\java.exe" (
  echo Error: java not found under JAVA_HOME: %JAVA_HOME%
  exit /b 1
)
if not exist temp\classes (
  echo Not built yet. Run build.bat first.
  exit /b 1
)
"%JAVA_HOME%\bin\java.exe" -cp temp\classes szmetro.Main %*
