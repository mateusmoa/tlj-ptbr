#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Gera a build "copia e cola" da tradução PT-BR de The Longest Journey: uma pasta com todos
os arquivos traduzidos (.xarc, chapters.ini, language.ini), nas mesmas pastas do jogo,
prontos para copiar por cima da pasta do jogo.

Os arquivos são montados a partir do SEU jogo (Steam/GOG) com o tlj_ptbr.tljpatch, e cada
um é conferido byte a byte com o patch. A pasta do jogo não é alterada.

Coloque este arquivo na pasta da tradução (junto do tlj_ptbr.tljpatch) e rode:
  Windows:   dois cliques em Gerar_Build_Copia_e_Cola.bat
             (ou arraste a pasta do jogo em cima do .bat)
  Linux/Mac: python3 gerar_build_copia_e_cola.py

Opções:
  --jogo PASTA     pasta do jogo (onde fica o game.exe); sem isso, procura a da Steam/GOG
  --saida PASTA    onde criar a build (padrão: TLJ_PTBR_v<versão>_copia_e_cola, ao lado
                   deste script)
  --patch ARQUIVO  o tlj_ptbr.tljpatch (padrão: ao lado deste script)
  --scummvm        versão para o ScummVM / TLJ HD Mod: sem o chapters.ini da raiz (o ScummVM
                   precisa do original) e com o traduzido em mods/TLJ_PTBR
  --zip            também cria um .zip da pasta
"""
import argparse
import importlib.util
import os
import re
import shutil
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
MARK = "LEIA-ME_COPIA_E_COLA.txt"
BASE = {"original": ("arquivo original do jogo", "arquivos originais do jogo"),
        "atualizado": ("arquivo de uma versão anterior da tradução", "arquivos de uma versão anterior da tradução"),
        "ja_instalado": ("arquivo já traduzido nesta versão", "arquivos já traduzidos nesta versão"),
        "do patch": (".ini que vem pronto no patch", ".ini que vêm prontos no patch")}
SCUMMVM_CHAPTERS = "mods/TLJ_PTBR/chapters.ini"


def say(msg=""):
    print(msg, flush=True)


def load_patcher():
    """Usa o mesmo código do instalador (tlj_ptbr_patcher.py, que vem no pacote da tradução)."""
    for c in (os.path.join(HERE, "tlj_ptbr_patcher.py"),
              os.path.join(HERE, "Linux_SteamDeck_Mac", "tlj_ptbr_patcher.py"),
              os.path.join(os.path.dirname(HERE), "Linux_SteamDeck_Mac", "tlj_ptbr_patcher.py")):
        if os.path.isfile(c):
            spec = importlib.util.spec_from_file_location("tlj_ptbr_patcher", c)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            return mod
    return None


def inside(a, b):
    """a está dentro de b (ou é b)?"""
    a = os.path.normcase(os.path.abspath(a))
    b = os.path.normcase(os.path.abspath(b))
    return a == b or a.startswith(b.rstrip(os.sep) + os.sep)


def default_base(game):
    if not inside(HERE, game):
        return HERE
    for d in ("~/Desktop", "~/Área de Trabalho", "~/OneDrive/Desktop", "~/OneDrive/Área de Trabalho", "~"):
        d = os.path.expanduser(d)
        if os.path.isdir(d):
            return d
    return os.path.dirname(os.path.abspath(game))


def sources(P, game, rel):
    """Onde procurar a base de cada arquivo: o próprio jogo, o original guardado pelo Vortex
    e o backup do instalador da tradução (para quem já tem a tradução instalada)."""
    p = P.resolve_ci(game, rel)
    for c in (p, p + ".vortex_backup", P.resolve_ci(os.path.join(game, P.BACKUP_DIR), rel)):
        if os.path.isfile(c):
            yield c


def make_file(P, game, e):
    """Devolve (bytes, situação) ou (None, motivos)."""
    if e.kind == P.KIND_FILE:
        return e.content, "do patch"
    why = []
    for src in sources(P, game, e.path):
        with open(src, "rb") as f:
            buf = f.read()
        try:
            out, st, _ = P.apply_entry(buf, e)
        except P.PatchError as ex:
            why.append("%s: %s" % (os.path.basename(src), ex))
            continue
        if P.sha1(out) == e.sha_out and len(out) == e.size_out:
            return out, st
        why.append("%s: versão desconhecida" % os.path.basename(src))
    if not why:
        why.append("arquivo não encontrado no jogo")
    return None, why


def real_rel(P, game, rel):
    """Caminho relativo com as maiúsculas/minúsculas que o arquivo tem no seu jogo."""
    p = P.resolve_ci(game, rel)
    if os.path.exists(p):
        return os.path.relpath(p, game)
    return rel.replace("/", os.sep)


LEIAME = """THE LONGEST JOURNEY - TRADUÇÃO PT-BR - build "copia e cola" (versão {versao}){modo}
===========================================================================

