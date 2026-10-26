@echo off
rem Compila o instalador com o compilador C# que ja vem no Windows (.NET Framework 4).
set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
"%CSC%" /nologo /target:exe /optimize+ /codepage:65001 /out:Instalar_Traducao_PTBR.exe Instalador.cs
pause
