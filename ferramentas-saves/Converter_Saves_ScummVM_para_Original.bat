@echo off
setlocal
chcp 65001 >nul
set PYTHONIOENCODING=utf-8
cd /d "%~dp0"
set "PY="
py -3 -c "import sys" >nul 2>nul && set "PY=py -3"
if not defined PY python -c "import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)" >nul 2>nul && set "PY=python"
if not defined PY (
  echo Nao encontrei o Python 3 neste computador.
  echo Instale em https://www.python.org/downloads/ marcando "Add python.exe to PATH"
  echo e rode este arquivo de novo.
  echo.
  pause
  exit /b 1
)
%PY% "%~dp0converter_saves_tlj.py" --para original %*
echo.
pause
