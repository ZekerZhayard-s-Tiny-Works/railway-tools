@echo off
setlocal
rem .bat files must stay ASCII-only: cmd parses them in the ANSI codepage.
if not defined JAVA_HOME (
  echo Error: JAVA_HOME is not set. Install JDK 17+ and set JAVA_HOME to its root.
  exit /b 1
)
if not exist "%JAVA_HOME%\bin\javac.exe" (
  echo Error: javac not found under JAVA_HOME: %JAVA_HOME%
  exit /b 1
)
if not exist temp\classes mkdir temp\classes
"%JAVA_HOME%\bin\javac.exe" -encoding UTF-8 -d temp\classes src\szmetro\*.java
if errorlevel 1 exit /b 1
echo Build OK -^> temp\classes
