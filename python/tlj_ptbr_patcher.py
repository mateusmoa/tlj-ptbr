#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Instalador da tradução PT-BR de The Longest Journey (2000) - versão Python.

Funciona em Linux, Steam Deck, macOS e Windows (com Python 3.6+), sem
dependências. Faz o mesmo que o Instalar_Traducao_PTBR.exe:

  * aplica a tradução sobre os arquivos ORIGINAIS do seu jogo
    (o pacote não traz nenhum arquivo da Funcom, só os textos traduzidos);
  * guarda uma cópia de cada arquivo alterado em  _backup_traducao_ptbr/ ;
  * "--desinstalar" devolve os arquivos originais.

Uso:
  python3 tlj_ptbr_patcher.py                      (procura o jogo sozinho)
  python3 tlj_ptbr_patcher.py --jogo "/caminho/The Longest Journey"
  python3 tlj_ptbr_patcher.py --desinstalar
  python3 tlj_ptbr_patcher.py --verificar           (só confere, não altera nada)
"""
import argparse
import gzip
import hashlib
import os
import re
import shutil
import struct
import sys
import zlib

MAGIC = b"TLJPTBR\x01"
BACKUP_DIR = "_backup_traducao_ptbr"
MANIFEST = "instalado.txt"
PATCH_NAME = "tlj_ptbr.tljpatch"
STEAM_APP = "6310"
GOG_APP = "1207658794"

OP_SPEECH, OP_IMGTEXT, OP_RENAME, OP_DATA = 1, 2, 3, 4
KIND_XARC, KIND_FILE = 1, 2


class PatchError(Exception):
    pass


def crc32(b):
    return zlib.crc32(b) & 0xFFFFFFFF


def sha1(b):
    return hashlib.sha1(b).digest()


# ---------------------------------------------------------------- patch file
class Reader:
    def __init__(self, data):
        self.d, self.o = data, 0

    def take(self, n):
        if self.o + n > len(self.d):
            raise PatchError("arquivo de patch truncado")
        b = self.d[self.o:self.o + n]
        self.o += n
        return b

    def u8(self):
        return self.take(1)[0]

    def u16(self):
        return struct.unpack("<H", self.take(2))[0]

    def u32(self):
        return struct.unpack("<I", self.take(4))[0]

    def s16(self):
        return self.take(self.u16()).decode("utf-8")

    def b32(self):
        return self.take(self.u32())


class Edit:
    __slots__ = ("node", "type", "sub", "op", "aux", "crc_orig", "crc_keep", "payload")


class Entry:
    __slots__ = ("kind", "path", "sha_en", "size_en", "sha_out", "size_out",
                 "node_count", "edits", "content")


def read_patch(path):
    raw = open(path, "rb").read()
    data = raw
    if raw[:2] == b"\x1f\x8b":          # versões antigas do patch vinham comprimidas
        try:
            data = gzip.decompress(raw)
        except OSError:
            raise PatchError("o arquivo de patch está corrompido (gzip)")
    r = Reader(data)
    if r.take(8) != MAGIC:
        raise PatchError("formato de patch desconhecido")
    version = r.s16()
    title = r.s16()
    entries = []
    for _ in range(r.u32()):
        e = Entry()
        e.kind = r.u8()
        e.path = r.s16()
        if e.kind == KIND_XARC:
            e.sha_en = r.take(20)
            e.size_en = r.u32()
            e.sha_out = r.take(20)
            e.size_out = r.u32()
            e.node_count = r.u32()
            e.edits = []
            for _ in range(r.u32()):
                ed = Edit()
                ed.node = r.u32()
                ed.type = r.u8()
                ed.sub = r.u8()
                ed.op = r.u8()
                ed.aux = r.u32()
                ed.crc_orig = r.u32()
                ed.crc_keep = r.u32()
                ed.payload = r.b32()
                e.edits.append(ed)
        elif e.kind == KIND_FILE:
            e.sha_en = r.take(20)
            e.sha_out = r.take(20)
            e.content = r.b32()
            e.edits = []
        else:
            raise PatchError("tipo de entrada desconhecido no patch")
        entries.append(e)
    return version, title, entries


# ---------------------------------------------------------------- XARC / XRC
def parse_xarc(buf):
    if len(buf) < 12:
        raise PatchError("arquivo .xarc muito pequeno")
    version, num, first = struct.unpack_from("<III", buf, 0)
    o = 12
    members = []
    for _ in range(num):
        e = buf.index(b"\x00", o)
        name = buf[o:e]
        o = e + 1
        ln, fl = struct.unpack_from("<II", buf, o)
        o += 8
        members.append([name, fl, ln])
    off = first
    out = []
    for name, fl, ln in members:
        if off + ln > len(buf):
            raise PatchError("tabela do .xarc inconsistente")
        out.append((name, fl, off, ln))
        off += ln
    if off != len(buf):
        raise PatchError("tamanho do .xarc inconsistente")
    return version, out


def parse_nodes(xrc):
    """Percorre a árvore em pré-ordem. Cada nó: (type, sub, name_off, name_len,
    data_off, data_len). name_off aponta para o u16 do nome; data_off para o u32."""
    nodes = []
    o = 0
    stack = [1]
    n = len(xrc)
    while stack:
        if stack[-1] == 0:
            stack.pop()
            continue
        stack[-1] -= 1
        if o + 6 > n:
            raise PatchError("árvore .xrc truncada")
        t, s = xrc[o], xrc[o + 1]
        name_off = o + 4
        name_len = struct.unpack_from("<H", xrc, name_off)[0]
        data_off = name_off + 2 + name_len
        data_len = struct.unpack_from("<I", xrc, data_off)[0]
        o = data_off + 4 + data_len
        if o + 4 > n:
            raise PatchError("árvore .xrc truncada")
        nchild = struct.unpack_from("<H", xrc, o)[0]
        o += 4
        nodes.append((t, s, name_off, name_len, data_off, data_len))
        stack.append(nchild)
    return nodes, o


def apply_xarc(buf, entry):
    """Aplica as edições. Devolve (bytes_novos, situação, avisos).
    situação: 'original' | 'ja_instalado' | 'atualizado' | 'divergente'."""
    h = sha1(buf)
    if h == entry.sha_out and len(buf) == entry.size_out:
        return buf, "ja_instalado", 0
    is_orig = (h == entry.sha_en and len(buf) == entry.size_en)
    version, members = parse_xarc(buf)
    xi = next((i for i, m in enumerate(members) if m[0].lower().endswith(b".xrc")), None)
    if xi is None:
        raise PatchError("o .xarc não contém .xrc")
    _, _, xoff, xlen = members[xi]
    xrc = buf[xoff:xoff + xlen]
    nodes, _ = parse_nodes(xrc)
    if len(nodes) != entry.node_count:
        raise PatchError("estrutura diferente da esperada (%d nós, esperado %d)"
                         % (len(nodes), entry.node_count))
    reps = []      # (inicio, fim, bytes)
    others = 0
    for ed in entry.edits:
        if ed.node >= len(nodes):
            raise PatchError("nó inexistente")
        t, s, no, nl, do, dl = nodes[ed.node]
        if (t, s) != (ed.type, ed.sub):
            raise PatchError("tipo de nó diferente do esperado")
        if ed.op == OP_RENAME:
            cur = xrc[no + 2:no + 2 + nl]
            if cur != ed.payload and crc32(cur) != ed.crc_orig:
                others += 1
            reps.append((no, no + 2 + nl, struct.pack("<H", len(ed.payload)) + ed.payload))
            continue
        data = xrc[do + 4:do + 4 + dl]
        if ed.op == OP_SPEECH:
            if dl < 2:
                raise PatchError("fala inválida")
            tl = struct.unpack_from("<H", data, 0)[0]
            if 2 + tl > dl:
                raise PatchError("fala inválida")
            cur, tail = data[2:2 + tl], data[2 + tl:]
            if crc32(tail) != ed.crc_keep:
                raise PatchError("dados da fala diferentes do esperado")
            if cur != ed.payload and crc32(cur) != ed.crc_orig:
                others += 1
            new = struct.pack("<H", len(ed.payload)) + ed.payload + tail
        elif ed.op == OP_IMGTEXT:
            x = ed.aux
            if x + 2 > dl:
                raise PatchError("texto de imagem inválido")
            tl = struct.unpack_from("<H", data, x)[0]
            if x + 2 + tl > dl:
                raise PatchError("texto de imagem inválido")
            head, cur, trail = data[:x], data[x + 2:x + 2 + tl], data[x + 2 + tl:]
            if crc32(head + trail) != ed.crc_keep:
                raise PatchError("dados do texto de imagem diferentes do esperado")
            if cur != ed.payload and crc32(cur) != ed.crc_orig:
                others += 1
            new = head + struct.pack("<H", len(ed.payload)) + ed.payload + trail
        elif ed.op == OP_DATA:
            if data != ed.payload and crc32(data) != ed.crc_orig:
                others += 1
            new = ed.payload
        else:
            raise PatchError("operação desconhecida no patch")
        reps.append((do, do + 4 + dl, struct.pack("<I", len(new)) + new))
    reps.sort(key=lambda r: r[0])
    parts, pos = [], 0
    for a, b, nb in reps:
        if a < pos:
            raise PatchError("edições sobrepostas")
        parts.append(xrc[pos:a])
        parts.append(nb)
        pos = b
    parts.append(xrc[pos:])
    new_xrc = b"".join(parts)
    # remonta o .xarc (mesma ordem, só muda o tamanho do .xrc)
    table = b""
    for i, (name, fl, off, ln) in enumerate(members):
        table += name + b"\x00" + struct.pack("<II", len(new_xrc) if i == xi else ln, fl)
    first = 12 + len(table)
    out = [struct.pack("<III", version, len(members), first), table]
    for i, (name, fl, off, ln) in enumerate(members):
        out.append(new_xrc if i == xi else buf[off:off + ln])
    res = b"".join(out)
    ok = (sha1(res) == entry.sha_out and len(res) == entry.size_out)
    if is_orig:
        if not ok:
            raise PatchError("resultado inesperado (patch e jogo não combinam)")
        return res, "original", 0
    return res, ("atualizado" if ok else "divergente"), others


def apply_entry(buf, entry):
    if entry.kind == KIND_FILE:
        if buf is not None and sha1(buf) == entry.sha_out:
            return buf, "ja_instalado", 0
        st = "original" if (buf is not None and sha1(buf) == entry.sha_en) else "atualizado"
        return entry.content, st, 0
    return apply_xarc(buf, entry)


# ---------------------------------------------------------------- caminhos
def resolve_ci(root, rel):
    """Acha rel dentro de root ignorando maiúsculas/minúsculas (Linux/Proton)."""
    cur = root
    for part in rel.split("/"):
        cand = os.path.join(cur, part)
        if not os.path.exists(cand):
            try:
                low = part.lower()
                hit = next((n for n in os.listdir(cur) if n.lower() == low), None)
            except OSError:
                hit = None
            cand = os.path.join(cur, hit if hit else part)
        cur = cand
    return cur


def is_game_dir(p):
    return bool(p) and os.path.isfile(resolve_ci(p, "game.exe")) and \
        os.path.isfile(resolve_ci(p, "x.xarc"))


def steam_libraries():
    homes = [os.path.expanduser(x) for x in (
        "~/.steam/steam", "~/.local/share/Steam", "~/.steam/root",
        "~/.var/app/com.valvesoftware.Steam/.local/share/Steam",
        "~/Library/Application Support/Steam")]
    if os.name == "nt":
        try:
            import winreg
            for hive, key in ((winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam"),):
                with winreg.OpenKey(hive, key) as k:
                    homes.append(winreg.QueryValueEx(k, "SteamPath")[0])
        except OSError:
            pass
        homes += [r"C:\Program Files (x86)\Steam", r"C:\Program Files\Steam"]
    libs = []
    for h in homes:
        vdf = os.path.join(h, "steamapps", "libraryfolders.vdf")
        if os.path.isfile(vdf):
            libs.append(h)
            try:
                txt = open(vdf, encoding="utf-8", errors="replace").read()
                libs += [p.replace("\\\\", "\\") for p in re.findall(r'"path"\s*"([^"]+)"', txt)]
            except OSError:
                pass
    seen, res = set(), []
    for l in libs:
        k = os.path.normcase(os.path.abspath(l))
        if k not in seen:
            seen.add(k)
            res.append(l)
    return res


def find_game():
    here = os.path.dirname(os.path.abspath(sys.argv[0]))
    for c in (os.getcwd(), here, os.path.dirname(here)):
        if is_game_dir(c):
            return c
    for lib in steam_libraries():
        acf = os.path.join(lib, "steamapps", "appmanifest_%s.acf" % STEAM_APP)
        inst = "The Longest Journey"
        if os.path.isfile(acf):
            m = re.search(r'"installdir"\s*"([^"]+)"',
                          open(acf, encoding="utf-8", errors="replace").read())
            if m:
                inst = m.group(1)
        c = os.path.join(lib, "steamapps", "common", inst)
        if is_game_dir(c):
            return c
    if os.name == "nt":
        try:
            import winreg
            for key in (r"SOFTWARE\WOW6432Node\GOG.com\Games\%s" % GOG_APP,
                        r"SOFTWARE\GOG.com\Games\%s" % GOG_APP):
                try:
                    with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, key) as k:
                        c = winreg.QueryValueEx(k, "path")[0]
                        if is_game_dir(c):
                            return c
                except OSError:
                    pass
        except ImportError:
            pass
    for c in (os.path.expanduser("~/GOG Games/The Longest Journey"),
              os.path.expanduser("~/Games/gog/the-longest-journey/drive_c/GOG Games/The Longest Journey")):
        if is_game_dir(c):
            return c
    return None


def find_patch():
    here = os.path.dirname(os.path.abspath(sys.argv[0]))
    for c in (os.path.join(here, PATCH_NAME), os.path.join(here, "..", PATCH_NAME),
              os.path.join(here, "dados", PATCH_NAME), os.path.join(os.getcwd(), PATCH_NAME)):
        if os.path.isfile(c):
            return c
    return None


# ---------------------------------------------------------------- ações
def write_atomic(path, data):
    tmp = path + ".tmp_ptbr"
    with open(tmp, "wb") as f:
        f.write(data)
    if os.path.exists(path) and not os.access(path, os.W_OK):
        try:
            os.chmod(path, 0o644)      # arquivos de CD às vezes vêm "somente leitura"
        except OSError:
            pass
    os.replace(tmp, path)


def say(msg=""):
    print(msg, flush=True)


def check_vortex(game, entries):
    for e in entries:
        if os.path.exists(resolve_ci(game, e.path) + ".vortex_backup"):
            return True
    return False


def install(game, patch_path, dry=False):
    version, title, entries = read_patch(patch_path)
    say("%s  (versão %s)" % (title, version))
    say("Pasta do jogo: %s" % game)
    if check_vortex(game, entries):
        say("\nATENÇÃO: há arquivos .vortex_backup nesta pasta: o Vortex está gerenciando")
        say("mods deste jogo. Instale/desinstale a tradução pelo Vortex para não misturar.")
        return 2
    # fase 1: confere tudo antes de mexer em qualquer arquivo
    say("\nConferindo %d arquivos..." % len(entries))
    plan, missing, bad = [], [], []
    for i, e in enumerate(entries):
        p = resolve_ci(game, e.path)
        if e.kind == KIND_XARC and not os.path.isfile(p):
            missing.append(e.path)
            continue
        buf = open(p, "rb").read() if os.path.isfile(p) else None
        try:
            _, st, oth = apply_entry(buf, e)
        except PatchError as ex:
            bad.append("%s: %s" % (e.path, ex))
            continue
        plan.append((e, p, st, oth))
        if (i + 1) % 25 == 0:
            say("  %d/%d" % (i + 1, len(entries)))
    if missing or bad:
        say("\nNão dá para instalar: alguns arquivos do jogo não são os esperados.")
        for m in missing[:15]:
            say("  faltando: " + m)
        for b in bad[:15]:
            say("  diferente: " + b)
        say("\nSolução: na Steam, clique com o botão direito no jogo > Propriedades >")
        say("Arquivos instalados > Verificar integridade (na GOG: Gerenciar > Verificar/Reparar)")
        say("e rode o instalador de novo.")
        return 1
    counts = {}
    for _, _, st, _ in plan:
        counts[st] = counts.get(st, 0) + 1
    if dry:
        say("\nTudo certo para instalar: %s" % counts)
        return 0
    if counts.get("ja_instalado", 0) == len(plan):
        say("\nA tradução (esta versão) já está instalada. Nada a fazer.")
        return 0
    # fase 2: backup + escrita
    bdir = os.path.join(game, BACKUP_DIR)
    os.makedirs(bdir, exist_ok=True)
    log = []
    say("\nInstalando...")
    for i, (e, p, st, oth) in enumerate(plan):
        if st == "ja_instalado":
            log.append("%s\tja_instalado" % e.path)
            continue
        buf = open(p, "rb").read() if os.path.isfile(p) else None
        out, st, oth = apply_entry(buf, e)
        bpath = os.path.join(bdir, *e.path.split("/"))
        if buf is not None and not os.path.exists(bpath):
            os.makedirs(os.path.dirname(bpath), exist_ok=True)
            shutil.copy2(p, bpath)
        elif buf is None and not os.path.exists(bpath + ".nao_existia"):
            os.makedirs(os.path.dirname(bpath), exist_ok=True)
            open(bpath + ".nao_existia", "wb").close()
        write_atomic(p, out)
        log.append("%s\t%s" % (e.path, st))
        if (i + 1) % 25 == 0:
            say("  %d/%d" % (i + 1, len(plan)))
    with open(os.path.join(bdir, MANIFEST), "w", encoding="utf-8") as f:
        f.write("versao\t%s\n" % version)
        f.write("\n".join(log) + "\n")
    div = sum(1 for _, _, st, _ in plan if st == "divergente")
    say("\nPronto! Tradução instalada: %s" % counts)
    if div:
        say("Obs.: %d arquivo(s) já estavam modificados por outra versão da tradução;" % div)
        say("os textos foram atualizados mesmo assim.")
    say("Backup dos arquivos anteriores em: %s" % bdir)
    return 0


def uninstall(game, patch_path=None):
    bdir = os.path.join(game, BACKUP_DIR)
    if not os.path.isdir(bdir):
        say("Não encontrei a pasta de backup (%s). Nada a desinstalar." % BACKUP_DIR)
        say("Para voltar ao inglês de qualquer jeito: Steam > Verificar integridade.")
        return 1
    en = {}
    if patch_path:
        try:
            for e in read_patch(patch_path)[2]:
                en[e.path.lower()] = e.sha_en
        except (PatchError, OSError):
            pass
    restored, notorig = 0, 0
    for dp, dn, fn in os.walk(bdir):
        for n in fn:
            if n == MANIFEST:
                continue
            src = os.path.join(dp, n)
            rel = os.path.relpath(src, bdir).replace(os.sep, "/")
            if rel.endswith(".nao_existia"):
                rel = rel[:-len(".nao_existia")]
                dst = resolve_ci(game, rel)
                if os.path.isfile(dst):
                    os.remove(dst)
                restored += 1
                continue
            dst = resolve_ci(game, rel)
            data = open(src, "rb").read()
            if rel.lower() in en and en[rel.lower()] != b"\x00" * 20 and sha1(data) != en[rel.lower()]:
                notorig += 1
            write_atomic(dst, data)
            restored += 1
    def _force(func, path, _exc):
        os.chmod(path, 0o666)          # backup de arquivo "somente leitura" (Windows)
        func(path)
    shutil.rmtree(bdir, onerror=_force)
    say("Pronto! %d arquivo(s) restaurado(s). O jogo voltou ao estado anterior." % restored)
    if notorig:
        say("Obs.: %d arquivo(s) do backup não eram os originais em inglês (havia outra" % notorig)
        say("tradução instalada antes). Para o inglês puro: Steam > Verificar integridade.")
    return 0


def main():
    ap = argparse.ArgumentParser(description="Tradução PT-BR de The Longest Journey")
    ap.add_argument("--jogo", help="pasta do jogo (onde fica o game.exe)")
    ap.add_argument("--patch", help="arquivo .tljpatch (padrão: ao lado deste script)")
    ap.add_argument("--desinstalar", action="store_true", help="restaura os arquivos originais")
    ap.add_argument("--verificar", action="store_true", help="só confere, não altera nada")
    a = ap.parse_args()
    game = a.jogo or find_game()
    if not game:
        try:
            game = input("Não achei o jogo. Digite (ou arraste) a pasta do jogo e aperte Enter:\n> ")
            game = game.strip().strip('"').strip("'")
        except EOFError:
            game = ""
    if not is_game_dir(game):
        say("Essa pasta não parece ser a do The Longest Journey (precisa ter game.exe e x.xarc).")
        return 1
    patch = a.patch or find_patch()
    if a.desinstalar:
        return uninstall(game, patch)
    if not patch:
        say("Não encontrei o arquivo %s ao lado do instalador." % PATCH_NAME)
        return 1
    try:
        return install(game, patch, dry=a.verificar)
    except PatchError as ex:
        say("Erro: %s" % ex)
        return 1


if __name__ == "__main__":
    sys.exit(main())
