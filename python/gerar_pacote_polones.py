#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Monta, a partir da SUA cópia polonesa do The Longest Journey (GOG), os pacotes para usar o polonês
no jogo em inglês pelo Vortex:

  TLJ_PL_Dublagem.zip  falas (.iss/.ssn), vídeos (.bbb) e animações (.sss) da versão polonesa,
                       nas pastas do jogo (o Vortex instala como arquivos soltos)
  TLJ_PL_Texto.zip     tlj_pl.tljpatch: falas, nomes, sincronia labial, chapters.ini, language.ini,
                       gui.ini e fontes (só se você indicar também a pasta do jogo em inglês)

    python gerar_pacote_polones.py --pl "C:\\GOG Games\\The Longest Journey PL" [--en "PASTA EM INGLÊS"] [--saida PASTA]

Sem parâmetros, abre janelas para escolher as pastas. Com --en, os arquivos idênticos aos do inglês
(música, efeitos) ficam fora da dublagem e o patch de texto é gerado contra a sua instalação inglesa.
Nada é alterado nas pastas do jogo.
"""
import argparse, hashlib, os, re, sys, time, zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

MIDIA = re.compile(r"\.(iss|ssn|bbb|sss)$", re.I)
PASTA_JOGO = re.compile(r"^([0-9a-f]{2}|global|static)$", re.I)     # pastas de fase, Global e Static
CHAPTERS_PL = "6abc5c38e6e31face4b675355b117620"
LEIA_ME = """Dublagem polonesa do The Longest Journey (gerada da cópia polonesa do próprio jogador)

