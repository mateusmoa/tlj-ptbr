# -*- coding: utf-8 -*-
"""Editor de saves do The Longest Journey (jogo original e ScummVM) - a parte que lê, altera e grava.
A janela fica no Editor_de_Saves.pyw; usa o converter_saves_tlj.py (mesma pasta) para entender os arquivos do jogo."""
import datetime
import gzip
import os
import shutil
import struct

import converter_saves_tlj as C

TIPOS_BOOL = (0, 5)      # Knowledge: verdadeiro/falso
TIPOS_INT = (2, 3)       # Knowledge: número
TIPO_REF = 4             # Knowledge: referência (só leitura)


def _nome(n):
    return n['name'].decode('cp1252', 'replace')


def _caminho_nomes(nodes, i):
    out = []
    while i >= 0:
        out.append(_nome(nodes[i]))
        i = nodes[i]['parent']
    return ' / '.join(reversed(out))


class Save:
    """um save aberto. Guarda as árvores cruas e só regrava os registros alterados."""

    def __init__(self, jogo, caminho):
        self.J = jogo
        self.caminho = caminho
        with open(caminho, 'rb') as f:
            dados = f.read()
        self.gz = dados[:2] == b'\x1f\x8b'
        if self.gz:
            dados = gzip.decompress(dados)
        self._ler(dados)
        self._cache = {}
        self.alterado = False

    # ------------------------------------------------------------ arquivo
    def _ler(self, dados):
        r = C.Leitor(dados)
        desc = r.str32()
        lvl, loc, ver = r.str32(), r.str32(), r.str32()
        if not ver.startswith(b'Version:\t'):
            raise ValueError('não parece um save do The Longest Journey')
        v = int(ver[9:])
        self.versao = v
        self.formato = 'nativo' if v == 6 else 'scummvm'
        if self.formato == 'nativo':
            r.str32()
        else:
            if v < 11:
                raise ValueError('save do ScummVM muito antigo (versão %d); abra e salve de novo num ScummVM atual' % v)
            r.raw(11)
            if v >= 13:
                r.u32()
            r.raw(C.THUMB_W * C.THUMB_H * 4)
        self.descricao = desc
        self.lvl, self.loc = int(lvl, 16), int(loc, 16)
        self._prefixo_resto = dados[4 + len(desc):r.o]   # tudo entre a descrição e a lista de árvores
        self.arvores = []
        for _ in range(r.u32()):
            k = r.str32()
            tv = r.u32() if self.formato == 'scummvm' else None
            self.arvores.append([k, tv, r.str32()])
        self.resto = dados[r.o:]

    def bytes(self):
        w = C.Escritor()
        w.str32(self.descricao)
        w.raw(self._prefixo_resto)
        w.u32(len(self.arvores))
        for k, tv, d in self.arvores:
            w.str32(k)
            if self.formato == 'scummvm':
                w.u32(tv)
            w.str32(d)
        w.raw(self.resto)
        return bytes(w.b)

    def conferir(self, dados=None):
        """relê e alinha todas as árvores com os arquivos do jogo; levanta erro se algo não bater"""
        s = Save.__new__(Save)
        s.J, s._cache = self.J, {}
        s._ler(dados or self.bytes())
        for k, _tv, _d in s.arvores:
            s._alinhar(k)

    def gravar(self, caminho=None, backup=True):
        caminho = caminho or self.caminho
        dados = self.bytes()
        self.conferir(dados)
        if backup and os.path.exists(caminho):
            pasta = os.path.join(os.path.dirname(caminho), '_backup_editor')
            os.makedirs(pasta, exist_ok=True)
            carimbo = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
            shutil.copy2(caminho, os.path.join(pasta, '%s.%s' % (os.path.basename(caminho), carimbo)))
        with open(caminho, 'wb') as f:
            f.write(gzip.compress(dados) if self.gz else dados)
        self.alterado = False
        return caminho

    # ------------------------------------------------------------ registros
    def _arvore(self, chave):
        for a in self.arvores:
            if a[0] == chave:
                return a
        raise KeyError(chave)

    def chaves(self):
        return [a[0] for a in self.arvores]

    def _alinhar(self, chave):
        """(nodes, ordem, registros) com registros[j] = bytes do nó ordem[j] ou None"""
        if chave in self._cache:
            return self._cache[chave]
        nodes, _lv = self.J.chave(chave, self.lvl, self.loc)
        ordem = C.percurso(nodes)
        d = self._arvore(chave)[2]
        if self.formato == 'nativo':
            recs = C.casar(ordem, C.registros(d), chave in C.CURRENT)
        else:
            rr = C.registros(d)
            if len(rr) != len(ordem) or any((n['t'], n['s']) != r[:2] for n, r in zip(ordem, rr)):
                raise ValueError('o save não bate com os arquivos do jogo na fase %r' % chave.decode('cp1252'))
            recs = [r[2] for r in rr]
        recs = list(recs)
        self._cache[chave] = (nodes, ordem, recs)
        return self._cache[chave]

    def _trocar(self, chave, j, novo):
        nodes, ordem, recs = self._alinhar(chave)
        recs[j] = bytes(novo)
        w = C.Escritor()
        for n, b in zip(ordem, recs):
            if b is None:
                continue
            w.u8(n['t']); w.u8(n['s']); w.u32(len(b)); w.raw(b)
        self._arvore(chave)[2] = bytes(w.b)
        self.alterado = True

    # ------------------------------------------------------------ informações
    def local(self):
        return self.J.nome_location(self.lvl, self.loc)

    def nome_exibicao(self):
        if self.formato == 'scummvm':
            return self.descricao.decode('cp1252', 'replace')
        slot = C.slot_de_origem(self.caminho)
        idx = C.ler_index(os.path.dirname(self.caminho))
        return idx.get(slot, (b'', None))[0].decode('cp1252', 'replace') if slot is not None else ''

    def renomear(self, nome):
        if self.formato == 'scummvm':
            self.descricao = nome.encode('cp1252', 'replace')
            self.alterado = True
        else:
            slot = C.slot_de_origem(self.caminho)
            if slot is None:
                raise ValueError('o nome do jogo original fica no Index.dat; o arquivo precisa se chamar SaveNN.tlj')
            pasta = os.path.dirname(self.caminho)
            quando = C.ler_index(pasta).get(slot, (b'', None))[1] or datetime.datetime.now()
            C.gravar_index(pasta, slot, nome.encode('cp1252', 'replace'), quando)

    # ------------------------------------------------------------ variáveis (Knowledge)
    def variaveis(self):
        """[{chave, j, nome, tipo, valor, editavel}] de todas as árvores de estado"""
        out = []
        for chave in self.chaves():
            if chave in C.CURRENT:
                continue
            try:
                nodes, ordem, recs = self._alinhar(chave)
            except (KeyError, ValueError):
                continue
            for j, (n, b) in enumerate(zip(ordem, recs)):
                if n['t'] != 21 or b is None:
                    continue
                tipo = 'sim/não' if n['s'] in TIPOS_BOOL else 'número' if n['s'] in TIPOS_INT else \
                    'referência' if n['s'] == TIPO_REF else 'outro'
                out.append({'chave': chave, 'j': j, 'nome': _caminho_nomes(nodes, n['i']), 'tipo': tipo,
                            'sub': n['s'], 'valor': self._ler_knowledge(n['s'], b),
                            'editavel': tipo in ('sim/não', 'número')})
        return out

    def _ler_knowledge(self, s, b):
        if self.formato == 'nativo':
            if s in TIPOS_BOOL + TIPOS_INT:
                return struct.unpack_from('<i', b, 0)[0] if len(b) >= 4 else 0
            if s == TIPO_REF:
                return C.Leitor(b).ref() if b else []
            return None
        r = C.Leitor(b)
        iv, bv = r.i32(), r.i32()
        if s in TIPOS_BOOL:
            return bv
        if s in TIPOS_INT:
            return iv
        if s == TIPO_REF:
            return r.ref()
        return None

    def mudar_variavel(self, chave, j, valor):
        nodes, ordem, recs = self._alinhar(chave)
        n, b = ordem[j], recs[j]
        valor = int(valor)
        if n['s'] in TIPOS_BOOL:
            valor = 1 if valor else 0
        elif n['s'] not in TIPOS_INT:
            raise ValueError('essa variável não é editável')
        if self.formato == 'nativo':
            novo = struct.pack('<i', valor) + b[4:]
        else:
            novo = bytearray(b)
            struct.pack_into('<i', novo, 4 if n['s'] in TIPOS_BOOL else 0, valor)
        self._trocar(chave, j, novo)

    # ------------------------------------------------------------ inventário
    def _itens(self):
        """[(idx, nome, j no Global)] dos itens de inventário, na ordem do jogo"""
        nodes, ordem, recs = self._alinhar(b'Global')
        pos = {n['i']: j for j, n in enumerate(ordem)}
        for n in nodes:
            if n['t'] == 20 and n['s'] == 1:
                return [(nodes[k]['idx'], _nome(nodes[k]), pos[k]) for k in n['kids'] if nodes[k]['t'] == 8]
        return []

    def _ks_ordem(self):
        chave = b'CurrentGlobal' if self.formato == 'nativo' else b'Global'
        nodes, ordem, recs = self._alinhar(chave)
        for j, n in enumerate(ordem):
            if n['t'] == 20 and n['s'] == 1 and recs[j] is not None:
                return chave, j, recs[j]
        raise ValueError('não achei a lista do inventário no save')

    def inventario(self):
        """(todos [(idx, nome, tem)], ordem atual [idx])"""
        itens = self._itens()
        _n, _o, recs = self._alinhar(b'Global')
        todos = []
        for idx, nome, j in itens:
            b = recs[j]
            tem = (b[0] if self.formato == 'nativo' else struct.unpack_from('<i', b, 0)[0]) if b else 0
            todos.append((idx, nome, bool(tem)))
        _c, _j, b = self._ks_ordem()
        cnt = struct.unpack_from('<I', b, 0)[0]
        if self.formato == 'nativo':
            lista = [itens[v][0] for v in struct.unpack_from('<%dI' % cnt, b, 4) if v < len(itens)]
        else:
            lista = list(struct.unpack_from('<%dH' % cnt, b, 4))
        return todos, lista

    def mudar_inventario(self, nova_ordem):
        itens = self._itens()
        idxs = [i for i, _n, _j in itens]
        nova_ordem = [i for i in nova_ordem if i in idxs]
        _todos, antes = self.inventario()
        mudou = set(antes) ^ set(nova_ordem)     # só mexe nos itens que entraram ou saíram
        quero = set(nova_ordem)
        nodes, ordem, recs = self._alinhar(b'Global')
        R = None
        for idx, _nome_, j in itens:
            b = recs[j]
            if b is None or idx not in mudou:
                continue
            if self.formato == 'nativo':
                tem = b[0]
                if bool(tem) == (idx in quero):
                    continue
                w = C.Escritor()
                atividade = struct.unpack_from('<i', b, 1)[0] if len(b) >= 5 else 0
                if idx in quero:
                    R = R or C.Resolvedor(self.J, {})
                    w.u8(1); w.i32(atividade)
                    w.ref(R.anim_padrao(nodes, ordem[j]['i'], 0)); w.ref([])
                else:
                    w.u8(0); w.i32(atividade)
                self._trocar(b'Global', j, w.b)
            else:
                tem = struct.unpack_from('<i', b, 0)[0]
                if bool(tem) == (idx in quero):
                    continue
                nb = bytearray(b)
                struct.pack_into('<i', nb, 0, 1 if idx in quero else 0)
                self._trocar(b'Global', j, nb)
        chave, j, b = self._ks_ordem()
        cnt = struct.unpack_from('<I', b, 0)[0]
        if self.formato == 'nativo':
            cauda = b[4 + 4 * cnt:]
            corpo = struct.pack('<I', len(nova_ordem)) + b''.join(struct.pack('<I', idxs.index(i)) for i in nova_ordem)
        else:
            cauda = b[4 + 2 * cnt:]
            corpo = struct.pack('<I', len(nova_ordem)) + b''.join(struct.pack('<H', i) for i in nova_ordem)
        self._trocar(chave, j, corpo + cauda)

    # ------------------------------------------------------------ comparar
    def retrato(self):
        """{nome: valor} para comparar dois saves (mesmo de formatos diferentes)"""
        out = {'[Local]': self.local()}
        todos, lista = self.inventario()
        nomes = {i: n for i, n, _t in todos}
        out['[Inventário]'] = ', '.join(nomes.get(i, str(i)) for i in lista)
        for v in self.variaveis():
            out[v['nome']] = v['valor'] if v['tipo'] != 'referência' else str(v['valor'])
        return out


def comparar(a, b):
    """[(nome, valor em a, valor em b)] só do que é diferente"""
    ra, rb = a.retrato(), b.retrato()
    out = []
    for k in sorted(set(ra) | set(rb), key=lambda x: (not x.startswith('['), x.lower())):
        va, vb = ra.get(k, '—'), rb.get(k, '—')
        if va != vb:
            out.append((k, va, vb))
    return out
