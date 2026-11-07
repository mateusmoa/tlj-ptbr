#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Gera um .tljpatch com os textos de OUTRA versão oficial do jogo (ex.: a polonesa), para aplicar no
jogo em inglês sem mudar a estrutura dele (os saves continuam valendo).

    python3 gerar_patch_outra_versao.py --en PASTA_DO_JOGO_EM_INGLES --outra PASTA_DA_OUTRA_VERSAO \
            --saida tlj_pl.tljpatch --versao pl-1.0 --titulo "The Longest Journey - Polski"

O que entra no patch:
  - falas, nomes, textos de imagem e sincronia labial (nós da árvore .xrc que existem nas duas versões);
  - arquivos internos dos .xarc que mudaram ou faltam (ex.: falas curtas .isn embutidas, que a Steam não tem);
  - chapters.ini, language.ini, gui.ini, x.xarc e as fontes (pasta Fonts) da outra versão.
Nós que só existem numa das versões (algumas trilhas de sincronia labial) ficam como no inglês.
Áudio solto (.iss), vídeos (.bbb/.sss/.ssn) e executáveis NÃO entram.
No final ele aplica o patch nos originais e confere nó por nó com a outra versão.
Precisa do tlj_ptbr_patcher.py na mesma pasta.
"""
import argparse, glob, hashlib, io, os, struct, sys, zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tlj_ptbr_patcher as P

crc = lambda b: zlib.crc32(b) & 0xFFFFFFFF
sha = lambda b: hashlib.sha1(b).digest()
ARQUIVOS_INTEIROS = ("chapters.ini", "language.ini", "gui.ini")
# entram mesmo iguais ao inglês: o x.xarc (lista das fases) é o que, junto com o chapters.ini, faz o
# ScummVM reconhecer a versão (ex.: "Polish 4CD"); na Steam/DVD ele é outro, com as mesmas fases
SEMPRE = ("x.xarc",)


class Node:
    __slots__ = ("type", "sub", "index", "name", "data", "children", "unk", "path")


def parse_node(buf, off, pai=((),)):
    n = Node()
    n.type, n.sub = buf[off], buf[off + 1]
    n.index = struct.unpack_from("<H", buf, off + 2)[0]
    ln = struct.unpack_from("<H", buf, off + 4)[0]
    off += 6
    n.name = buf[off:off + ln]; off += ln
    dl = struct.unpack_from("<I", buf, off)[0]; off += 4
    n.data = buf[off:off + dl]; off += dl
    nc, n.unk = struct.unpack_from("<HH", buf, off); off += 4
    n.path = pai
    n.children = []
    vistos = {}
    for _ in range(nc):
        c, off = parse_node(buf, off)
        n.children.append(c)
    for c in n.children:
        # caminho único: tipo/subtipo/índice de cada nível + quantos irmãos iguais vieram antes
        chave = (c.type, c.sub, c.index)
        vistos[chave] = vistos.get(chave, -1) + 1
        definir_caminho(c, n.path + (chave + (vistos[chave],),))
    return n, off


def definir_caminho(n, caminho):
    n.path = caminho
    vistos = {}
    for c in n.children:
        chave = (c.type, c.sub, c.index)
        vistos[chave] = vistos.get(chave, -1) + 1
        definir_caminho(c, caminho + (chave + (vistos[chave],),))


def arvore(buf):
    _, members = P.parse_xarc(buf)
    xi = next(i for i, m in enumerate(members) if m[0].lower().endswith(b".xrc"))
    _, _, o, l = members[xi]
    root, _ = parse_node(buf[o:o + l], 0)
    out = []
    def rec(n):
        out.append(n)
        for c in n.children:
            rec(c)
    rec(root)
    return out, members, xi


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


def edicoes_nos(E, O):
    """edições para levar os nós do inglês (E) ao conteúdo da outra versão (O), casando pelo caminho"""
    por_caminho = {}
    for n in O:
        por_caminho.setdefault(n.path, n)
    edits, so_outra, so_en = [], 0, 0
    usados = set()
    for i, a in enumerate(E):
        b = por_caminho.get(a.path)
        if b is None:
            so_en += 1
            continue
        usados.add(a.path)
        if a.name != b.name:
            edits.append((i, a.type, a.sub, P.OP_RENAME, 0, crc(a.name), 0, b.name))
        if a.data == b.data:
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
    so_outra = sum(1 for n in O if n.path not in usados)
    return edits, so_en, so_outra


def edicoes_membros(en_buf, en_members, en_xi, o_buf, o_members):
    """arquivos internos (fora o .xrc) da outra versão que mudaram ou que faltam no inglês, pelo nome"""
    do_en = {m[0].lower(): m for m in en_members}
    edits = []
    for name, fl, off, ln in o_members:
        if name.lower().endswith(b".xrc"):
            continue
        b = o_buf[off:off + ln]
        m = do_en.get(name.lower())
        a = en_buf[m[2]:m[2] + m[3]] if m is not None else None
        if a != b:
            pay = struct.pack("<H", len(name)) + name + b
            edits.append((0, 0, 0, P.OP_MEMBER, fl, crc(a) if a is not None else 0, crc(name.lower()), pay))
    return edits


def arquivos(root, ext):
    res = {}
    for f in glob.glob(os.path.join(root, "**", "*"), recursive=True):
        rel = os.path.relpath(f, root).replace(os.sep, "/")
        if rel.lower().startswith(P.BACKUP_DIR.lower() + "/"):
            continue
        if os.path.isfile(f) and f.lower().endswith(ext):
            res[rel.lower()] = f
    return res


def conferir(en_buf, res, o_buf):
    """o resultado tem a estrutura do inglês e, nos nós comuns, o conteúdo da outra versão"""
    E, em, _ = arvore(en_buf)
    R, rm, rxi = arvore(res)
    O, om, _ = arvore(o_buf)
    if [(n.type, n.sub, n.index, len(n.children), n.unk) for n in E] != \
       [(n.type, n.sub, n.index, len(n.children), n.unk) for n in R]:
        return "a estrutura do resultado não é a do inglês"
    por = {n.path: n for n in O}
    for n in R:
        b = por.get(n.path)
        if b is not None and (n.name != b.name or n.data != b.data):
            return "nó %r diferente da outra versão" % (n.path,)
    rnome = {m[0].lower(): m for m in rm}
    for name, fl, off, ln in om:
        if name.lower().endswith(b".xrc"):
            continue
        m = rnome.get(name.lower())
        if m is None:
            return "arquivo interno %s não entrou no resultado" % name.decode("latin1")
        if res[m[2]:m[2] + m[3]] != o_buf[off:off + ln]:
            return "arquivo interno %s diferente da outra versão" % name.decode("latin1")
    return None


def gerar(en, outra, saida, versao, titulo, sem_fontes=False, avisar=print):
    """gera e confere o patch; devolve o resumo (dicionário)"""
    class A: pass
    a = A()
    a.en, a.outra, a.saida, a.versao, a.titulo, a.sem_fontes = en, outra, saida, versao, titulo, sem_fontes
    EN, OUT = arquivos(a.en, ".xarc"), arquivos(a.outra, ".xarc")
    entries, origem = [], {}
    tot = {"falas": 0, "outros_nos": 0, "internos": 0, "so_en": 0, "so_outra": 0, "iguais": 0}
    for rel in sorted(set(EN) & set(OUT)):
        en_buf, o_buf = open(EN[rel], "rb").read(), open(OUT[rel], "rb").read()
        if en_buf == o_buf:
            tot["iguais"] += 1
            continue
        E, em, exi = arvore(en_buf)
        O, om, _ = arvore(o_buf)
        ed, so_en, so_outra = edicoes_nos(E, O)
        ed += edicoes_membros(en_buf, em, exi, o_buf, om)
        tot["so_en"] += so_en
        tot["so_outra"] += so_outra
        if not ed:
            continue
        for e in ed:
            tot["falas" if e[3] == P.OP_SPEECH else "internos" if e[3] == P.OP_MEMBER else "outros_nos"] += 1
        real = os.path.relpath(EN[rel], a.en).replace(os.sep, "/")
        entries.append([P.KIND_XARC, real, en_buf, None, len(E), ed])
        origem[real] = (en_buf, o_buf)
    so_en_arqs = sorted(set(EN) - set(OUT))
    inteiros = list(ARQUIVOS_INTEIROS)
    if not a.sem_fontes:
        for f in sorted(glob.glob(os.path.join(a.outra, "*"))):
            if os.path.isdir(f) and os.path.basename(f).lower() == "fonts":
                inteiros += sorted(os.path.relpath(x, a.outra).replace(os.sep, "/")
                                   for x in glob.glob(os.path.join(f, "*")) if os.path.isfile(x))
    for rel in inteiros + list(SEMPRE):
        p_o = P.resolve_ci(a.outra, rel)
        if not os.path.isfile(p_o):
            continue
        p_en = P.resolve_ci(a.en, rel)
        en_b = open(p_en, "rb").read() if os.path.isfile(p_en) else b""
        o_b = open(p_o, "rb").read()
        if en_b != o_b or rel in SEMPRE:
            real = os.path.relpath(p_en, a.en).replace(os.sep, "/") if os.path.isfile(p_en) else rel
            entries.append([P.KIND_FILE, real, en_b, o_b])

    # resultado de cada .xarc (para o hash de conferência): aplica as edições no inglês
    for e in entries:
        if e[0] != P.KIND_XARC:
            continue
        ent = P.Entry()
        ent.kind, ent.path = P.KIND_XARC, e[1]
        ent.sha_en, ent.size_en = b"\0" * 20, 0
        ent.sha_out, ent.size_out = b"\0" * 20, 0
        ent.node_count = e[4]
        ent.edits = []
        for (node, t, s, op, aux, co, ck, pay) in e[5]:
            ed = P.Edit()
            ed.node, ed.type, ed.sub, ed.op, ed.aux, ed.crc_orig, ed.crc_keep, ed.payload = node, t, s, op, aux, co, ck, pay
            ent.edits.append(ed)
        res, _st, _o = P.apply_xarc(e[2], ent)
        erro = conferir(e[2], res, origem[e[1]][1])
        if erro:
            raise SystemExit("ERRO em %s: %s" % (e[1], erro))
        e[3] = res

    out = io.BytesIO(); w = out.write
    s16 = lambda s: w(struct.pack("<H", len(s.encode("utf-8"))) + s.encode("utf-8"))
    w(P.MAGIC); s16(a.versao); s16(a.titulo); w(struct.pack("<I", len(entries)))
    for e in entries:
        if e[0] == P.KIND_XARC:
            _, rel, en_buf, res, nc, ed = e
            w(struct.pack("<B", P.KIND_XARC)); s16(rel)
            w(sha(en_buf)); w(struct.pack("<I", len(en_buf))); w(sha(res)); w(struct.pack("<I", len(res)))
            w(struct.pack("<II", nc, len(ed)))
            for (node, t, s, op, aux, co, ck, pay) in ed:
                w(struct.pack("<IBBBIII", node, t, s, op, aux, co, ck)); w(struct.pack("<I", len(pay)) + pay)
        else:
            _, rel, en_b, o_b = e
            w(struct.pack("<B", P.KIND_FILE)); s16(rel)
            w(sha(en_b) if en_b else b"\x00" * 20); w(sha(o_b)); w(struct.pack("<I", len(o_b)) + o_b)
    with open(a.saida, "wb") as f:
        f.write(out.getvalue())

    # confere lendo o arquivo gravado, como o instalador faz
    _, _, pe = P.read_patch(a.saida)
    alvo = {e[1]: (e[2], e[3] if e[0] == P.KIND_XARC else e[3]) for e in entries}
    for e in pe:
        en_b, esperado = alvo[e.path]
        res, st, _ = P.apply_entry(en_b if en_b else None, e)
        if res != esperado or (e.kind == P.KIND_XARC and st != "original"):
            raise SystemExit("ERRO: aplicar o patch em %s não dá o resultado esperado (%s)" % (e.path, st))
    avisar("OK: %s (%d bytes) - %d arquivos (.xarc: %d, inteiros: %d), conferido nó por nó"
           % (a.saida, os.path.getsize(a.saida), len(pe), sum(1 for e in pe if e.kind == P.KIND_XARC),
              sum(1 for e in pe if e.kind == P.KIND_FILE)))
    avisar("   falas: %d | outros nós (nomes, sincronia labial, imagens...): %d | arquivos internos: %d"
           % (tot["falas"], tot["outros_nos"], tot["internos"]))
    avisar("   .xarc iguais nas duas versões: %d | nós só no inglês (mantidos): %d | nós só na outra (ignorados): %d"
           % (tot["iguais"], tot["so_en"], tot["so_outra"]))
    if so_en_arqs:
        avisar("   .xarc que só existem no inglês (ficam como estão): %s" % ", ".join(so_en_arqs))
    tot["arquivos"] = len(pe)
    return tot


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--en", required=True, help="pasta do jogo em inglês (original, sem tradução)")
    ap.add_argument("--outra", required=True, help="pasta da outra versão (ex.: a polonesa)")
    ap.add_argument("--versao", required=True)
    ap.add_argument("--titulo", required=True)
    ap.add_argument("--saida", required=True)
    ap.add_argument("--sem-fontes", action="store_true", help="não levar as fontes da outra versão")
    a = ap.parse_args()
    gerar(a.en, a.outra, a.saida, a.versao, a.titulo, a.sem_fontes)


if __name__ == "__main__":
    main()