Instale este zip no Vortex como mod (arraste para a aba Mods). Ele substitui falas, vídeos e
animações pelos da versão polonesa. Para o texto em polonês e a sincronia labial, instale também o
TLJ_PL_Texto.zip (tlj_pl.tljpatch). Desativar o mod no Vortex volta tudo ao original.
Uso pessoal: os arquivos são da versão polonesa oficial (CD Projekt); não distribua.
"""


def md5(p):
    with open(p, "rb") as f:
        return hashlib.md5(f.read()).hexdigest()


def sha1_arquivo(p):
    h = hashlib.sha1()
    with open(p, "rb") as f:
        for bloco in iter(lambda: f.read(1 << 20), b""):
            h.update(bloco)
    return h.digest()


def indice(root):
    """caminho relativo em minúsculas -> (caminho real relativo, caminho absoluto)"""
    out = {}
    for dp, dn, fn in os.walk(root):
        rel_dir = os.path.relpath(dp, root)
        partes = [] if rel_dir == "." else rel_dir.replace(os.sep, "/").split("/")
        if partes and not PASTA_JOGO.match(partes[0]):
            dn[:] = []
            continue
        for f in fn:
            rel = "/".join(partes + [f])
            out[rel.lower()] = (rel, os.path.join(dp, f))
    return out


def eh_jogo(p):
    return p and os.path.isfile(os.path.join(p, "x.xarc")) and any(
        n.lower() == "chapters.ini" for n in os.listdir(p))


def chapters(p):
    n = next((x for x in os.listdir(p) if x.lower() == "chapters.ini"), None)
    return md5(os.path.join(p, n)) if n else None


def dublagem(pl, en, saida, avisar=print):
    I_PL = indice(pl)
    I_EN = indice(en) if en else {}
    midia = sorted(k for k in I_PL if MIDIA.search(k))
    iguais = sem_par = 0
    tam = 0
    destino = os.path.join(saida, "TLJ_PL_Dublagem.zip")
    tmp = destino + ".tmp"
    t0 = time.time()
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_STORED, allowZip64=True) as z:
        z.writestr("LEIA-ME.txt", LEIA_ME.encode("utf-8"))
        for i, k in enumerate(midia, 1):
            rel_pl, abs_pl = I_PL[k]
            rel = rel_pl
            if k in I_EN:
                rel_en, abs_en = I_EN[k]
                rel = rel_en          # mesmas maiúsculas da sua instalação
                if os.path.getsize(abs_en) == os.path.getsize(abs_pl) and sha1_arquivo(abs_en) == sha1_arquivo(abs_pl):
                    iguais += 1
                    continue
            elif en:
                sem_par += 1
            z.write(abs_pl, rel)
            tam += os.path.getsize(abs_pl)
            if i % 500 == 0:
                avisar("   %d/%d arquivos..." % (i, len(midia)))
    os.replace(tmp, destino)
    avisar("OK: %s (%.0f MB, %d arquivos, %.0f s)" % (destino, tam / 1048576, len(midia) - iguais, time.time() - t0))
    if en:
        avisar("   iguais ao inglês (ficaram de fora): %d | sem equivalente no inglês: %d" % (iguais, sem_par))
    return destino


def texto(pl, en, saida, avisar=print):
    import gerar_patch_outra_versao as G
    patch = os.path.join(saida, "tlj_pl.tljpatch")
    G.gerar(en, pl, patch, "pl-1.0", "The Longest Journey - Polski (tekst)", avisar=avisar)
    destino = os.path.join(saida, "TLJ_PL_Texto.zip")
    with zipfile.ZipFile(destino, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(patch, "tlj_pl.tljpatch")
    os.remove(patch)
    avisar("OK: %s" % destino)
    return destino


def escolher_pastas():
    import tkinter as tk
    from tkinter import filedialog, messagebox
    raiz = tk.Tk()
    raiz.withdraw()
    messagebox.showinfo("Pacote polonês", "Escolha a pasta do jogo POLONÊS (onde estão o game.exe e o x.xarc).")
    pl = filedialog.askdirectory(title="Pasta do jogo POLONÊS")
    if not pl:
        sys.exit(1)
    en = None
    if messagebox.askyesno("Pacote polonês", "Indicar também a pasta do jogo em INGLÊS?\n\n"
                           "Com ela, o patch de texto é gerado contra a sua instalação e os arquivos "
                           "iguais (música, efeitos) ficam fora da dublagem."):
        en = filedialog.askdirectory(title="Pasta do jogo em INGLÊS (sem tradução instalada)") or None
    saida = filedialog.askdirectory(title="Onde salvar os zips") or os.path.join(os.path.expanduser("~"), "Desktop")
    raiz.destroy()
    return pl, en, saida


def main():
    ap = argparse.ArgumentParser(description="Monta a dublagem (e o patch de texto) poloneses a partir da sua cópia do jogo.")
    ap.add_argument("--pl", help="pasta do jogo polonês")
    ap.add_argument("--en", help="pasta do jogo em inglês (opcional)")
    ap.add_argument("--saida", help="pasta onde salvar os zips (padrão: a pasta atual)")
    ap.add_argument("--sem-dublagem", action="store_true")
    ap.add_argument("--sem-texto", action="store_true")
    a = ap.parse_args()
    if not a.pl:
        a.pl, a.en, a.saida = escolher_pastas()
    saida = a.saida or os.getcwd()
    os.makedirs(saida, exist_ok=True)
    if not eh_jogo(a.pl):
        raise SystemExit("Não achei o x.xarc e o chapters.ini em: %s" % a.pl)
    if chapters(a.pl) != CHAPTERS_PL:
        print("AVISO: o chapters.ini de %s não é o da versão polonesa (GOG / 4 CD)." % a.pl)
    if a.en:
        if not eh_jogo(a.en):
            raise SystemExit("Não achei o x.xarc e o chapters.ini em: %s" % a.en)
        if any(x.lower().endswith(".vortex_backup") for x in os.listdir(a.en)) or \
           os.path.isdir(os.path.join(a.en, "_backup_traducao_ptbr")):
            print("AVISO: a pasta em inglês parece ter mods/tradução instalados; o patch é gerado contra os "
                  "arquivos que estiverem lá. O ideal é desativar os mods no Vortex antes (Purge).")
    print("Jogo polonês: %s" % a.pl)
    print("Jogo inglês:  %s" % (a.en or "(não indicado)"))
    if not a.sem_dublagem:
        print("\nDublagem...")
        dublagem(a.pl, a.en, saida)
    if not a.sem_texto:
        if a.en:
            print("\nTexto...")
            texto(a.pl, a.en, saida)
        else:
            print("\nTexto: sem a pasta em inglês, use o TLJ_PL_Texto.zip que veio pronto.")
    print("\nPronto. Instale os zips no Vortex (arraste para a aba Mods).")


if __name__ == "__main__":
    main()
