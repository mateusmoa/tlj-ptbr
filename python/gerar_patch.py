#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Gera o tlj_ptbr.tljpatch a partir de uma build COMPLETA da tradução.

    python3 gerar_patch.py --en PASTA_DO_JOGO_EM_INGLES --pt PASTA_DA_BUILD_TRADUZIDA \
                           --versao 37 [--antigas build_antiga1.zip pasta_antiga2 ...]

--en      pasta com os arquivos originais (pode ser a pasta do jogo da Steam sem tradução)
--pt      pasta com a build traduzida completa (.xarc + chapters.ini/language.ini)
--antigas builds antigas (pastas ou .zip): nós que elas alteraram entram no patch mesmo
          quando a versão nova ficou igual ao inglês, para quem atualiza ficar exato
O patch só guarda o que é da tradução (textos, nomes, ajustes de layout) e hashes dos
originais; nenhum arquivo do jogo vai junto. No final ele confere que aplicar o patch nos
originais gera exatamente a build traduzida.
Precisa do tlj_ptbr_patcher.py na mesma pasta.
"""
import argparse, glob, gzip, hashlib, io, os, struct, sys, zipfile, zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tlj_ptbr_patcher as P

crc = lambda b: zlib.crc32(b) & 0xFFFFFFFF
sha = lambda b: hashlib.sha1(b).digest()


class Node:
    __slots__ = ("type", "sub", "index", "name", "data", "children", "unk")


def parse_node(buf, off):
    n = Node()
    n.type, n.sub = buf[off], buf[off + 1]
    n.index = struct.unpack_from("<H", buf, off + 2)[0]
    ln = struct.unpack_from("<H", buf, off + 4)[0]
    off += 6
    n.name = buf[off:off + ln]; off += ln
    dl = struct.unpack_from("<I", buf, off)[0]; off += 4
    n.data = buf[off:off + dl]; off += dl
    nc, n.unk = struct.unpack_from("<HH", buf, off); off += 4
    n.children = []
    for _ in range(nc):
        c, off = parse_node(buf, off)
        n.children.append(c)
    return n, off


def tree(buf):
    version, members = P.parse_xarc(buf)
    xi = next(i for i, m in enumerate(members) if m[0].lower().endswith(b".xrc"))
    _, _, o, l = members[xi]
    root, _ = parse_node(buf[o:o + l], 0)
    out = []
    def rec(n):
        out.append(n)
        for c in n.children:
            rec(c)
    rec(root)
    return out


def imgtext_off(n):
    """offset do u16 do texto num ImageText (t13/s4): [cabeçalho][u16][texto][8 bytes]"""
    d = n.data
    hit = None
    for x in range(0, len(d) - 2):
        v = struct.unpack_from("<H", d, x)[0]
        if v > 0 and x + 2 + v + 8 == len(d):
            seg = d[x + 2:x + 2 + v]
            if sum(1 for c in seg if c >= 32 or c in (9, 10, 13)) / len(seg) > 0.85:
                hit = (x, v)
    return hit


def diff_edits(E, T, force):
    edits = []
    for i, (a, b) in enumerate(zip(E, T)):
        if (a.type, a.sub, a.index, a.unk, len(a.children)) != (b.type, b.sub, b.index, b.unk, len(b.children)):
            raise SystemExit("estrutura diferente no nó %d - a build traduzida não bate com o original" % i)
        if a.name != b.name or (i, "n") in force:
            edits.append((i, a.type, a.sub, P.OP_RENAME, 0, crc(a.name), 0, b.name))
        if a.data == b.data and (i, "d") not in force:
            continue
        if a.type == 29 and len(a.data) >= 2 and len(b.data) >= 2:
            la = struct.unpack_from("<H", a.data, 0)[0]
            lb = struct.unpack_from("<H", b.data, 0)[0]
            if a.data[2 + la:] == b.data[2 + lb:]:
                edits.append((i, 29, a.sub, P.OP_SPEECH, 0, crc(a.data[2:2 + la]), crc(a.data[2 + la:]), b.data[2:2 + lb]))
                continue
        if a.type == 13 and a.sub == 4:
            ha, hb = imgtext_off(a), imgtext_off(b)
            if ha and hb and ha[0] == hb[0]:
                (x, va), (_, vb) = ha, hb
                if a.data[:x] == b.data[:x] and a.data[x + 2 + va:] == b.data[x + 2 + vb:]:
                    keep = a.data[:x] + a.data[x + 2 + va:]
                    edits.append((i, 13, 4, P.OP_IMGTEXT, x, crc(a.data[x + 2:x + 2 + va]), crc(keep), b.data[x + 2:x + 2 + vb]))
                    continue
        edits.append((i, a.type, a.sub, P.OP_DATA, 0, crc(a.data), 0, b.data))
    return edits


def files_of(root, ext):
    res = {}
    for f in glob.glob(os.path.join(root, "**", "*"), recursive=True):
        rel = os.path.relpath(f, root).replace(os.sep, "/")
        if rel.lower().startswith(P.BACKUP_DIR.lower() + "/"):
            continue
        if os.path.isfile(f) and f.lower().endswith(ext):
            res[rel.lower()] = f
    return res


def iter_build(src, wanted):
    def match(parts):
        for k in range(len(parts)):
            r = "/".join(parts[k:]).lower()
            if r in wanted:
                return r
    if os.path.isdir(src):
        for f in glob.glob(os.path.join(src, "**", "*.xarc"), recursive=True):
            r = match(os.path.relpath(f, src).replace(os.sep, "/").split("/"))
            if r:
                yield r, open(f, "rb").read()
    else:
        with zipfile.ZipFile(src) as z:
            for n in z.namelist():
                if n.lower().endswith(".xarc"):
                    r = match(n.replace("\\", "/").split("/"))
                    if r:
                        yield r, z.read(n)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--en", required=True)
    ap.add_argument("--pt", required=True)
    ap.add_argument("--versao", required=True)
    ap.add_argument("--titulo", default="The Longest Journey - Traducao PT-BR")
    ap.add_argument("--saida", default="tlj_ptbr.tljpatch")
    ap.add_argument("--antigas", nargs="*", default=[])
    ap.add_argument("--gzip", action="store_true",
                    help="comprime o patch (necessário só para o Instalar_Traducao_PTBR.exe 1.0.x)")
    a = ap.parse_args()
    EN, PT = files_of(a.en, ".xarc"), files_of(a.pt, ".xarc")
    falt = sorted(set(PT) - set(EN))
    if falt:
        raise SystemExit("arquivos traduzidos sem original correspondente: %s" % falt[:5])
    force = {}
    for src in a.antigas:
        n = 0
        for rel, buf in iter_build(src, EN):
            try:
                O, E = tree(buf), tree(open(EN[rel], "rb").read())
            except Exception:
                continue
            if len(O) != len(E):
                continue
            s = force.setdefault(rel, set())
            for i, (x, y) in enumerate(zip(E, O)):
                if x.name != y.name: s.add((i, "n"))
                if x.data != y.data: s.add((i, "d"))
            n += 1
        print("build antiga analisada:", src, n, "arquivos")
    entries, targets = [], {}
    for rel in sorted(PT):
        en_buf, pt_buf = open(EN[rel], "rb").read(), open(PT[rel], "rb").read()
        E, T = tree(en_buf), tree(pt_buf)
        if len(E) != len(T):
            raise SystemExit("%s: número de nós diferente" % rel)
        ed = diff_edits(E, T, force.get(rel, set()))
        if not ed:
            continue
        real = os.path.relpath(EN[rel], a.en).replace(os.sep, "/")
        entries.append((P.KIND_XARC, real, en_buf, pt_buf, len(E), ed))
        targets[real] = (en_buf, pt_buf)
    for ini in ("chapters.ini", "language.ini"):
        p_pt = P.resolve_ci(a.pt, ini)
        if os.path.isfile(p_pt):
            p_en = P.resolve_ci(a.en, ini)
            en_b = open(p_en, "rb").read() if os.path.isfile(p_en) else b""
            pt_b = open(p_pt, "rb").read()
            if en_b != pt_b:
                entries.append((P.KIND_FILE, ini, en_b, pt_b))
                targets[ini] = (en_b, pt_b)
    out = io.BytesIO(); w = out.write
    s16 = lambda s: w(struct.pack("<H", len(s.encode("utf-8"))) + s.encode("utf-8"))
    w(P.MAGIC); s16(a.versao); s16(a.titulo); w(struct.pack("<I", len(entries)))
    for e in entries:
        if e[0] == P.KIND_XARC:
            _, rel, en_buf, pt_buf, nc, ed = e
            w(struct.pack("<B", P.KIND_XARC)); s16(rel)
            w(sha(en_buf)); w(struct.pack("<I", len(en_buf))); w(sha(pt_buf)); w(struct.pack("<I", len(pt_buf)))
            w(struct.pack("<II", nc, len(ed)))
            for (node, t, s, op, aux, co, ck, pay) in ed:
                w(struct.pack("<IBBBIII", node, t, s, op, aux, co, ck)); w(struct.pack("<I", len(pay)) + pay)
        else:
            _, rel, en_b, pt_b = e
            w(struct.pack("<B", P.KIND_FILE)); s16(rel)
            w(sha(en_b) if en_b else b"\x00" * 20); w(sha(pt_b)); w(struct.pack("<I", len(pt_b)) + pt_b)
    with open(a.saida, "wb") as f:
        f.write(gzip.compress(out.getvalue(), 9, mtime=0) if a.gzip else out.getvalue())
    _, _, pe = P.read_patch(a.saida)
    for e in pe:
        en_b, pt_b = targets[e.path]
        res, st, _ = P.apply_entry(en_b if en_b else None, e)
        if res != pt_b:
            raise SystemExit("ERRO: aplicar o patch em %s não reproduz a build" % e.path)
    print("OK: %s  (versão %s, %d arquivos, %d bytes) - conferido byte a byte"
          % (a.saida, a.versao, len(pe), os.path.getsize(a.saida)))


if __name__ == "__main__":
    main()
