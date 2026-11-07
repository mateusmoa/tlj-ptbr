# The Longest Journey — Vortex extension 0.3.3

## Português

Suporte ao The Longest Journey (Steam/GOG) no Vortex: instala mods na pasta do jogo e mods do ScummVM
(TLJ HD, FMV packs, HD Characters), aplica traduções `.tljpatch` e abre o jogo no ScummVM quando os mods
ativos precisam dele.

ScummVM: se não houver um no PC, a extensão oferece baixar o oficial e avisa onde ele ficou
(`%APPDATA%\Vortex\thelongestjourney\ScummVM`). O botão "ScummVM" da aba Mods mostra a pasta de saves do
ScummVM (com um botão para abri-la) e, se foi o Vortex que baixou o ScummVM, oferece removê-lo: apaga a cópia
baixada, a pasta auxiliar que ele usa para abrir o jogo traduzido (só atalhos para os arquivos do jogo) e o
jogo "The Longest Journey (Vortex)" da lista do ScummVM. Os saves não são apagados. Remover a extensão não
apaga o ScummVM: o Vortex não avisa a extensão quando ela é removida, por isso existe esse botão.

Saves do jogo original (game.exe) e do ScummVM têm formatos diferentes: um não abre no outro do jeito que está.
A extensão converte cópias dos saves do jogo original para o ScummVM ("Converter saves para o ScummVM"): no botão
"ScummVM" da aba Mods, no aviso da primeira vez em que o jogo abre no ScummVM (se houver saves do jogo original
em `%APPDATA%\The Longest Journey\Save` ou na pasta antiga `%APPDATA%\Funcom\TLJ ...\Save`) e ao instalar um
pacote de saves do jogo original. As cópias vão para a pasta de saves do ScummVM, em sequência, começando uma página
(9 slots) vazia depois do último save do jogador no ScummVM, com os mesmos nomes do jogo original. Os originais não mudam,
um save do próprio jogador no ScummVM nunca é sobrescrito, e converter de novo só regrava as cópias cujo original
mudou. Para converter, a extensão lê a estrutura de cada fase nos arquivos do próprio jogo (`saveconv.js`).
Quem preferir continuar no jogo original escolhe "Sempre abrir no jogo original (game.exe)".

Outras versões oficiais (ex.: o pacote polonês gerado da cópia polonesa do próprio jogador): quando um mod
troca o `chapters.ini` pelo de uma versão que o ScummVM conhece (o par `chapters.ini` + `x.xarc`), a extensão
abre o jogo direto da pasta dele, sem a pasta auxiliar, e tira o idioma fixo (`language=`) do jogo no
`scummvm.ini`: assim o ScummVM detecta o idioma sozinho e usa a página de código certa (cp1250 no polonês, para
ł ą ś ż). Desde a 0.3.2 o `.tljpatch` também troca, pelo nome, arquivos de dentro do `.xarc` (operação 6, usada
pelas falas curtas `.isn` embutidas), e os acrescenta quando a versão do jogo não os tem (a Steam usa `.ovs` soltos
no lugar). Uma dublagem em `.iss` instalada numa versão que usa `.ovs` (Steam/DVD) fica marcada como só do ScummVM,
que procura o `.iss` antes do `.ovs`; o game.exe dessas versões toca os `.ovs`.
Na Steam, com o pacote polonês o ScummVM reconhece "Polish 4CD" e tentaria ler do game.exe dela o fundo das
caixas de diálogo (bitmap 147), que não existe de verdade nesse executável (só a entrada "English Steam" do ScummVM
pula essa leitura). Desde a 0.3.3 a extensão detecta esse caso e abre o jogo por uma pasta auxiliar sem o
`game.exe`/`game.dll`: o ScummVM usa o fundo padrão e o executável instalado não muda.

Pacotes de saves baixados: o Vortex não instala saves na pasta do jogo (lá eles não servem). Ele explica onde
cada tipo vai: saves do ScummVM (`tlj-win-001.tlj`...) na pasta de saves do ScummVM; saves do jogo original
(`Save01.tlj` + `Save01.tga` + `Index.dat`) na pasta de saves do jogo original, com um botão para abrir a pasta
e outro para convertê-los para o ScummVM.

As mensagens da extensão estão em 15 idiomas: alemão, chinês simplificado, coreano, espanhol, francês,
holandês, húngaro, inglês, italiano, norueguês, polonês, português do Brasil, russo, sueco e tcheco.

O idioma acompanha a configuração do Vortex. Quando o Vortex está no padrão (inglês) ou sem idioma, vale o
idioma do sistema, se for um dos 15; fora deles, inglês. Códigos regionais (`pt-BR`, `de-DE`, `zh-CN`) são
aceitos; norueguês (`no`, `nb`, `nn`) usa o bokmål e qualquer variante do chinês usa o simplificado.
Depois de trocar o idioma, reinicie o Vortex para atualizar também o nome da ferramenta de configuração.

