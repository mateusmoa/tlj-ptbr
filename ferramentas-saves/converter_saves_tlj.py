#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Conversor de saves do The Longest Journey: jogo original (game.exe) -> ScummVM.

O jogo original grava SaveNN.tlj (+ SaveNN.tga e Index.dat) em
%APPDATA%\\The Longest Journey\\Save\\01. O ScummVM grava tlj-win-NNN.tlj na pasta de saves dele.
Os dois usam a mesma ideia (o estado de cada recurso do jogo), mas o formato é diferente,
então o ScummVM não abre os saves do jogo original. Este script reescreve cada save no formato
do ScummVM (versão 12, que o ScummVM 2.x abre), usando os arquivos do jogo para saber a
estrutura de cada fase.

Uso:
  python converter_saves_tlj.py [PASTA_DO_JOGO] [SAVE_OU_PASTA ...] [--saida PASTA] [--id tlj-win] [--pasta-scummvm PASTA]

  PASTA_DO_JOGO   pasta onde está o x.xarc (a mesma que o ScummVM usa para o jogo); sem ela, usa a pasta
                  do script (ou a de cima), se o x.xarc estiver lá
  SAVE_OU_PASTA   arquivos SaveNN.tlj ou a pasta deles (padrão: %APPDATA%\\The Longest Journey\\Save\\01)
  --saida         onde gravar os tlj-win-NNN.tlj (padrão: pasta "saves_convertidos_scummvm" ao lado do script)
  --id            ID do jogo no ScummVM (padrão tlj-win)
  --pasta-scummvm pasta de saves do ScummVM (padrão: %APPDATA%\\ScummVM\\Saved games). Os convertidos ficam
                  em sequência, começando uma página (9 slots) vazia depois do seu último save do ScummVM

