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
| `python/` | `tlj_ptbr_patcher.py`: o mesmo instalador em Python (Linux, Steam Deck, Mac), com a opção `--scummvm`. `gerar_patch.py`: gera o `.tljpatch` a partir de uma build traduzida completa. |
| `extensao-vortex/` | Extensão do Vortex para o jogo (Steam 6310 / GOG 1207658794): instala mods na pasta do jogo, mods do ScummVM como o TLJ HD Mod e aplica `.tljpatch`. |
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

## ScummVM e TLJ HD Mod

O ScummVM reconhece o jogo pelo MD5 do `chapters.ini` da pasta do jogo (e do `x.xarc`, que a tradução não
altera): com o `chapters.ini` traduzido ele diz que não encontrou nenhum jogo. Depois de reconhecer, porém, ele
procura os arquivos primeiro nas pastas dentro de `mods/` e só depois na pasta do jogo.

**Pelo Vortex é automático.** A tradução instala o `chapters.ini` traduzido na pasta do jogo (para o game.exe) e
uma cópia em `mods/TLJ_PTBR/` (para o ScummVM). Cada mod instalado é marcado conforme onde funciona: só no
ScummVM (arquivos em `mods/`), só no game.exe (executáveis, DLLs, wrappers como o dgVoodoo) ou nos dois (traduções,
`.xarc`, vídeos, fontes). Mods instalados por outros instaladores são classificados pelos arquivos. Ao clicar em
Jogar, no modo "Automático":

- valem só os mods ATIVOS no Vortex (arquivos que sobram na pasta do jogo, de mods desativados ou extraídos à
  mão, não contam; a verificação roda depois do deploy que o Vortex faz antes de abrir o jogo);
- sem mods do ScummVM ativos: abre o game.exe, como sempre;
- com mods do ScummVM e só mods compatíveis: abre direto no ScummVM (e avisa quais mods causaram isso);
- com mods do ScummVM e mods que só funcionam no game.exe: pergunta qual combinação usar (ScummVM + compatíveis,
  só os do ScummVM, ou jogo original só com os que não precisam dele) e desativa os que ficarem de fora.

Para abrir no ScummVM, a extensão:

1. acha o ScummVM (registro do Windows, pastas padrão) ou, com a permissão do jogador, baixa o pacote oficial
   (`downloads.scummvm.org`, conferido pelo SHA-256 publicado no site) para `%APPDATA%\Vortex\thelongestjourney`;
2. se a tradução trocou o `chapters.ini`, monta uma "pasta-sombra" com o `chapters.ini` original e links para o
   resto do jogo (junções para as pastas, hardlinks para os arquivos da raiz; nada é copiado nem alterado no jogo);
3. cadastra o jogo no `scummvm.ini` (alvo `tlj-win`, o mesmo nome que o ScummVM usa, então os saves batem) e abre
   o jogo direto nele.

O botão "ScummVM" da aba Mods escolhe entre Automático, sempre ScummVM ou sempre game.exe.

Versões da extensão: a partir da 0.2.5 o `info.json` tem `"id": "game-thelongestjourney"`, então cada versão nova
instalada (pelo Nexus ou por "Install From File") substitui a anterior. Até a 0.2.4 não tinha `id` e cada zip com
nome diferente virava outra pasta em `plugins`; o Vortex carregava todas juntas. A 0.2.5 acha essas cópias antigas
e oferece removê-las (é preciso reiniciar o Vortex depois).

Sem o Vortex:
- Python: `python3 tlj_ptbr_patcher.py --scummvm` (`chapters.ini` original na pasta do jogo e o traduzido em
  `mods/TLJ_PTBR/`; `--desinstalar` também apaga essa pasta).
- `.exe`: mover o `chapters.ini` traduzido para `mods\TLJ_PTBR\` e copiar `_backup_traducao_ptbr\chapters.ini`
  de volta para a pasta do jogo; depois adicionar a pasta do jogo no ScummVM.

A extensão também instala, arrastando o arquivo baixado para o Vortex, os mods do ScummVM do ModDB: o
[TLJ HD Mod](https://www.moddb.com/downloads/tljhd) e os FMV Packs (`mods/TLJHD/...`, mais a pasta `Fonts`) e o
HDCharacters (`mods/HDCharacters/...`). O resultado é o mesmo de extrair na pasta do jogo como os autores mandam.
O Savegame Pack não vai na pasta do jogo (é para a pasta de saves do ScummVM); a extensão explica isso em vez de
instalar. Testado no ScummVM 2.8: jogo reconhecido pela pasta-sombra, textos e capítulos traduzidos e arquivos
de `mods/` carregados.

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
