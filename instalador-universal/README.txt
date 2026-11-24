THE LONGEST JOURNEY — UNIVERSAL INSTALLER 2.0.0
For the English Steam and GOG releases, without Vortex.
(Português: veja LEIA-ME.txt)

WHAT IT INSTALLS
- Text: packages containing a .tljpatch, in any language of the builds (PT-BR,
  DE, ES, FR, NL, IT, NO, SV, PL, RU, CS, ZH, KO, HU, JA).
- Videos (FMV): packages with .bbb files.
- Steam audio (.ovs speech) or GOG audio (.iss speech). The installer checks
  which speech format your game uses and refuses the audio package that does
  not fit.
- Ready-made files (e.g. TLJ_PL_Tekst_Steam_Gotowe_Pliki.zip): .xarc, .ini and
  font files.
ZIPs are read directly: no need to extract anything. Extracted folders work too.
This ZIP contains no translation: download the packages separately.

HOW TO USE
1. Extract this ZIP to a folder of your choice (not necessarily the game folder).
2. Put the package ZIPs you want in the "dados" folder. Text, videos and audio
   can go together, but only one package of each type.
3. Close the game and run Instalador_TLJ.exe.
4. Check the game folder it shows and choose 1 (install all compatible
   packages) or 2 (choose which ones).

The installer looks for the game in Steam, GOG and its own folder. With more
than one installation it asks which one to use; if it finds none, paste the
path of the folder that contains game.exe.

SWITCHING LANGUAGE OR UPDATING
Put the new package in "dados" (remove the old one of the same type) and
install again. Text is always applied to the original English files kept in
the backup; files that only the previous package changed go back to the
original. The same goes for videos and audio. Steam and GOG audio never mix,
and a text package and ready-made files that touch the same files replace each
other.

UNINSTALLING
Run the installer and choose Uninstall: everything, or one type only. The
packages do not need to be in "dados" for this. The originals are kept in
_backup_traducao_tlj inside the game folder: do not delete it while anything
is installed. Backups from the earlier PT-BR installers (_backup_traducao_ptbr)
are reused automatically.

SCUMMVM
Russian, Czech, Chinese, Korean and Japanese texts display correctly in the
original game (game.exe) but come out garbled in ScummVM 2026.4, which cannot
read those character sets for this game version yet. The installer tells you
when this applies. The other languages work in both.

VORTEX
Do not mix with Vortex. If Vortex manages mods for this game (.vortex_backup
files in the folder), the installer stops: disable the mods and Purge first.

Requirements: Windows with .NET Framework 4.5 or newer (built into Windows 10
and 11). The program never goes online. Run "Instalador_TLJ.exe --help" for the
command-line options (--jogo, --dados, --pacote, --instalar, --verificar,
--desinstalar, --sim, --idioma pt|en).