Esta pasta foi gerada no seu computador a partir dos arquivos do SEU jogo.
Ela tem todos os arquivos traduzidos ({n} arquivos), nas mesmas pastas do jogo.

COMO USAR
1. Feche o jogo.
2. Copie tudo o que está nesta pasta (menos este LEIA-ME) para a pasta do jogo,
   onde fica o game.exe, e confirme "Substituir".
Pronto.
{scummvm}
Se a tradução está instalada pelo Vortex, não copie por cima: desative o mod no
Vortex antes (ou continue usando só o Vortex).

PARA VOLTAR AO INGLÊS
Steam: botão direito no jogo > Propriedades > Arquivos instalados > Verificar
integridade. GOG Galaxy: Gerenciar instalação > Verificar/Reparar.

IMPORTANTE
Estes arquivos são do jogo (da Funcom) com os textos traduzidos. Use no seu
computador; não publique esta pasta. Para distribuir a tradução, use o pacote
oficial (tlj_ptbr.tljpatch + instalador), que não traz arquivos do jogo.
"""
TXT_NORMAL = """
ScummVM / TLJ HD Mod: o ScummVM só reconhece o jogo com o chapters.ini ORIGINAL
na pasta do jogo. Para jogar nele, não copie o chapters.ini que está na raiz
desta pasta (ou gere a build com --scummvm). O chapters.ini de mods/TLJ_PTBR
deixa os nomes dos capítulos em português no ScummVM.
"""
TXT_SCUMMVM = """
Esta é a versão para o ScummVM / TLJ HD Mod: ela não traz o chapters.ini da
raiz, porque o ScummVM só reconhece o jogo com o original. O traduzido fica em
mods/TLJ_PTBR, e de lá o ScummVM mostra os nomes dos capítulos em português.
Para jogar pelo game.exe, gere a build sem --scummvm.
"""


def main():
    ap = argparse.ArgumentParser(description='Gera a build "copia e cola" da tradução PT-BR de The Longest Journey')
    ap.add_argument("pasta", nargs="?", help="pasta do jogo (o mesmo que --jogo)")
    ap.add_argument("--jogo", help="pasta do jogo (onde fica o game.exe)")
    ap.add_argument("--saida", help="pasta onde criar a build")
    ap.add_argument("--patch", help="arquivo tlj_ptbr.tljpatch (padrão: ao lado deste script)")
    ap.add_argument("--scummvm", action="store_true", help="versão para o ScummVM (sem o chapters.ini da raiz)")
    ap.add_argument("--zip", action="store_true", help="também cria um .zip da pasta")
    a = ap.parse_args()

    P = load_patcher()
    if P is None:
        say("Não achei o tlj_ptbr_patcher.py. Coloque este script na pasta da tradução")
        say("(a que tem o tlj_ptbr.tljpatch e a pasta Linux_SteamDeck_Mac).")
        return 1
    patch = a.patch or P.find_patch()
    if not patch or not os.path.isfile(patch):
        say("Não achei o %s. Coloque este script ao lado dele ou use --patch." % P.PATCH_NAME)
        return 1
    game = a.jogo or a.pasta or P.find_game()
    if not game:
        try:
            game = input("Não achei o jogo. Digite (ou arraste) a pasta do jogo e aperte Enter:\n> ")
        except EOFError:
            game = ""
        game = game.strip().strip('"').strip("'")
    if not P.is_game_dir(game):
        say("Essa pasta não parece ser a do The Longest Journey (precisa ter game.exe e x.xarc):")
        say("  %s" % game)
        return 1
    game = os.path.abspath(game)

    try:
        version, title, entries = P.read_patch(patch)
    except P.PatchError as ex:
        say("Erro no patch: %s" % ex)
        return 1
    nome = "TLJ_PTBR_v%s_copia_e_cola%s" % (re.sub(r"[^\w.-]", "_", version), "_scummvm" if a.scummvm else "")
    saida = os.path.abspath(a.saida or os.path.join(default_base(game), nome))
    if inside(saida, game) or inside(game, saida):
        say("A pasta de saída não pode ficar dentro da pasta do jogo (nem o contrário).")
        say("Escolha outra com --saida.")
        return 1
    if os.path.isdir(saida) and os.listdir(saida) and not os.path.isfile(os.path.join(saida, MARK)):
        say("A pasta %s já existe e não foi criada por este script." % saida)
        say("Escolha outra com --saida (ou apague essa).")
        return 1

    say("%s  (versão %s)" % (title, version))
    say("Pasta do jogo: %s" % game)
    say("Gerando a build%s em: %s" % (" para o ScummVM" if a.scummvm else "", saida))
    tmp = saida + ".gerando"
    if os.path.isdir(tmp):
        shutil.rmtree(tmp)
    os.makedirs(tmp)

    chapters = None
    bad, counts, written = [], {}, []
    for i, e in enumerate(entries):
        data, st = make_file(P, game, e)
        if data is None:
            bad.append("%s (%s)" % (e.path, "; ".join(st)))
            continue
        counts[st] = counts.get(st, 0) + 1
        if e.kind == P.KIND_FILE and e.path.lower() == "chapters.ini":
            chapters = data
            if a.scummvm:
                continue
        rel = real_rel(P, game, e.path)
        dst = os.path.join(tmp, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, "wb") as f:
            f.write(data)
        written.append((dst, e))
        if (i + 1) % 25 == 0:
            say("  %d/%d" % (i + 1, len(entries)))
    if bad:
        shutil.rmtree(tmp)
        say("\nNão deu para gerar: alguns arquivos do jogo não são os esperados.")
        for b in bad[:15]:
            say("  " + b)
        say("\nSolução: na Steam, clique com o botão direito no jogo > Propriedades >")
        say("Arquivos instalados > Verificar integridade (na GOG: Gerenciar > Verificar/Reparar)")
        say("e rode de novo.")
        return 1
    extra = 0
    if chapters is not None:
        dst = os.path.join(tmp, *SCUMMVM_CHAPTERS.split("/"))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, "wb") as f:
            f.write(chapters)
        extra = 1

    # confere de novo o que foi gravado
    for dst, e in written:
        with open(dst, "rb") as f:
            if P.sha1(f.read()) != e.sha_out:
                shutil.rmtree(tmp)
                say("Erro ao gravar %s (o arquivo gravado não confere). Nada foi gerado." % dst)
                return 1
    n = len(written) + extra
    with open(os.path.join(tmp, MARK), "w", encoding="utf-8-sig", newline="\r\n") as f:
        f.write(LEIAME.format(versao=version, n=n, modo=" - ScummVM" if a.scummvm else "",
                              scummvm=TXT_SCUMMVM if a.scummvm else TXT_NORMAL))
    try:
        if os.path.isdir(saida):
            shutil.rmtree(saida)
        os.rename(tmp, saida)
    except OSError as ex:
        say("\nNão consegui substituir a pasta %s (%s)." % (saida, ex))
        say("Feche essa pasta (e arquivos dela) no Explorer e rode de novo.")
        say("A build nova ficou em: %s" % tmp)
        return 1

    say("\nPronto! %d arquivos traduzidos em:\n  %s" % (n, saida))
    partes = ["%d %s" % (counts[k], BASE[k][counts[k] != 1]) for k in ("original", "atualizado", "ja_instalado", "do patch") if counts.get(k)]
    say("Feito a partir de: %s." % " e ".join([", ".join(partes[:-1]), partes[-1]] if len(partes) > 1 else partes))
    say("Todos conferidos byte a byte com o patch.")
    if a.zip:
        z = saida + ".zip"
        if os.path.exists(z):
            os.remove(z)
        top = os.path.dirname(saida)
        with zipfile.ZipFile(z, "w", zipfile.ZIP_DEFLATED) as zf:
            for d, _, fs in os.walk(saida):
                for fn in sorted(fs):
                    p = os.path.join(d, fn)
                    zf.write(p, os.path.relpath(p, top))
        say("ZIP: %s" % z)
    say("Para instalar: copie o conteúdo da pasta para a pasta do jogo (veja o %s)." % MARK)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        say("\nCancelado.")
        sys.exit(1)
