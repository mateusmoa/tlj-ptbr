@echo off
setlocal
cd /d "%~dp0"
set "TLJ_COMPILER=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%TLJ_COMPILER%" (
  echo Compilador do .NET Framework 4 nao encontrado.
  exit /b 1
)
"%TLJ_COMPILER%" /nologo /target:exe /out:..\Instalador_TLJ.exe /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll Core.cs Pacotes.cs Program.cs
exit /b %errorlevel%
