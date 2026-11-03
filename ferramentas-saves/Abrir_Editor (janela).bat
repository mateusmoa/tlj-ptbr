@echo off
cd /d "%~dp0"
where pyw >nul 2>nul && (start "" pyw -3 "%~dp0Editor_de_Saves.pyw" & exit /b)
where pythonw >nul 2>nul && (start "" pythonw "%~dp0Editor_de_Saves.pyw" & exit /b)
echo Nao encontrei o Python 3. Instale em https://www.python.org/downloads/ marcando "Add python.exe to PATH".
pause