Instalação manual: no Vortex, Extensions > Install From File, escolha o ZIP e reinicie o Vortex.

## English

The Longest Journey (Steam/GOG) support for Vortex: installs game-folder mods and ScummVM mods (TLJ HD, FMV
packs, HD Characters), applies `.tljpatch` translations and starts the game in ScummVM when the enabled mods
need it.

ScummVM: if none is installed, the extension offers to download the official one and tells you where it went
(`%APPDATA%\Vortex\thelongestjourney\ScummVM`). The "ScummVM" button on the Mods page shows the ScummVM saved
games folder (with a button to open it) and, if Vortex downloaded ScummVM, offers to remove it: it deletes the
downloaded copy, the helper folder used to open the translated game (only links to the game files) and the
"The Longest Journey (Vortex)" entry from the ScummVM game list. Saved games are never deleted. Removing the
extension does not remove ScummVM, because Vortex does not notify an extension when it is removed; that is what
the button is for.

Saved games from the original game (game.exe) and from ScummVM use different formats: neither opens in the
other as it is. The extension converts copies of the original game's saves for ScummVM ("Convert saves to
ScummVM"): from the "ScummVM" button on the Mods page, from the notice shown the first time the game starts in
ScummVM (when there are saves from the original game in `%APPDATA%\The Longest Journey\Save` or the older
`%APPDATA%\Funcom\TLJ ...\Save`) and when installing a savegame pack from the original game. The copies go to
the ScummVM saves folder, one after the other, starting one empty page (9 slots) after the player's last
ScummVM save, with the same names as in the original game. The originals are not changed, a player's own ScummVM save is never
overwritten, and converting again only rewrites the copies whose original changed. To convert, the extension
reads the structure of each location from the game's own files (`saveconv.js`). To keep playing the originals
in the original game instead, choose "Always start the original game (game.exe)".

Other official language versions (e.g. the Polish pack built from the player's own Polish copy): when a mod
replaces `chapters.ini` with one from a version ScummVM recognizes (the `chapters.ini` + `x.xarc` pair), the
extension starts the game straight from its folder, without the helper folder, and removes a fixed language
(`language=`) from the game entry in `scummvm.ini`, so ScummVM detects the language itself and uses the right
code page (cp1250 for Polish: ł ą ś ż). Since 0.3.2 a `.tljpatch` can also replace files inside a `.xarc` by name
(operation 6, used for the short `.isn` voice lines stored inside them) and adds them when the game version lacks
them (Steam uses loose `.ovs` files instead). A `.iss` dubbing installed on a version that uses `.ovs` (Steam/DVD) is
marked ScummVM-only: ScummVM looks for the `.iss` before the `.ovs`, while that version's game.exe plays the `.ovs`.
On Steam, with the Polish pack ScummVM identifies "Polish 4CD" and would read the dialog background (bitmap 147)
from Steam's game.exe, which doesn't really contain it (only ScummVM's "English Steam" entry skips that read).
Since 0.3.3 the extension detects this and starts the game from a helper folder without `game.exe`/`game.dll`:
ScummVM uses its plain background and the installed executable is untouched.

Downloaded savegame packs: Vortex does not install saved games into the game folder, where they do not work.
It explains where each kind goes: ScummVM saves (`tlj-win-001.tlj`...) into the ScummVM saved games folder;
saves from the original game (`Save01.tlj` + `Save01.tga` + `Index.dat`) into the original game's saves
folder, with a button that opens it and another that converts them for ScummVM.

Extension messages are available in 15 languages: Brazilian Portuguese, Czech, Dutch, English, French,
German, Hungarian, Italian, Korean, Norwegian, Polish, Russian, Simplified Chinese, Spanish and Swedish.
The language follows the Vortex setting; with the English default it follows the system language when
supported, otherwise English. Corrections to the translations are welcome.

## Development

`locales/` holds one JSON catalog per language (98 messages each, `{{name}}` placeholders) and `i18n.js`
picks the language and fills the placeholders. `saveconv.js` converts saves from the original game to the
ScummVM format (version 12, read by ScummVM 2.x); it was validated against ScummVM saves made at the same
points of the game and by loading the converted saves in ScummVM. No runtime dependencies or network services.

Tests: `node --test` in this folder (Node.js 18+). `localization.test.js` uses a mock Vortex API and temporary files;
it does not start Vortex or the game. `saveconv.test.js` needs the game files and real saves, which are not
included: set `TLJ_GAME_DIR` (game folder, with `x.xarc`) and `TLJ_SAVES_DIR` (folder with `SaveNN.tlj`),
otherwise it is skipped. The published ZIP only needs `index.js`, `info.json`, `i18n.js`, `saveconv.js`,
`gameart.png` and `locales/`.

Author: mateusmoa. License: GPL-3.0.