Nada é apagado nem sobrescrito: se o arquivo de destino já existir, o save é pulado.
"""
import argparse
import datetime
import gzip
import math
import os
import re
import shutil
import struct
import sys

VERSAO = '1.0'
SAVE_VERSION = 12          # versão do formato do ScummVM gravada (o ScummVM 2.x lê da 6 à 13)
THUMB_W, THUMB_H = 160, 92

# ------------------------------------------------------------------ leitura/escrita binária


class Leitor:
    def __init__(self, b, o=0):
        self.b, self.o = b, o

    def _un(self, fmt, n):
        v = struct.unpack_from(fmt, self.b, self.o)[0]
        self.o += n
        return v

    def u8(self): return self._un('<B', 1)
    def u16(self): return self._un('<H', 2)
    def u32(self): return self._un('<I', 4)
    def i32(self): return self._un('<i', 4)
    def f32(self): return self._un('<f', 4)

    def raw(self, n):
        if self.o + n > len(self.b):
            raise ValueError('fim inesperado dos dados')
        v = self.b[self.o:self.o + n]
        self.o += n
        return v

    def str32(self): return self.raw(self.u32())

    def ref(self):
        n = self.u32()
        if n > 64:
            raise ValueError('referência inválida')
        out = []
        for _ in range(n):
            t = self.u8()
            out.append((t, self.u16()))
        return out

    def fim(self): return self.o >= len(self.b)


class Escritor:
    def __init__(self):
        self.b = bytearray()

    def u8(self, v): self.b += struct.pack('<B', v & 0xff)
    def u16(self, v): self.b += struct.pack('<H', v & 0xffff)
    def u16be(self, v): self.b += struct.pack('>H', v & 0xffff)
    def u32(self, v): self.b += struct.pack('<I', v & 0xffffffff)
    def i32(self, v): self.b += struct.pack('<i', v)
    def f32(self, v): self.b += struct.pack('<f', v)
    def raw(self, v): self.b += v

    def str32(self, v):
        self.u32(len(v))
        self.b += v

    def ref(self, path):
        self.u32(len(path))
        for t, i in path:
            self.u8(t)
            self.u16(i)


# ------------------------------------------------------------------ arquivos do jogo (.xarc / .xrc)

def ci(root, rel):
    """caminho sem diferenciar maiúsculas (o jogo é do Windows)"""
    cur = root
    for p in rel.replace('\\', '/').split('/'):
        if not p:
            continue
        try:
            names = os.listdir(cur)
        except OSError:
            return None
        hit = [n for n in names if n.lower() == p.lower()]
        if not hit:
            return None
        cur = os.path.join(cur, hit[0])
    return cur


def xrc_do_xarc(buf):
    u32 = lambda o: struct.unpack_from('<I', buf, o)[0]
    count, pos = u32(4), u32(8)
    o = 12
    for _ in range(count):
        e = buf.index(b'\0', o)
        name = buf[o:e]
        o = e + 1
        ln = u32(o)
        o += 8
        if name.lower().endswith(b'.xrc'):
            return buf[pos:pos + ln]
        pos += ln
    raise ValueError('arquivo .xarc sem .xrc')


def ler_xrc(xrc):
    u16 = lambda o: struct.unpack_from('<H', xrc, o)[0]
    u32 = lambda o: struct.unpack_from('<I', xrc, o)[0]
    nodes, o, pilha = [], 0, [[1, -1]]
    while pilha:
        if pilha[-1][0] == 0:
            pilha.pop()
            continue
        pilha[-1][0] -= 1
        pai = pilha[-1][1]
        t, s, idx = xrc[o], xrc[o + 1], u16(o + 2)
        nl = u16(o + 4)
        name = xrc[o + 6:o + 6 + nl]
        do = o + 6 + nl
        dl = u32(do)
        data = xrc[do + 4:do + 4 + dl]
        o = do + 4 + dl
        nch = u16(o)
        o += 4
        n = {'t': t, 's': s, 'idx': idx, 'name': name, 'data': data, 'parent': pai, 'kids': [], 'i': len(nodes)}
        nodes.append(n)
        if pai >= 0:
            nodes[pai]['kids'].append(n['i'])
        pilha.append([nch, n['i']])
    return nodes


def percurso(nodes):
    """ordem em que o ScummVM grava/lê os recursos: pai antes dos filhos, filhos na ordem do arquivo"""
    out, pilha = [], [0]
    while pilha:
        i = pilha.pop()
        out.append(nodes[i])
        pilha.extend(reversed(nodes[i]['kids']))
    return out


class Jogo:
    def __init__(self, root):
        self.root = root
        if not ci(root, 'x.xarc'):
            raise SystemExit('Não achei o x.xarc em "%s". Indique a pasta do jogo (onde ficam x.xarc e chapters.ini).' % root)
        self._cache = {}
        self.raiz = self._xrc('x.xarc')
        self.levels = [n for n in self.raiz if n['t'] == 2]

    def _xrc(self, rel):
        key = rel.lower()
        if key not in self._cache:
            p = ci(self.root, rel)
            if not p:
                raise KeyError(rel)
            with open(p, 'rb') as f:
                self._cache[key] = ler_xrc(xrc_do_xarc(f.read()))
        return self._cache[key]

    def global_level(self):
        return [lv for lv in self.levels if lv['s'] == 1][0]

    def level_por_indice(self, idx):
        if idx == 0:
            return self.global_level()
        for lv in self.levels:
            if lv['idx'] == idx and lv['s'] == 2:
                return lv
        return None

    def arvore_level(self, lv):
        if lv['s'] == 1:
            nome = lv['name'].decode('cp1252')
            return self._xrc('%s/%s.xarc' % (nome, nome))
        return self._xrc('%02x/%02x.xarc' % (lv['idx'], lv['idx']))

    def arvore_location(self, lv, loc_idx):
        return self._xrc('%02x/%02x/%02x.xarc' % (lv['idx'], loc_idx, loc_idx))

    def locations(self, lv):
        return [n for n in self.arvore_level(lv) if n['t'] == 3]

    def chave(self, chave, lvl, loc):
        """(nodes, índice do level) da árvore salva com essa chave"""
        if chave in (b'Global', b'CurrentGlobal'):
            return self.arvore_level(self.global_level()), 0
        if chave == b'Current':
            return self.arvore_level(self.level_por_indice(lvl)), lvl
        if chave == b'CurrentCurrent':
            return self.arvore_location(self.level_por_indice(lvl), loc), lvl
        for lv in self.levels:
            if lv['name'] == chave:
                return self.arvore_level(lv), lv['idx']
        for lv in sorted(self.levels, key=lambda x: -len(x['name'])):
            if lv['s'] == 2 and chave.startswith(lv['name']):
                resto = chave[len(lv['name']):]
                for l in self.locations(lv):
                    if l['name'] == resto:
                        return self.arvore_location(lv, l['idx']), lv['idx']
        raise KeyError(chave)

    def nome_location(self, lvl, loc):
        lv = self.level_por_indice(lvl)
        try:
            ln = self.arvore_location(lv, loc)[0]['name']
        except Exception:
            ln = b'?'
        return '%s / %s' % (lv['name'].decode('cp1252'), ln.decode('cp1252'))

    def personagens(self):
        """nomes dos personagens (os mesmos que o ScummVM usa no registro de conversas)"""
        g = self.arvore_level(self.global_level())
        for n in g:
            if n['t'] == 20 and n['s'] == 3:
                return {g[k]['idx']: g[k]['name'] for k in n['kids'] if g[k]['t'] == 21}
        return {}

    def itens_inventario(self):
        """o jogo original guarda a ordem do inventário pela posição do item; o ScummVM, pelo índice"""
        g = self.arvore_level(self.global_level())
        for n in g:
            if n['t'] == 20 and n['s'] == 1:
                return [g[k]['idx'] for k in n['kids'] if g[k]['t'] == 8]
        return []

    def comandos(self, nodes, subtipo):
        for n in nodes:
            if n['t'] == 22 and n['s'] == subtipo:
                yield n, args_comando(n['data'])


def args_comando(data):
    r = Leitor(data)
    out = []
    for _ in range(r.u32()):
        t = r.u32()
        if t == 0:
            out.append(0)
        elif t in (1, 2):
            out.append(r.i32())
        elif t == 3:
            out.append(r.ref())
        elif t == 4:
            n = r.u16()
            out.append(r.raw(n))
        else:
            raise ValueError('argumento %d' % t)
    return out


def caminho(nodes, i, level_idx):
    """referência (tipo, índice) do recurso, do Level até ele, como o ScummVM monta"""
    out = []
    n = nodes[i]
    while True:
        if n['t'] == 1:
            break
        out.append((n['t'], n['idx']))
        if n['parent'] < 0:
            if n['t'] == 3:
                out.append((2, level_idx))
            break
        n = nodes[n['parent']]
    return list(reversed(out))


# ------------------------------------------------------------------ AnimHierarchy padrão de itens desligados

class Resolvedor:
    def __init__(self, jogo, indices_template):
        self.J = jogo
        self.idx_tpl = indices_template

    def resolver(self, path):
        if not path or path[0][0] != 2:
            return None
        lv_idx = path[0][1]
        lv = self.J.level_por_indice(lv_idx)
        if not lv:
            return None
        nodes, cur = self.J.arvore_level(lv), 0
        for t, i in path[1:]:
            if t == 3:
                try:
                    nodes, cur = self.J.arvore_location(lv, i), 0
                except Exception:
                    return None
                continue
            hit = [k for k in nodes[cur]['kids'] if nodes[k]['t'] == t and nodes[k]['idx'] == i]
            if not hit:
                return None
            cur = hit[0]
        return nodes, cur, lv_idx

    def _stock(self, nodes, i, lv_idx, prof=0):
        n = nodes[i]
        if prof > 4 or n['t'] != 8:
            return None
        idx = self.idx_tpl.get((lv_idx, n['idx']), -1)
        if n['s'] == 3:
            ref = Leitor(n['data'], 8).ref() if len(n['data']) >= 12 else []
            alvo = self.resolver(ref) if ref else None
            if idx == -1 and not alvo:
                idx = 0
            if idx == -1:
                return self._stock(alvo[0], alvo[1], alvo[2], prof + 1)
        elif n['s'] != 1:
            return None
        if idx == -1:
            return None
        hit = [k for k in n['kids'] if nodes[k]['t'] == 10 and nodes[k]['idx'] == idx]
        return caminho(nodes, hit[0], lv_idx) if hit else None

    def anim_padrao(self, nodes, i, lv_idx):
        n = nodes[i]
        if n['s'] == 10 and len(n['data']) >= 16:
            ref = Leitor(n['data'], 12).ref()
            if ref:
                alvo = self.resolver(ref)
                if alvo:
                    s = self._stock(*alvo)
                    if s:
                        return s
        own = [k for k in n['kids'] if nodes[k]['t'] == 10]
        return caminho(nodes, own[0], lv_idx) if own else []


# ------------------------------------------------------------------ piso (arestas bloqueadas)

ORDEM_SCUMMVM = ((2, 0), (0, 1), (1, 2))
ORDEM_NATIVA = ((0, 1), (1, 2), (2, 0))


def arestas(faces, ordem):
    out, vistos = [], set()
    for f in faces:
        if f == (0, 0, 0):
            continue
        for a, b in ordem:
            e = (min(f[a], f[b]), max(f[a], f[b]))
            if e not in vistos:
                vistos.add(e)
                out.append(e)
    return out


def converter_piso(nodes, floor_i, nat_bytes):
    """O jogo original guarda 1 byte por aresta (1 = passagem entre duas faces bloqueada), na ordem dele;
    o ScummVM guarda 'enabled' (u32) por aresta, e as arestas da borda seguem o estado da face."""
    fl = nodes[floor_i]
    faces = [struct.unpack_from('<3h', nodes[k]['data'], 0) for k in fl['kids'] if nodes[k]['t'] == 7]
    nat = arestas(faces, ORDEM_NATIVA)
    if len(nat) != len(nat_bytes):
        raise ValueError('piso com %d arestas, save com %d' % (len(nat), len(nat_bytes)))
    nb = dict(zip(nat, nat_bytes))
    ef = {}
    for fi, f in enumerate(faces):
        if f == (0, 0, 0):
            continue
        for x, y in ORDEM_NATIVA:
            ef.setdefault((min(f[x], f[y]), max(f[x], f[y])), []).append(fi)
    internas = {}
    for e, fs in ef.items():
        if len(fs) >= 2:
            for fi in fs:
                internas.setdefault(fi, []).append(e)
    campos = []
    for m in nodes:
        if m['t'] == 18 and len(m['data']) >= 4:
            d = m['data']
            cnt = struct.unpack_from('<I', d, 0)[0]
            campos.append({i for i in range(min(cnt, len(d) - 4)) if d[4 + i]})
    face_off, sem_campo = set(), set(range(len(faces)))
    for campo in campos:
        sem_campo -= campo
        proprias = [e for e, fs in ef.items() if len(fs) >= 2 and all(f in campo for f in fs)]
        base = proprias or [e for f in campo for e in internas.get(f, [])]
        if base and all(nb[e] for e in base):
            face_off |= campo
    for fi in sem_campo:
        es = internas.get(fi)
        if es and all(nb[e] for e in es):
            face_off.add(fi)
    w = Escritor()
    for e in arestas(faces, ORDEM_SCUMMVM):
        fs = ef[e]
        if len(fs) >= 2:
            w.u32(0 if nb[e] else 1)
        else:
            w.u32(0 if fs[0] in face_off else 1)
    return bytes(w.b)


# ------------------------------------------------------------------ save do jogo original

NAT_NORMAL = {4, 6, 8, 9, 11, 14, 21, 23, 27, 30}
NAT_CURRENT = {2, 3, 4, 8, 9, 11, 16, 20, 29, 30, 33, 35}
CURRENT = (b'Current', b'CurrentCurrent', b'CurrentGlobal')


def registros(data):
    r, out = Leitor(data), []
    while not r.fim():
        t, s = r.u8(), r.u8()
        out.append((t, s, r.raw(r.u32())))
    return out


def ler_nativo(data):
    r = Leitor(data)
    h = {'description': r.str32(), 'level': r.str32(), 'location': r.str32(), 'version': r.str32()}
    if not h['version'].startswith(b'Version:\t'):
        raise ValueError('não parece um save do The Longest Journey')
    if h['version'] != b'Version:\t06':
        raise ValueError('versão %r: este conversor lê saves do jogo original (Version 06)' % h['version'])
    h['extra'] = r.str32()
    if len(h['extra']) > 8 or not h['extra'].isdigit():
        raise ValueError('não parece um save do jogo original (se for do ScummVM, ele já abre direto)')
    h['trees'] = []
    for _ in range(r.u32()):
        k = r.str32()
        h['trees'].append((k, r.raw(r.u32())))
    d = {'entries': [r.str32() for _ in range(r.u32())]}
    d['fmv'] = []
    for _ in range(r.u32()):
        d['fmv'].append((r.str32(), r.str32(), r.u32()))
    d['conv'] = []
    for _ in range(r.u32()):
        e = {'chapter': r.i32(), 'name': r.str32(), 'char': r.i32(), 'title': r.str32(), 'lines': []}
        for _ in range(r.u32()):
            c = r.i32()
            e['lines'].append((r.str32(), c))
        d['conv'].append(e)
    d['unread'] = r.u8()
    d['page'] = r.u32()
    h['diary'] = d
    return h


def casar(nodes, recs, current):
    tipos = NAT_CURRENT if current else NAT_NORMAL
    out, j = [], 0
    for n in nodes:
        if n['t'] in tipos:
            if j >= len(recs):
                raise ValueError('faltam registros no save para "%s"' % n['name'].decode('cp1252'))
            t, s, b = recs[j]
            j += 1
            if (t, s) != (n['t'], n['s']):
                raise ValueError('save não bate com os arquivos do jogo (recurso "%s")' % n['name'].decode('cp1252'))
            out.append(b)
        else:
            out.append(None)
    if j != len(recs):
        raise ValueError('o save tem %d registros a mais que os arquivos do jogo' % (len(recs) - j))
    return out


# ------------------------------------------------------------------ conversão dos registros

def angulo_da_direcao(x, y):
    """o jogo original guarda a direção como vetor; o ScummVM, como ângulo (vetor = cos a, -sin a)"""
    if abs(x) < 1e-9 and abs(y) < 1e-9:
        return 0.0
    a = math.degrees(math.atan2(-y, x))
    return a + 360.0 if a < 0 else a + 0.0   # + 0.0: nunca -0


class Conversor:
    def __init__(self, jogo, nat, avisos):
        self.J = jogo
        self.nat = nat
        self.avisos = avisos
        self.lvl = int(nat['level'], 16)
        self.loc = int(nat['location'], 16)
        self.trees = dict(nat['trees'])
        self.parados = set()        # itens cujo movimento não deu para converter
        self._preparar()

    def _alinhado(self, chave):
        nodes, lv_idx = self.J.chave(chave, self.lvl, self.loc)
        ordem = percurso(nodes)
        return nodes, lv_idx, ordem, casar(ordem, registros(self.trees[chave]), chave in CURRENT)

    def _preparar(self):
        # inventário e índices de AnimHierarchy dos templates ficam nas árvores "Current" do jogo original
        self.inventario = []
        idx_tpl = {}
        for chave, lv_i in ((b'CurrentGlobal', 0), (b'Current', self.lvl)):
            if chave not in self.trees:
                continue
            nodes, _, ordem, recs = self._alinhado(chave)
            for n, b in zip(ordem, recs):
                if b is None:
                    continue
                if n['t'] == 8 and n['s'] in (1, 3) and len(b) >= 20 and b[:4] == b'\0\0\0\0':
                    idx_tpl[(lv_i, n['idx'])] = struct.unpack_from('<i', b, 16)[0]
                if chave == b'CurrentGlobal' and n['t'] == 20 and n['s'] == 1 and len(b) >= 4:
                    cnt = struct.unpack_from('<I', b, 0)[0]
                    self.inventario = list(struct.unpack_from('<%dI' % cnt, b, 4))
        self.R = Resolvedor(self.J, idx_tpl)
        # movimentos que não dá para converter: os scripts que esperam por eles seguem em frente
        if b'CurrentCurrent' in self.trees:
            nodes, lv_idx, ordem, recs = self._alinhado(b'CurrentCurrent')
            for n, b in zip(ordem, recs):
                if b is not None and n['t'] == 8 and len(b) >= 8 and b[:4] == b'\x01\0\0\0':
                    if struct.unpack_from('<I', b, 4)[0] not in (1, 3):
                        self.parados.add(tuple(caminho(nodes, n['i'], lv_idx)))

    # ---- árvores normais (estado de cada fase)
    def normal(self, nodes, n, b, lv_idx):
        t, s = n['t'], n['s']
        w = Escritor()
        if t == 8:
            r = Leitor(b)
            en = r.u8()
            if s in (1, 3):
                w.i32(en)
                return w.b
            atividade = r.i32()
            if en:
                anim, acao = r.ref(), r.ref()
            else:
                anim, acao = self.R.anim_padrao(nodes, n['i'], lv_idx), []
            w.i32(en)
            w.i32(atividade)
            w.ref(anim)
            w.ref(acao)
            if s in (5, 6, 10):
                pos = (r.f32(), r.f32(), r.f32())
                dx, dy, _dz = r.f32(), r.f32(), r.f32()
                face = r.i32()
                for v in pos:
                    w.f32(v)
                w.f32(angulo_da_direcao(dx, dy))
                w.i32(face)
            return w.b
        if t == 9:
            w.i32(b[0])
            return w.b
        if t == 21:
            if s in (0, 5):
                w.i32(0)
                w.i32(struct.unpack_from('<i', b, 0)[0] if b else 0)
                w.ref([])
            elif s in (2, 3):
                w.i32(struct.unpack_from('<i', b, 0)[0] if b else 0)
                w.i32(0)
                w.ref([])
            elif s == 4:
                w.i32(0)
                w.i32(0)
                w.ref(Leitor(b).ref() if b else [])
            else:
                w.i32(0)
                w.i32(0)
                w.ref([])
            return w.b
        if t == 6:
            return converter_piso(nodes, n['i'], b)
        if t == 20:
            if s == 1:
                itens = self.J.itens_inventario()
                ordem = []
                for v in self.inventario:
                    if v < len(itens):
                        ordem.append(itens[v])
                    else:
                        self.avisos.append('item %d do inventário desconhecido (ignorado)' % v)
                w.u32(len(ordem))
                for v in ordem:
                    w.u16(v)
            return w.b
        if t in (4, 11, 14, 23, 27, 30) and b is not None:
            return b
        return b''

    # ---- árvores "Current" (estado do momento: sons, scripts em andamento, câmera...)
    def atual(self, nodes, n, b, lv_idx, raiz_atual):
        t, s = n['t'], n['s']
        w = Escritor()
        if t == 3:
            return self._location(n, b, raiz_atual)
        if t == 8:
            return self._item_atual(nodes, n, b, lv_idx)
        if t == 9:
            return self._script_atual(b)
        if t == 11:
            if s == 3 and len(b) >= 12:
                _x, quadro, refs = struct.unpack_from('<iii', b, 0)
                w.i32(quadro)
                w.i32(refs)
                return w.b
            return b
        if t == 16:
            r = Leitor(b)
            r.u32()
            tocando = r.u32()
            w.u32(tocando)
            if len(b) >= 36 and tocando and s != 3:
                w.u32(r.u32())          # tempo
                w.f32(r.f32())          # volume
                w.f32(r.f32())          # pan
                w.u32(r.u32())          # fade restante
                w.f32(r.f32())          # volume alvo
                w.f32(r.f32())          # pan alvo
            return w.b
        if t == 29:
            if b[:4] != b'\0\0\0\0':
                self.avisos.append('uma fala estava tocando na hora do save; ela não continua no ScummVM')
                w.u32(0)
                return w.b
            return b
        if t in (4, 30, 33, 35) and b is not None:
            return b
        return b''

    def _location(self, n, b, raiz_atual):
        w = Escritor()
        if not raiz_atual:
            w.raw(b'\0' * 44)
            return w.b
        r = Leitor(b)
        sx, sy = r.i32(), r.i32()
        f = [r.u32() for _ in range(13)]
        flo = lambda v: struct.unpack('<f', struct.pack('<I', v))[0]
        w.i32(sx)
        w.i32(sy)
        w.ref([])
        periodo = struct.unpack('<i', struct.pack('<I', f[5]))[0]
        balanco = periodo > 0
        flutua = None
        angulo = 0.0
        if balanco:
            # o ângulo do balanço e a flutuação vêm do comando do script da própria location
            nodes = self.J.arvore_location(self.J.level_por_indice(self.lvl), self.loc)
            for _n, a in self.J.comandos(nodes, 21):
                if len(a) >= 5:
                    angulo = float(abs(a[2]) % 360)
            for _n, a in self.J.comandos(nodes, 25):
                if len(a) >= 4:
                    p = a[1] if a[1] >= 33 else 1000
                    flutua = (p, a[2] / 10.0, a[3] / 100.0)
        if flutua:
            w.i32(flutua[0])
            w.f32(flutua[1])
            w.f32(flutua[2])
        else:
            w.i32(0)
            w.f32(0.0)
            w.f32(0.0)
        if balanco:
            w.i32(periodo)
            w.f32(flo(f[9]))            # amplitude
            w.f32(flo(f[10]))           # deslocamento
            w.f32(flo(f[11]))           # posição no ciclo
            w.f32(angulo)
        else:
            w.raw(b'\0' * 20)
        return w.b

    def _script_atual(self, b):
        r = Leitor(b)
        iniciado = r.u32()
        w = Escritor()
        w.u32(iniciado)
        if not iniciado:
            return w.b
        w.ref(r.ref())
        retornos = [r.ref() for _ in range(r.u32())]
        w.u32(len(retornos))
        for x in retornos:
            w.ref(x)
        w.i32(r.i32())
        espera = r.ref()
        w.ref(espera)
        status = r.i32()
        if status not in (0, 1, 2):
            status = 0 if tuple(espera) in self.parados else 2
        w.i32(status)
        return w.b

    def _item_atual(self, nodes, n, b, lv_idx):
        r = Leitor(b)
        mov = r.u32()
        if not mov:
            return b
        tipo = r.u32()
        w = Escritor()
        try:
            r.u32()
            if tipo == 1:                       # andando até um ponto
                dest = (r.f32(), r.f32(), r.f32())
                r.u32()
                correndo = r.u8()
                script = r.ref() if r.u32() else []
                w.u32(1)
                w.u32(1)
                for v in dest:
                    w.f32(v)
                w.u32(correndo)
                w.ref(script)
            elif tipo == 3:                     # luz seguindo um caminho
                path, _item, luz = r.ref(), r.ref(), r.ref()
                r.u32()
                r.u32()
                pos = r.f32()
                r.f32()
                r.f32()
                vel = r.f32()
                antes = r.u32()
                script = r.ref() if r.u32() else []
                w.u32(1)
                w.u32(3)
                w.ref(path)
                w.ref(luz)
                w.f32(pos)
                w.f32(vel)
                w.u32(antes)
                w.ref(script)
            else:
                raise ValueError('movimento %d' % tipo)
            w.raw(b[r.o:])
            return w.b
        except ValueError:
            self.avisos.append('"%s" estava em movimento (tipo %d) e para no lugar ao carregar'
                               % (n['name'].decode('cp1252'), tipo))
            resto = self._resto_visual(b, n['s'])
            w = Escritor()
            w.u32(0)
            w.raw(resto)
            return w.b

    @staticmethod
    def _resto_visual(b, sub):
        """acha, do fim para o começo, onde começa a parte comum (atividade + 2 referências [+ 3 índices])"""
        extra = 12 if sub == 10 else (16 if sub in (1, 3) else 0)
        for o in range(len(b) - 12 - extra, 3, -1):
            try:
                r = Leitor(b, o)
                if sub in (1, 3):
                    r.raw(16)
                else:
                    r.i32()
                    r.ref()
                    r.ref()
                    r.raw(extra)
                if r.o == len(b):
                    return b[o:]
            except (ValueError, struct.error):
                continue
        raise ValueError('não consegui separar o movimento do item')

    # ---- árvore inteira
    def arvore(self, chave):
        nodes, lv_idx, ordem, recs = self._alinhado(chave)
        current = chave in CURRENT
        w = Escritor()
        for n, b in zip(ordem, recs):
            if current:
                d = self.atual(nodes, n, b, lv_idx, chave == b'CurrentCurrent' and n['i'] == 0) if b is not None else b''
                if n['t'] in (2, 20):
                    d = b''
            else:
                d = self.normal(nodes, n, b, lv_idx)
            w.u8(n['t'])
            w.u8(n['s'])
            w.u32(len(d))
            w.raw(bytes(d))
        return bytes(w.b)

    # ---- pilha de locations (para voltar de um close-up 2D)
    def pilha(self):
        lv = self.J.level_por_indice(self.lvl)
        nodes = self.J.arvore_location(lv, self.loc)
        if any(n['t'] == 4 and n['s'] == 2 for n in nodes):
            return []
        origens = []
        for l in self.J.levels:
            arvs = []
            try:
                arvs.append((None, self.J.arvore_level(l)))
            except Exception:
                pass
            if l['s'] == 2:
                for loc in self.J.locations(l):
                    try:
                        arvs.append((loc, self.J.arvore_location(l, loc['idx'])))
                    except Exception:
                        pass
            for loc, arv in arvs:
                for _n, a in self.J.comandos(arv, 17):
                    try:
                        alvo = (int(a[0], 16), int(a[1], 16))
                    except (ValueError, TypeError, IndexError):
                        continue
                    if alvo == (self.lvl, self.loc) and loc is not None:
                        origens.append((l, loc))
        if not origens:
            return []
        visitadas = [o for o in origens if o[0]['name'] + o[1]['name'] in self.trees]
        l, loc = (visitadas or origens)[0]
        if len(origens) > 1:
            self.avisos.append('save dentro de um mapa/close-up: ao sair, volta para %s / %s'
                               % (l['name'].decode('cp1252'), loc['name'].decode('cp1252')))
        return [(l['idx'], loc['idx'], 0)]


# ------------------------------------------------------------------ miniatura e Index.dat

def ler_tga(path):
    """TGA 24/32 bits sem compressão -> pixels RGBA de cima para baixo (160x92)"""
    try:
        with open(path, 'rb') as f:
            d = f.read()
        idl, cmap, tipo = d[0], d[1], d[2]
        w, h = struct.unpack_from('<HH', d, 12)
        bpp, desc = d[16], d[17]
        if tipo != 2 or cmap or bpp not in (24, 32):
            return None
        o = 18 + idl
        bp = bpp // 8
        linhas = []
        for y in range(h):
            linha = d[o + y * w * bp:o + (y + 1) * w * bp]
            px = bytearray()
            for x in range(w):
                b_, g_, r_ = linha[x * bp], linha[x * bp + 1], linha[x * bp + 2]
                px += bytes((r_, g_, b_, 255))
            linhas.append(bytes(px))
        if not desc & 0x20:
            linhas.reverse()
        if (w, h) != (THUMB_W, THUMB_H):
            # redimensiona (vizinho mais próximo)
            out = []
            for y in range(THUMB_H):
                src = linhas[y * h // THUMB_H]
                out.append(b''.join(src[(x * w // THUMB_W) * 4:(x * w // THUMB_W) * 4 + 4] for x in range(THUMB_W)))
            linhas = out
        return b''.join(linhas)
    except Exception:
        return None


def ler_index(pasta):
    """Index.dat do jogo original: uma linha por slot, "Nome<TAB>HH:MM:SS MM/DD/AA" """
    p = ci(pasta, 'Index.dat')
    out = {}
    if not p:
        return out
    with open(p, 'rb') as f:
        linhas = f.read().split(b'\r\n')
    for i, l in enumerate(linhas[2:]):
        l = l.strip(b'\r\n')
        if not l:
            continue
        nome, _, quando = l.partition(b'\t')
        m = re.match(rb'(\d+):(\d+):(\d+) (\d+)/(\d+)/(\d+)', quando.strip())
        dt = None
        if m:
            hh, mi, ss, mm, dd, aa = (int(x) for x in m.groups())
            try:
                dt = datetime.datetime(2000 + aa if aa < 70 else 1900 + aa, mm, dd, hh, mi, ss)
            except ValueError:
                dt = None
        out[i] = (nome, dt)
    return out


# ------------------------------------------------------------------ gravação no formato do ScummVM

def montar_scummvm(desc, lvl, loc, quando, thumb, arvores, diario, pilha):
    w = Escritor()
    w.str32(desc)
    w.str32(b'%02x' % lvl)
    w.str32(b'%02x' % loc)
    w.str32(b'Version:\t%02d' % SAVE_VERSION)
    w.u8(quando.day)
    w.u8(quando.month)
    w.u16be(quando.year)
    w.u8(quando.hour)
    w.u8(quando.minute)
    w.i32(0)                     # tempo de jogo: o jogo original não guarda
    w.u8(quando.second)
    w.raw(thumb or bytes(THUMB_W * THUMB_H * 4))
    w.u32(len(arvores))
    for k, d in arvores:
        w.str32(k)
        w.u32(SAVE_VERSION)
        w.str32(d)
    w.u32(len(diario['entries']))
    for e in diario['entries']:
        w.str32(e)
    w.u32(len(diario['fmv']))
    for fn, titulo, disco in diario['fmv']:
        w.str32(fn)
        w.str32(titulo)
        w.u32(disco)
    w.u32(len(diario['conv']))
    for c in diario['conv']:
        w.i32(c['chapter'])
        w.i32(c['char'])
        w.str32(c['name'])
        w.str32(c['title'])
        w.u32(len(c['lines']))
        for linha, ch in c['lines']:
            w.str32(linha)
            w.i32(ch)
    w.u8(diario['unread'])
    w.u32(diario['page'])
    w.u32(len(pilha))
    for lv, lc, inv in pilha:
        w.u16(lv)
        w.u16(lc)
        w.u32(inv)
    return bytes(w.b)


def conferir_scummvm(data, jogo):
    """relê o arquivo gerado como o ScummVM lê e confere cada árvore com os arquivos do jogo"""
    r = Leitor(data)
    r.str32()
    lvl = int(r.str32(), 16)
    loc = int(r.str32(), 16)
    ver = int(r.str32().split(b'\t')[1])
    r.raw(4 + 2 + 4 + 1 + THUMB_W * THUMB_H * 4)
    for _ in range(r.u32()):
        k = r.str32()
        tv = r.u32()
        d = r.raw(r.u32())
        nodes, _ = jogo.chave(k, lvl, loc)
        ordem = percurso(nodes)
        recs = registros(d)
        if tv != ver or len(recs) != len(ordem) or any((x['t'], x['s']) != y[:2] for x, y in zip(ordem, recs)):
            raise ValueError('árvore %r não confere' % k)
    for _ in range(r.u32()):
        r.str32()
    for _ in range(r.u32()):
        r.str32(); r.str32(); r.u32()
    for _ in range(r.u32()):
        r.i32(); r.i32(); r.str32(); r.str32()
        for _ in range(r.u32()):
            r.str32(); r.i32()
    r.u8(); r.u32()
    for _ in range(r.u32()):
        r.u16(); r.u16(); r.u32()
    if not r.fim():
        raise ValueError('sobraram %d bytes' % (len(data) - r.o))


def converter(jogo, caminho_save, index, avisos):
    with open(caminho_save, 'rb') as f:
        dados = f.read()
    if dados[:2] == b'\x1f\x8b':
        dados = gzip.decompress(dados)
    nat = ler_nativo(dados)
    C = Conversor(jogo, nat, avisos)
    arvores = []
    for k, _ in nat['trees']:
        try:
            arvores.append((k, C.arvore(k)))
        except KeyError:
            avisos.append('fase %r não existe nos arquivos do jogo (ignorada)' % k.decode('cp1252'))
    nomes = jogo.personagens()
    d = nat['diary']
    diario = {'entries': d['entries'], 'unread': d['unread'], 'page': d['page'],
              'fmv': [(re.split(rb'[\\/]', fn)[-1], t, disco) for fn, t, disco in d['fmv']],
              'conv': [dict(c, name=nomes.get(c['char'], c['name'])) for c in d['conv']]}
    m = re.search(r'(?i)save(\d+)\.tlj$', os.path.basename(caminho_save))
    slot = int(m.group(1)) if m else 0
    nome, quando = index.get(slot, (None, None))
    if not quando:
        quando = datetime.datetime.fromtimestamp(os.path.getmtime(caminho_save))
    desc = nome or ('Save %02d' % slot).encode()
    thumb = None
    tga = ci(os.path.dirname(caminho_save) or '.', os.path.splitext(os.path.basename(caminho_save))[0] + '.tga')
    if tga:
        thumb = ler_tga(tga)
    out = montar_scummvm(desc, C.lvl, C.loc, quando, thumb, arvores, diario, C.pilha())
    conferir_scummvm(out, jogo)
    return out, slot, desc, C



# ================================================================== ScummVM -> jogo original
def ler_scummvm(data):
    """lê um save do ScummVM (versões 11 a 13; o conversor precisa dos campos da 11 em diante)"""
    r = Leitor(data)
    h = {'description': r.str32(), 'level': r.str32(), 'location': r.str32(), 'version': r.str32()}
    if not h['version'].startswith(b'Version:\t'):
        raise ValueError('não parece um save do The Longest Journey')
    v = int(h['version'][9:])
    if v == 6:
        raise ValueError('este já parece um save do jogo original (Version 06)')
    if v < 11:
        raise ValueError('save do ScummVM muito antigo (versão %d); abra e salve de novo num ScummVM atual' % v)
    h['ver'] = v
    h['day'], h['month'] = r.u8(), r.u8()
    h['year'] = struct.unpack('>H', r.raw(2))[0]
    h['hour'], h['minute'] = r.u8(), r.u8()
    r.i32()
    h['second'] = r.u8()
    if v >= 13:
        r.u32()
    h['thumb'] = r.raw(THUMB_W * THUMB_H * 4)
    h['trees'] = []
    for _ in range(r.u32()):
        k = r.str32()
        tv = r.u32()
        d = r.str32()
        if tv < 11:
            raise ValueError('a fase %r está gravada num formato antigo do ScummVM (versão %d)' % (k, tv))
        h['trees'].append((k, d))
    d = {'entries': [r.str32() for _ in range(r.u32())], 'fmv': [], 'conv': []}
    for _ in range(r.u32()):
        d['fmv'].append((r.str32(), r.str32(), r.u32()))
    for _ in range(r.u32()):
        e = {'chapter': r.i32(), 'char': r.i32(), 'name': r.str32(), 'title': r.str32(), 'lines': []}
        for _ in range(r.u32()):
            e['lines'].append((r.str32(), r.i32()))
        d['conv'].append(e)
    d['unread'] = r.u8()
    d['page'] = r.u32()
    h['diary'] = d
    return h


def vetor_da_direcao(graus):
    a = math.radians(graus)
    limpa = lambda v: 0.0 if abs(v) < 1e-6 else v
    return limpa(math.cos(a)), limpa(-math.sin(a))


class Reverso:
    def __init__(self, jogo, sv, avisos):
        self.J, self.sv, self.avisos = jogo, sv, avisos
        self.lvl, self.loc = int(sv['level'], 16), int(sv['location'], 16)
        self.trees = dict(sv['trees'])
        self.inventario = []
        if b'Global' in self.trees:
            nodes, _ = self.J.chave(b'Global', self.lvl, self.loc)
            for n, (t, s, b) in zip(percurso(nodes), registros(self.trees[b'Global'])):
                if n['t'] == 20 and n['s'] == 1 and len(b) >= 4:
                    cnt = struct.unpack_from('<I', b, 0)[0]
                    idx = list(struct.unpack_from('<%dH' % cnt, b, 4))
                    itens = self.J.itens_inventario()
                    self.inventario = [itens.index(i) for i in idx if i in itens]

    def normal(self, nodes, n, b):
        t, s = n['t'], n['s']
        w = Escritor()
        if t == 8:
            r = Leitor(b)
            en = r.i32()
            w.u8(1 if en else 0)
            if s in (1, 3):
                return w.b
            w.i32(r.i32())
            anim, acao = r.ref(), r.ref()
            if en:
                w.ref(anim)
                w.ref(acao)
            if s in (5, 6, 10):
                for _ in range(3):
                    w.f32(r.f32())
                x, y = vetor_da_direcao(r.f32())
                w.f32(x); w.f32(y); w.f32(0.0)
                w.i32(r.i32())
            if s == 10:
                w.u8(1)
            return w.b
        if t == 9:
            w.u8(1 if struct.unpack_from('<i', b, 0)[0] else 0)
            return w.b
        if t == 21:
            r = Leitor(b)
            iv, bv = r.i32(), r.i32()
            ref = r.ref()
            if s in (0, 5):
                w.i32(bv)
            elif s in (2, 3):
                w.i32(iv)
            elif s == 4:
                w.ref(ref)
            return w.b
        if t == 6:
            fl = nodes[n['i']]
            faces = [struct.unpack_from('<3h', nodes[k]['data'], 0) for k in fl['kids'] if nodes[k]['t'] == 7]
            sv_edges = arestas(faces, ORDEM_SCUMMVM)
            en = dict(zip(sv_edges, struct.unpack('<%dI' % len(sv_edges), b)))
            ef = {}
            for f in faces:
                if f == (0, 0, 0):
                    continue
                for x, y in ORDEM_NATIVA:
                    e = (min(f[x], f[y]), max(f[x], f[y]))
                    ef[e] = ef.get(e, 0) + 1
            for e in arestas(faces, ORDEM_NATIVA):
                w.u8(1 if ef[e] >= 2 and not en[e] else 0)
            return w.b
        return b                 # 4, 11, 14, 23, 27, 30: mesmo formato

    def atual(self, nodes, n, b, raiz):
        t, s = n['t'], n['s']
        w = Escritor()
        if t == 2:
            return b'\x01\0\0\0\x01\0\0\0' if s == 1 else b''
        if t == 20:
            if s == 1:
                w.u32(len(self.inventario))
                for v in self.inventario:
                    w.u32(v)
            return w.b
        if t == 3:
            r = Leitor(b) if b else None
            sx, sy = (r.i32(), r.i32()) if r else (0, 0)
            if r:
                r.ref()
                fp, fa, fpos = r.i32(), r.f32(), r.f32()
                sp, sa, so, spos, sang = r.i32(), r.f32(), r.f32(), r.f32(), r.f32()
            else:
                sp = 0
            w.i32(sx if raiz else 0); w.i32(sy if raiz else 0); w.u32(0); w.f32(-1.0)
            w.u32(0); w.u32(0); w.u32(0)
            if raiz and sp > 0:
                x, y = vetor_da_direcao(sang)
                w.i32(sp); w.f32(x); w.f32(y); w.u32(0); w.f32(sa); w.f32(so); w.f32(spos); w.u32(0)
            else:
                w.i32(-1); w.raw(b'\0' * 28)
            return w.b
        if t == 8:
            r = Leitor(b)
            if not r.u32():
                return b
            tipo = r.u32()
            try:
                if tipo == 1:
                    dest = (r.f32(), r.f32(), r.f32())
                    correndo = r.u32()
                    script = r.ref()
                    w.u32(1); w.u32(1); w.u32(1)
                    for v in dest:
                        w.f32(v)
                    w.u32(1); w.u8(1 if correndo else 0)
                    w.u32(1 if script else 0)
                    if script:
                        w.ref(script)
                elif tipo == 3:
                    path, luz = r.ref(), r.ref()
                    pos, vel = r.f32(), r.f32()
                    antes = r.u32()
                    script = r.ref()
                    w.u32(1); w.u32(3); w.u32(1)
                    w.ref(path); w.ref(caminho(nodes, n['i'], self._lv)); w.ref(luz)
                    w.u32(0); w.u32(2); w.f32(pos); w.f32(0.0); w.f32(0.0); w.f32(vel); w.u32(antes)
                    w.u32(1 if script else 0)
                    if script:
                        w.ref(script)
                else:
                    raise ValueError('movimento %d' % tipo)
                w.raw(b[r.o:])
                return w.b
            except ValueError:
                self.avisos.append('"%s" estava em movimento e para no lugar ao carregar' % n['name'].decode('cp1252'))
                w = Escritor()
                w.u32(0)
                w.raw(Conversor._resto_visual(b, s))
                return w.b
        if t == 9:
            r = Leitor(b)
            if not r.u32():
                return b'\0\0\0\0'
            w.u32(1)
            w.ref(r.ref())
            ret = [r.ref() for _ in range(r.u32())]
            w.u32(len(ret))
            for x in ret:
                w.ref(x)
            w.i32(r.i32())
            w.ref(r.ref())
            r.i32()
            w.i32(-1)
            return w.b
        if t == 11:
            if s == 3 and len(b) >= 8:
                q, refs = struct.unpack_from('<ii', b, 0)
                w.i32(0); w.i32(q); w.i32(refs)
                return w.b
            return b
        if t == 16:
            r = Leitor(b)
            tocando = r.u32()
            w.u32(0); w.u32(tocando)
            if len(b) >= 28:
                w.raw(b[4:28]); w.u32(0)
            return w.b
        if t == 29:
            if b[:4] != b'\0\0\0\0':
                self.avisos.append('uma fala estava tocando na hora do save; ela não continua no jogo original')
                return b'\0\0\0\0'
            return b
        return b                 # 4, 30, 33, 35: mesmo formato

    def arvore(self, chave):
        nodes, lv_idx = self.J.chave(chave, self.lvl, self.loc)
        self._lv = lv_idx
        ordem = percurso(nodes)
        recs = registros(self.trees[chave])
        if len(recs) != len(ordem) or any((n['t'], n['s']) != r[:2] for n, r in zip(ordem, recs)):
            raise ValueError('o save do ScummVM não bate com os arquivos do jogo na fase %r' % chave.decode('cp1252'))
        current = chave in CURRENT
        tipos = NAT_CURRENT if current else NAT_NORMAL
        w = Escritor()
        for n, (t, s, b) in zip(ordem, recs):
            if t not in tipos:
                continue
            d = self.atual(nodes, n, b, chave == b'CurrentCurrent' and n['i'] == 0) if current else self.normal(nodes, n, b)
            w.u8(t); w.u8(s); w.u32(len(d)); w.raw(bytes(d))
        return bytes(w.b)


def montar_nativo(sv, arvores):
    w = Escritor()
    w.str32(b'Default Savegame')
    w.str32(sv['level'])
    w.str32(sv['location'])
    w.str32(b'Version:\t06')
    w.str32(b'2')
    w.u32(len(arvores))
    for k, d in arvores:
        w.str32(k)
        w.str32(d)
    d = sv['diary']
    w.u32(len(d['entries']))
    for e in d['entries']:
        w.str32(e)
    w.u32(len(d['fmv']))
    for fn, titulo, disco in d['fmv']:
        w.str32(fn if b'\\' in fn else b'global\\xarc\\' + fn)
        w.str32(titulo)
        w.u32(disco)
    w.u32(len(d['conv']))
    for c in d['conv']:
        w.i32(c['chapter'])
        w.str32(c['name'].decode('cp1252').upper().encode('cp1252', 'replace'))
        w.i32(c['char'])
        w.str32(c['title'])
        w.u32(len(c['lines']))
        for linha, ch in c['lines']:
            w.i32(ch)
            w.str32(linha)
    w.u8(d['unread'])
    w.u32(d['page'])
    w.u32(0)
    return bytes(w.b)


def tga_da_miniatura(rgba):
    """miniatura RGBA (de cima para baixo) -> TGA 24 bits de baixo para cima, como o jogo original grava"""
    out = bytearray(struct.pack('<BBBHHBHHHHBB', 0, 0, 2, 0, 0, 0, 0, 0, THUMB_W, THUMB_H, 24, 0))
    for y in range(THUMB_H - 1, -1, -1):
        linha = rgba[y * THUMB_W * 4:(y + 1) * THUMB_W * 4]
        for x in range(THUMB_W):
            r_, g_, b_ = linha[x * 4], linha[x * 4 + 1], linha[x * 4 + 2]
            out += bytes((b_, g_, r_))
    return bytes(out)


def reverter(jogo, caminho_save, avisos):
    """save do ScummVM -> (bytes do SaveNN.tlj, bytes do .tga, descrição, data)"""
    with open(caminho_save, 'rb') as f:
        dados = f.read()
    if dados[:2] == b'\x1f\x8b':
        dados = gzip.decompress(dados)
    sv = ler_scummvm(dados)
    R = Reverso(jogo, sv, avisos)
    arvores = []
    for k, _ in sv['trees']:
        try:
            arvores.append((k, R.arvore(k)))
        except KeyError:
            avisos.append('fase %r não existe nos arquivos do jogo (ignorada)' % k.decode('cp1252'))
    out = montar_nativo(sv, arvores)
    nat = ler_nativo(out)                 # confere: tem que ler e alinhar como um save do jogo original
    for k, d in nat['trees']:
        nodes, _ = jogo.chave(k, R.lvl, R.loc)
        casar(percurso(nodes), registros(d), k in CURRENT)
    quando = datetime.datetime(sv['year'], sv['month'], sv['day'], sv['hour'], sv['minute'], sv['second'])
    return out, tga_da_miniatura(sv['thumb']), sv['description'], quando, R


def gravar_index(pasta, slot, nome, quando):
    """atualiza (ou cria) o Index.dat do jogo original com o nome do save no slot"""
    p = ci(pasta, 'Index.dat') or os.path.join(pasta, 'Index.dat')
    linhas = [b'// The Longest Journey SaveIndex:', b'90']
    if os.path.exists(p):
        with open(p, 'rb') as f:
            linhas = f.read().split(b'\r\n')
        while linhas and linhas[-1] == b'':
            linhas.pop()
    while len(linhas) < 2 + 100:
        linhas.append(b'')
    linhas[2 + slot] = nome + b'\t' + quando.strftime('%H:%M:%S %m/%d/%y').encode()
    with open(p, 'wb') as f:
        f.write(b'\r\n'.join(linhas) + b'\r\n')

def pasta_saves_original():
    base = os.environ.get('APPDATA') or os.path.join(os.path.expanduser('~'), 'AppData', 'Roaming')
    p = os.path.join(base, 'The Longest Journey', 'Save')
    return os.path.join(p, '01') if os.path.isdir(os.path.join(p, '01')) else p


def pasta_saves_scummvm():
    base = os.environ.get('APPDATA') or os.path.join(os.path.expanduser('~'), 'AppData', 'Roaming')
    return os.path.join(base, 'ScummVM', 'Saved games')


# ------------------------------------------------------------------ planejamento (slots, ordem, conflitos)
PARA_SCUMMVM, PARA_ORIGINAL = 'scummvm', 'original'


class Opcoes:
    """todas as escolhas da conversão (o modo simples usa os padrões)"""
    def __init__(self, **kw):
        self.direcao = PARA_SCUMMVM
        self.id = 'tlj-win'              # ID do jogo no ScummVM (os saves são <id>-NNN.tlj)
        self.modo = 'depois'             # depois | ultimo | apartir | mesmo | livre | bloco_primeiro | bloco_ultimo
        self.manter_lacunas = False      # mantém os buracos que havia entre os saves de origem (Save02, Save05 -> base+0, base+3)
        self.paginas_vazias = 1          # modo "depois": páginas vazias entre os seus saves e os convertidos
        self.por_pagina = 9              # saves por página na tela de carregar
        self.inicio_pagina = True        # modo "depois": começar no 1º slot de uma página
        self.slot_inicial = 0            # modo "apartir"
        self.deslocamento = 0            # modo "mesmo": soma ao número de origem
        self.slot_final = None           # não passar deste slot (None = o máximo do formato)
        self.ordem = 'numero'            # numero | data | nome
        self.inverter = False
        self.conflito = 'proximo'        # proximo | pular | sobrescrever
        self.backup = True               # com "sobrescrever": guarda uma cópia do que for substituído
        self.descricao = '{nome}'        # {nome} {slot} {origem} {data} {local}
        self.data = 'original'           # original | agora
        self.atualizar_index = True      # para o jogo original: escreve o nome no Index.dat
        for k, v in kw.items():
            if not hasattr(self, k):
                raise TypeError('opção desconhecida: %s' % k)
            setattr(self, k, v)

    def maximo(self):
        m = 999 if self.direcao == PARA_SCUMMVM else 99
        return m if self.slot_final is None else min(m, self.slot_final)


def slot_de_origem(arq):
    n = os.path.basename(arq)
    m = re.search(r'(?i)save(\d+)\.tlj$', n) or re.search(r'-(\d{3})\.tlj$', n)
    return int(m.group(1)) if m else None


def nome_destino(op, slot):
    return ('%s-%03d.tlj' % (op.id, slot)) if op.direcao == PARA_SCUMMVM else ('Save%02d.tlj' % slot)


def slots_ocupados(pasta, op):
    if not os.path.isdir(pasta):
        return set()
    pad = re.compile(r'(?i)^%s-(\d{3})\.tlj$' % re.escape(op.id)) if op.direcao == PARA_SCUMMVM \
        else re.compile(r'(?i)^save(\d+)\.tlj$')
    return {int(pad.match(n).group(1)) for n in os.listdir(pasta) if pad.match(n)}


def planejar(arquivos, destino, op):
    """[(arquivo, slot ou None, nome de destino ou None, situação)] sem gravar nada"""
    ocup = slots_ocupados(destino, op)
    chave = {'numero': lambda f: (slot_de_origem(f) is None, slot_de_origem(f) or 0, f),
             'data': lambda f: os.path.getmtime(f), 'nome': lambda f: os.path.basename(f).lower()}[op.ordem]
    arqs = sorted(arquivos, key=chave, reverse=op.inverter)
    mx = op.maximo()
    # deslocamento de cada save dentro do grupo convertido
    origens = [slot_de_origem(f) for f in arqs]
    if op.manter_lacunas and op.modo != 'mesmo' and arqs and None not in origens:
        lo, hi = min(origens), max(origens)
        offs = [(hi - o) if op.inverter else (o - lo) for o in origens]
    else:
        offs = None
    tamanho = (max(offs) + 1) if offs else len(arqs)
    if op.modo == 'depois':
        if ocup:
            pag = max(ocup) // op.por_pagina + 1 + op.paginas_vazias
            cursor = pag * op.por_pagina
            if not op.inicio_pagina:
                cursor = max(ocup) + 1 + op.paginas_vazias * op.por_pagina
        else:
            cursor = 0
    elif op.modo == 'ultimo':
        cursor = max(ocup) + 1 if ocup else 0
    elif op.modo == 'apartir':
        cursor = op.slot_inicial
    elif op.modo in ('bloco_primeiro', 'bloco_ultimo'):
        inicios = range(0, mx - tamanho + 2)
        if op.modo == 'bloco_ultimo':
            # o último buraco entre os saves que já existem; se nenhum couber, logo depois do último
            topo = max(ocup) if ocup else 0
            inicios = list(reversed(range(0, max(0, topo - tamanho + 1)))) + [topo + 1 if ocup else 0]
        cursor = next((b for b in inicios if all(b + i not in ocup for i in range(tamanho))), None)
        if cursor is None:
            return [(f, None, None, 'não há %d slots livres seguidos' % tamanho) for f in arqs]
    else:
        cursor = 0
    if op.modo in ('depois', 'ultimo') and cursor + (tamanho if op.modo == 'depois' else 1) - 1 > mx:
        cursor = 0           # não cabe depois dos seus saves (o jogo original só tem 100 slots): usa os livres
    base = cursor
    usados = set()
    plano = []
    for i, f in enumerate(arqs):
        if offs is not None:
            alvo = max(base + offs[i], cursor if op.conflito == 'proximo' else 0)
        elif op.modo == 'mesmo':
            o = slot_de_origem(f)
            alvo = None if o is None else o + op.deslocamento
        else:
            alvo = cursor
        if alvo is None or alvo > mx or alvo < 0:
            plano.append((f, None, None, 'sem slot (limite %d)' % mx))
            continue
        situacao = 'novo'
        if alvo in ocup or alvo in usados:
            if op.conflito == 'pular':
                plano.append((f, alvo, nome_destino(op, alvo), 'pulado: o slot já existe'))
                if op.modo != 'mesmo' and offs is None:
                    cursor = alvo + 1
                continue
            if op.conflito == 'sobrescrever' and alvo not in usados:
                situacao = 'substitui o existente'
            else:
                while alvo <= mx and (alvo in ocup or alvo in usados):
                    alvo += 1
                if alvo > mx:
                    plano.append((f, None, None, 'sem slot livre até %d' % mx))
                    continue
        usados.add(alvo)
        if op.modo != 'mesmo':
            cursor = max(cursor, alvo + 1) if offs is not None else alvo + 1
        plano.append((f, alvo, nome_destino(op, alvo), situacao))
    return plano


def executar(jogo, plano, destino, op, avisar=print):
    """grava o que planejar() decidiu; devolve (convertidos, erros)"""
    os.makedirs(destino, exist_ok=True)
    indices = {}
    feitos = erros = 0
    backup = None
    agora = datetime.datetime.now()
    for f, slot, nome, sit in plano:
        if nome is None or sit.startswith('pulado'):
            avisar('  %-16s %s' % (os.path.basename(f), sit))
            continue
        av = []
        try:
            if op.direcao == PARA_SCUMMVM:
                pasta = os.path.dirname(os.path.abspath(f))
                if pasta not in indices:
                    indices[pasta] = ler_index(pasta)
                dados, _s, desc, C = converter(jogo, f, indices[pasta], av)
                lvl, loc = C.lvl, C.loc
                quando = None
            else:
                dados, tga, desc, quando, R = reverter(jogo, f, av)
                lvl, loc = R.lvl, R.loc
            vars_ = {'nome': desc.decode('cp1252', 'replace'), 'slot': slot, 'origem': os.path.basename(f),
                     'data': (quando or agora).strftime('%d/%m/%Y %H:%M'), 'local': jogo.nome_location(lvl, loc)}
            nova = op.descricao.format(**vars_).encode('cp1252', 'replace')
            alvo = os.path.join(destino, nome)
            if os.path.exists(alvo) and op.backup:
                if backup is None:
                    backup = os.path.join(destino, '_backup_%s' % agora.strftime('%Y%m%d_%H%M%S'))
                    os.makedirs(backup, exist_ok=True)
                    idx = ci(destino, 'Index.dat')
                    if idx and op.direcao == PARA_ORIGINAL:
                        shutil.copy2(idx, backup)
                shutil.copy2(alvo, backup)
                tga_old = alvo[:-4] + '.tga'
                if os.path.exists(tga_old):
                    shutil.copy2(tga_old, backup)
            if op.direcao == PARA_SCUMMVM:
                dados = trocar_descricao(dados, nova, agora if op.data == 'agora' else None)
                with gzip.open(alvo, 'wb') as g:
                    g.write(dados)
            else:
                with open(alvo, 'wb') as g:
                    g.write(dados)
                with open(alvo[:-4] + '.tga', 'wb') as g:
                    g.write(tga)
                if op.atualizar_index:
                    gravar_index(destino, slot, nova, agora if op.data == 'agora' else quando)
            feitos += 1
            avisar('  %-16s -> %-18s "%s"  (%s)' % (os.path.basename(f), nome, nova.decode('cp1252', 'replace'), vars_['local']))
            for a in av:
                avisar('                    obs.: %s' % a)
        except Exception as ex:
            erros += 1
            avisar('  %-16s ERRO: %s' % (os.path.basename(f), ex))
    if backup:
        avisar('Cópia do que foi substituído: %s' % backup)
    return feitos, erros


def trocar_descricao(dados, desc, quando=None):
    """troca a descrição (e, se pedido, a data) de um save do ScummVM já montado"""
    r = Leitor(dados)
    velha = r.str32()
    resto = dados[r.o:]
    w = Escritor()
    w.str32(desc)
    if quando is None:
        return bytes(w.b) + resto
    r2 = Leitor(resto)
    for _ in range(3):
        r2.str32()
    cab = resto[:r2.o]
    w.raw(cab)
    w.u8(quando.day); w.u8(quando.month); w.u16be(quando.year); w.u8(quando.hour); w.u8(quando.minute)
    w.raw(resto[r2.o + 6:r2.o + 10])
    w.u8(quando.second)
    w.raw(resto[r2.o + 11:])
    return bytes(w.b)


def achar_jogo(caminho=None):
    if caminho and ci(caminho, 'x.xarc'):
        return caminho
    aqui = os.path.dirname(os.path.abspath(sys.argv[0] if sys.argv and sys.argv[0] else __file__))
    for d in (aqui, os.path.dirname(aqui)):
        if ci(d, 'x.xarc'):
            return d
    for d in (r'C:\Program Files (x86)\Steam\steamapps\common\The Longest Journey', r'C:\GOG Games\The Longest Journey'):
        if ci(d, 'x.xarc'):
            return d
    return None


def listar(entradas, direcao):
    pad = r'(?i)save\d+\.tlj' if direcao == PARA_SCUMMVM else r'(?i).+-\d{3}\.tlj'
    out = []
    for e in entradas:
        if os.path.isdir(e):
            out += [os.path.join(e, n) for n in sorted(os.listdir(e)) if re.fullmatch(pad, n)]
        elif os.path.isfile(e):
            out.append(e)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description='Converte saves do The Longest Journey entre o jogo original e o ScummVM.')
    ap.add_argument('saves', nargs='*', help='arquivos ou pastas de saves (padrão: a pasta de saves da origem)')
    ap.add_argument('--para', choices=('scummvm', 'original'), default='scummvm', help='direção (padrão: scummvm)')
    ap.add_argument('--jogo', help='pasta do jogo (onde está o x.xarc)')
    ap.add_argument('--saida', help='pasta de destino (padrão: a pasta de saves do destino)')
    ap.add_argument('--id', default='tlj-win', help='ID do jogo no ScummVM (padrão: tlj-win)')
    ap.add_argument('--modo', choices=('depois', 'ultimo', 'apartir', 'mesmo', 'livre', 'bloco_primeiro', 'bloco_ultimo'), default='depois',
                    help='depois = depois do seu último save; apartir = a partir de --slot; mesmo = mesmo número da origem; livre = preenche os espaços vazios; ultimo = logo depois do último; bloco_primeiro/bloco_ultimo = primeiro/último espaço vazio que comporte tudo')
    ap.add_argument('--manter-lacunas', action='store_true', help='mantém os espaços vazios que havia entre os saves de origem')
    ap.add_argument('--paginas-vazias', type=int, default=1)
    ap.add_argument('--por-pagina', type=int, default=9)
    ap.add_argument('--sem-alinhar', action='store_true', help='modo depois: não começar no 1º slot de uma página')
    ap.add_argument('--slot', type=int, default=0, help='modo apartir: primeiro slot')
    ap.add_argument('--deslocamento', type=int, default=0, help='modo mesmo: soma ao número de origem')
    ap.add_argument('--ate', type=int, help='não passar deste slot')
    ap.add_argument('--ordem', choices=('numero', 'data', 'nome'), default='numero')
    ap.add_argument('--inverter', action='store_true')
    ap.add_argument('--conflito', choices=('proximo', 'pular', 'sobrescrever'), default='proximo')
    ap.add_argument('--sem-backup', action='store_true')
    ap.add_argument('--descricao', default='{nome}', help='modelo: {nome} {slot} {origem} {data} {local}')
    ap.add_argument('--data', choices=('original', 'agora'), default='original')
    ap.add_argument('--sem-index', action='store_true', help='para o jogo original: não mexer no Index.dat')
    ap.add_argument('--simular', action='store_true', help='só mostra o que seria feito')
    a = ap.parse_args(argv)
    print('Conversor de saves do The Longest Journey v%s' % VERSAO)
    op = Opcoes(direcao=a.para, id=a.id, modo=a.modo, manter_lacunas=a.manter_lacunas, paginas_vazias=a.paginas_vazias, por_pagina=a.por_pagina,
                inicio_pagina=not a.sem_alinhar, slot_inicial=a.slot, deslocamento=a.deslocamento, slot_final=a.ate,
                ordem=a.ordem, inverter=a.inverter, conflito=a.conflito, backup=not a.sem_backup,
                descricao=a.descricao, data=a.data, atualizar_index=not a.sem_index)
    pj = achar_jogo(a.jogo)
    if not pj:
        print('Não achei a pasta do jogo: use --jogo "C:\\caminho\\do\\jogo" ou ponha o conversor dentro dela.')
        return 1
    jogo = Jogo(pj)
    origem = a.saves or [pasta_saves_original() if a.para == 'scummvm' else pasta_saves_scummvm()]
    destino = a.saida or (pasta_saves_scummvm() if a.para == 'scummvm' else pasta_saves_original())
    arquivos = listar(origem, a.para)
    if not arquivos:
        print('Nenhum save encontrado em: %s' % ', '.join(origem))
        return 1
    plano = planejar(arquivos, destino, op)
    print('Destino: %s' % destino)
    if a.simular:
        for f, slot, nome, sit in plano:
            print('  %-16s -> %-18s %s' % (os.path.basename(f), nome or '-', sit))
        return 0
    feitos, erros = executar(jogo, plano, destino, op)
    print('\n%d convertido(s), %d erro(s).' % (feitos, erros))
    return 0 if not erros else 2


if __name__ == '__main__':
    sys.exit(main())
