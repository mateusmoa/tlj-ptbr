# The Longest Journey — Tradução PT-BR (ferramentas)

Instalador, extensão do Vortex e ferramentas da fã-tradução de **The Longest Journey** (2000, Funcom)
para português do Brasil. Página do mod: Nexus Mods (The Longest Journey).

**Nenhum arquivo do jogo é distribuído.** A tradução vai num arquivo `tlj_ptbr.tljpatch`, que só contém
os textos traduzidos, ajustes de layout e hashes (SHA-1/CRC32) dos arquivos originais. O instalador
aplica esse patch nos arquivos originais do próprio jogador.

## Conteúdo

| Pasta | O que é |
|---|---|
| `instalador-windows/` | `Instalador.cs`: código-fonte do `Instalar_Traducao_PTBR.exe` (console, .NET Framework 4). `compilar.bat` compila com o compilador que já vem no Windows. |
| `python/` | `tlj_ptbr_patcher.py`: o mesmo instalador em Python (Linux, Steam Deck, Mac). `gerar_patch.py`: gera o `.tljpatch` a partir de uma build traduzida completa. |
| `extensao-vortex/` | Extensão do Vortex para o jogo (Steam 6310 / GOG 1207658794): instala mods na pasta do jogo e aplica `.tljpatch`. |
| `docs/` | Especificação do formato `.tljpatch`. |

## O que o instalador faz

1. Procura o jogo: na própria pasta, nas bibliotecas da Steam (`libraryfolders.vdf` / `appmanifest_6310.acf`)
   e no registro da GOG; se não achar, pede o caminho.
2. Confere **todos** os arquivos antes de alterar qualquer um (hash do arquivo, estrutura da árvore .xrc e CRC
   das partes preservadas). Se algo não bater, não muda nada e orienta a verificar a integridade na Steam/GOG.
3. Copia cada arquivo que vai alterar para `_backup_traducao_ptbr` dentro da pasta do jogo e grava os traduzidos.
4. "Desinstalar" devolve os arquivos do backup.

Não acessa a internet, não baixa nem executa nada. Só pede permissão de administrador (reabrindo a si mesmo,
depois de perguntar) se não conseguir escrever na pasta do jogo.

## Como compilar

Windows (usa o `csc.exe` do .NET Framework 4, que já vem no Windows): rode `instalador-windows\compilar.bat`, ou

    %WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe /target:exe /optimize+ /codepage:65001 /out:Instalar_Traducao_PTBR.exe Instalador.cs

Linux (Mono), sempre contra as referências do .NET Framework para o .exe rodar no Windows:

    mcs -nostdlib -noconfig -r:/usr/lib/mono/4.0-api/mscorlib.dll -r:/usr/lib/mono/4.0-api/System.dll \
        -target:exe -optimize+ -codepage:utf8 -out:Instalar_Traducao_PTBR.exe Instalador.cs

O `Instalar_Traducao_PTBR.exe` 1.0.1 publicado foi compilado com o comando do Mono acima.
SHA-256: `ce259429ea5bca288d12e415e95eef160e71d9e3332b298f3f559f68bc3bb21e`
(compilar com o `csc.exe` gera um binário equivalente, mas não idêntico byte a byte).

## English summary

Fan translation tools for The Longest Journey (Brazilian Portuguese). The `.tljpatch` file only contains
translated text, layout tweaks and hashes of the original files; no game files are redistributed. The Windows
installer is a small open-source .NET Framework 4 console app: it verifies the player's original files, backs
them up, writes the translated files and can restore the backup. It has no network access and does not run any
other program. Build it with `instalador-windows/compilar.bat` (uses the C# compiler shipped with Windows).

## Licença

GPL-3.0 (arquivo `LICENSE`). The Longest Journey © Funcom; projeto de fã, sem afiliação com a Funcom.
