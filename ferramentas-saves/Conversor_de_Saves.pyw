# -*- coding: utf-8 -*-
"""Conversor de saves do The Longest Journey (jogo original <-> ScummVM) - janela.
Precisa do converter_saves_tlj.py na mesma pasta e do Python 3 (com tkinter, que vem no instalador do Windows)."""
import os
import sys
import threading
import tkinter as tk
from tkinter import ttk, filedialog, messagebox

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import converter_saves_tlj as C   # noqa: E402

MODOS = [('depois', 'Depois do último save do destino (com páginas vazias entre eles)'),
         ('ultimo', 'Começar logo depois do último save (sem pular nada)'),
         ('livre', 'Preencher os espaços vazios (primeiros slots livres)'),
         ('bloco_primeiro', 'No primeiro espaço vazio que comporte toda a conversão'),
         ('bloco_ultimo', 'No último espaço vazio que comporte toda a conversão'),
         ('apartir', 'A partir de um slot que eu escolho'),
         ('mesmo', 'Mesmo número da origem (+ deslocamento)')]
ORDENS = [('numero', 'Número do save de origem'), ('data', 'Data do arquivo'), ('nome', 'Nome do arquivo')]
CONFLITOS = [('proximo', 'Usar o próximo slot livre'), ('pular', 'Pular esse save'),
             ('sobrescrever', 'Substituir o que já existe')]


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title('Conversor de saves - The Longest Journey')
        self.geometry('780x780')
        self.minsize(680, 520)
        self.v = {
            'direcao': tk.StringVar(value=C.PARA_SCUMMVM), 'jogo': tk.StringVar(value=C.achar_jogo() or ''),
            'origem': tk.StringVar(value=C.pasta_saves_original()), 'destino': tk.StringVar(value=C.pasta_saves_scummvm()),
            'id': tk.StringVar(value='tlj-win'), 'modo': tk.StringVar(value='depois'),
            'paginas': tk.IntVar(value=1), 'porpag': tk.IntVar(value=9), 'alinhar': tk.BooleanVar(value=True),
            'slot': tk.IntVar(value=0), 'desloc': tk.IntVar(value=0), 'limitar': tk.BooleanVar(value=False),
            'ate': tk.IntVar(value=999), 'ordem': tk.StringVar(value='numero'), 'inverter': tk.BooleanVar(value=False),
            'conflito': tk.StringVar(value='proximo'), 'backup': tk.BooleanVar(value=True),
            'descricao': tk.StringVar(value='{nome}'), 'data': tk.StringVar(value='original'),
            'index': tk.BooleanVar(value=True), 'lacunas': tk.BooleanVar(value=False), 'avancado': tk.BooleanVar(value=False),
        }
        self.arquivos = []
        self._montar()
        self.v['direcao'].trace_add('write', lambda *a: self._trocar_direcao())
        self.v['avancado'].trace_add('write', lambda *a: self._mostrar_avancado())
        self._mostrar_avancado()
        self._recarregar()

    # ---------------------------------------------------------------- interface
    def _linha_pasta(self, pai, rotulo, var, linha, ao_mudar=None):
        ttk.Label(pai, text=rotulo).grid(row=linha, column=0, sticky='w', pady=3)
        ttk.Entry(pai, textvariable=var).grid(row=linha, column=1, sticky='ew', padx=4)

        def escolher():
            d = filedialog.askdirectory(initialdir=var.get() or os.path.expanduser('~'))
            if d:
                var.set(d)
                if ao_mudar:
                    ao_mudar()
        ttk.Button(pai, text='Procurar...', command=escolher).grid(row=linha, column=2)

    def _montar(self):
        topo = ttk.Frame(self, padding=8)
        topo.pack(fill='x')
        ttk.Label(topo, text='Converter:').grid(row=0, column=0, sticky='w')
        dirs = ttk.Frame(topo)
        dirs.grid(row=0, column=1, columnspan=2, sticky='w')
        ttk.Radiobutton(dirs, text='Jogo original  →  ScummVM', value=C.PARA_SCUMMVM, variable=self.v['direcao']).pack(side='left')
        ttk.Radiobutton(dirs, text='ScummVM  →  Jogo original', value=C.PARA_ORIGINAL, variable=self.v['direcao']).pack(side='left', padx=12)
        self._linha_pasta(topo, 'Pasta do jogo:', self.v['jogo'], 1)
        self._linha_pasta(topo, 'Saves de origem:', self.v['origem'], 2, self._recarregar)
        self._linha_pasta(topo, 'Pasta de destino:', self.v['destino'], 3, self._prever)
        topo.columnconfigure(1, weight=1)
        ttk.Checkbutton(topo, text='Opções avançadas', variable=self.v['avancado']).grid(row=4, column=0, sticky='w', pady=4)

        self.abas = ttk.Notebook(self)
        self._aba_slots()
        self._aba_ordem()
        self._aba_nomes()

        meio = ttk.Frame(self, padding=(8, 0))
        meio.pack(fill='both', expand=True)
        ttk.Label(meio, text='Prévia (marque os saves que quer converter; nada é gravado até clicar em Converter):').pack(anchor='w')
        cols = ('origem', 'destino', 'situacao')
        self.lista = ttk.Treeview(meio, columns=cols, show='headings', selectmode='extended', height=10)
        for c, t, w in (('origem', 'Origem', 180), ('destino', 'Destino', 180), ('situacao', 'Situação', 300)):
            self.lista.heading(c, text=t)
            self.lista.column(c, width=w, anchor='w')
        sb = ttk.Scrollbar(meio, orient='vertical', command=self.lista.yview)
        self.lista.configure(yscrollcommand=sb.set)
        self.lista.pack(side='left', fill='both', expand=True)
        sb.pack(side='left', fill='y')

        baixo = ttk.Frame(self, padding=8)
        baixo.pack(fill='x')
        ttk.Button(baixo, text='Todos', command=lambda: self.lista.selection_set(self.lista.get_children())).pack(side='left')
        ttk.Button(baixo, text='Nenhum', command=lambda: self.lista.selection_remove(self.lista.get_children())).pack(side='left', padx=4)
        ttk.Button(baixo, text='Atualizar prévia', command=self._prever).pack(side='left', padx=12)
        self.status = ttk.Label(baixo, text='')
        self.status.pack(side='left', padx=8)
        ttk.Button(baixo, text='Fechar', command=self.destroy).pack(side='right')
        self.botao = ttk.Button(baixo, text='Converter', command=self._converter)
        self.botao.pack(side='right', padx=6)

    def _aba_slots(self):
        f = ttk.Frame(self.abas, padding=8)
        self.abas.add(f, text='Slots')
        ttk.Label(f, text='Onde colocar os convertidos:').grid(row=0, column=0, columnspan=4, sticky='w')
        for i, (k, t) in enumerate(MODOS):
            ttk.Radiobutton(f, text=t, value=k, variable=self.v['modo'], command=self._prever).grid(row=1 + i, column=0, columnspan=4, sticky='w')
        g = ttk.Frame(f)
        g.grid(row=9, column=0, columnspan=4, sticky='w', pady=6)
        campos = [('Páginas vazias entre eles:', 'paginas', 0, 20), ('Saves por página:', 'porpag', 1, 50),
                  ('Primeiro slot:', 'slot', 0, 999), ('Deslocamento:', 'desloc', -999, 999)]
        for i, (t, k, a, b) in enumerate(campos):
            ttk.Label(g, text=t).grid(row=i // 2, column=(i % 2) * 2, sticky='w', padx=(0, 4))
            ttk.Spinbox(g, from_=a, to=b, width=6, textvariable=self.v[k], command=self._prever).grid(row=i // 2, column=(i % 2) * 2 + 1, sticky='w', padx=(0, 16))
        ttk.Checkbutton(f, text='Começar no primeiro slot de uma página', variable=self.v['alinhar'], command=self._prever).grid(row=10, column=0, columnspan=4, sticky='w')
        ttk.Checkbutton(f, text='Manter os espaços vazios entre os saves de origem (Save02 e Save05 ficam a 3 slots)',
                        variable=self.v['lacunas'], command=self._prever).grid(row=11, column=0, columnspan=4, sticky='w')
        h = ttk.Frame(f)
        h.grid(row=12, column=0, columnspan=4, sticky='w', pady=4)
        ttk.Checkbutton(h, text='Não passar do slot', variable=self.v['limitar'], command=self._prever).pack(side='left')
        ttk.Spinbox(h, from_=0, to=999, width=6, textvariable=self.v['ate'], command=self._prever).pack(side='left', padx=4)
        ttk.Label(f, text='Se o slot já existir:').grid(row=13, column=0, sticky='w', pady=(6, 0))
        for i, (k, t) in enumerate(CONFLITOS):
            ttk.Radiobutton(f, text=t, value=k, variable=self.v['conflito'], command=self._prever).grid(row=14 + i, column=0, columnspan=3, sticky='w')
        ttk.Checkbutton(f, text='Guardar uma cópia do que for substituído (pasta _backup_...)', variable=self.v['backup']).grid(row=17, column=0, columnspan=4, sticky='w')

    def _aba_ordem(self):
        f = ttk.Frame(self.abas, padding=8)
        self.abas.add(f, text='Ordem')
        ttk.Label(f, text='Ordem em que os saves ocupam os slots:').grid(row=0, column=0, sticky='w')
        for i, (k, t) in enumerate(ORDENS):
            ttk.Radiobutton(f, text=t, value=k, variable=self.v['ordem'], command=self._prever).grid(row=1 + i, column=0, sticky='w')
        ttk.Checkbutton(f, text='Inverter a ordem', variable=self.v['inverter'], command=self._prever).grid(row=4, column=0, sticky='w', pady=4)

    def _aba_nomes(self):
        f = ttk.Frame(self.abas, padding=8)
        self.abas.add(f, text='Nomes e datas')
        ttk.Label(f, text='Nome do save no destino:').grid(row=0, column=0, sticky='w')
        ttk.Entry(f, textvariable=self.v['descricao'], width=50).grid(row=0, column=1, sticky='w', padx=4)
        ttk.Label(f, text='{nome} = nome original   {slot} = novo slot   {origem} = arquivo de origem\n'
                          '{data} = data do save   {local} = lugar do jogo', foreground='#555').grid(row=1, column=1, sticky='w')
        ttk.Label(f, text='Data do save:').grid(row=2, column=0, sticky='w', pady=6)
        d = ttk.Frame(f)
        d.grid(row=2, column=1, sticky='w')
        ttk.Radiobutton(d, text='A original', value='original', variable=self.v['data']).pack(side='left')
        ttk.Radiobutton(d, text='Agora', value='agora', variable=self.v['data']).pack(side='left', padx=8)
        ttk.Label(f, text='ID do jogo no ScummVM:').grid(row=3, column=0, sticky='w')
        ttk.Entry(f, textvariable=self.v['id'], width=16).grid(row=3, column=1, sticky='w', padx=4)
        ttk.Checkbutton(f, text='Jogo original: escrever o nome no Index.dat (é ele que mostra o nome no menu)',
                        variable=self.v['index']).grid(row=4, column=0, columnspan=2, sticky='w', pady=6)

    def _mostrar_avancado(self):
        if self.v['avancado'].get():
            self.abas.pack(fill='x', padx=8, before=self.lista.master)
        else:
            self.abas.pack_forget()
            # modo simples: os padrões
            self.v['modo'].set('depois'); self.v['paginas'].set(1); self.v['porpag'].set(9)
            self.v['alinhar'].set(True); self.v['conflito'].set('proximo'); self.v['ordem'].set('numero')
            self.v['inverter'].set(False); self.v['limitar'].set(False); self.v['descricao'].set('{nome}')
            self.v['data'].set('original'); self.v['lacunas'].set(False)
        self._prever()

    def _trocar_direcao(self):
        if self.v['direcao'].get() == C.PARA_SCUMMVM:
            self.v['origem'].set(C.pasta_saves_original()); self.v['destino'].set(C.pasta_saves_scummvm())
        else:
            self.v['origem'].set(C.pasta_saves_scummvm()); self.v['destino'].set(C.pasta_saves_original())
        self._recarregar()

    # ---------------------------------------------------------------- lógica
    def _opcoes(self):
        g = lambda k: self.v[k].get()
        return C.Opcoes(direcao=g('direcao'), id=g('id').strip() or 'tlj-win', modo=g('modo'), manter_lacunas=g('lacunas'),
                        paginas_vazias=max(0, int(g('paginas'))), por_pagina=max(1, int(g('porpag'))),
                        inicio_pagina=g('alinhar'), slot_inicial=int(g('slot')), deslocamento=int(g('desloc')),
                        slot_final=int(g('ate')) if g('limitar') else None, ordem=g('ordem'), inverter=g('inverter'),
                        conflito=g('conflito'), backup=g('backup'), descricao=g('descricao') or '{nome}',
                        data=g('data'), atualizar_index=g('index'))

    def _recarregar(self):
        self.arquivos = C.listar([self.v['origem'].get()], self.v['direcao'].get())
        self._prever(todos=True)

    def _prever(self, todos=False):
        if not hasattr(self, 'lista'):
            return
        marcados = {self.lista.item(i, 'values')[0] for i in self.lista.selection()}
        try:
            op = self._opcoes()
        except (tk.TclError, ValueError):
            return
        sel = self.arquivos if todos or not self.lista.get_children() else \
            [f for f in self.arquivos if os.path.basename(f) in marcados]
        plano = C.planejar(sel, self.v['destino'].get(), op)
        destino_de = {f: (n, s) for f, _slot, n, s in plano}
        self.lista.delete(*self.lista.get_children())
        for f in self.arquivos:
            n, s = destino_de.get(f, ('', 'não marcado'))
            iid = self.lista.insert('', 'end', values=(os.path.basename(f), n or '-', s))
            if f in destino_de:
                self.lista.selection_add(iid)
        self.status.config(text='%d save(s) encontrados' % len(self.arquivos))

    def _converter(self):
        jogo = self.v['jogo'].get()
        if not jogo or not C.ci(jogo, 'x.xarc'):
            messagebox.showerror('Pasta do jogo', 'Indique a pasta do jogo (onde ficam o x.xarc e o game.exe).')
            return
        marcados = {self.lista.item(i, 'values')[0] for i in self.lista.selection()}
        arqs = [f for f in self.arquivos if os.path.basename(f) in marcados]
        if not arqs:
            messagebox.showinfo('Nada marcado', 'Marque na lista os saves que quer converter.')
            return
        op = self._opcoes()
        destino = self.v['destino'].get()
        plano = C.planejar(arqs, destino, op)
        if op.conflito == 'sobrescrever' and any(s.startswith('substitui') for *_x, s in plano):
            if not messagebox.askyesno('Substituir', 'Alguns saves do destino vão ser substituídos%s. Continuar?'
                                       % (' (com cópia em _backup_...)' if op.backup else '')):
                return
        self.botao.config(state='disabled')
        self.status.config(text='Convertendo...')
        log = []

        def trabalho():
            try:
                feitos, erros = C.executar(C.Jogo(jogo), plano, destino, op, avisar=log.append)
            except Exception as ex:
                feitos, erros = 0, 1
                log.append('ERRO: %s' % ex)
            self.after(0, lambda: self._fim(feitos, erros, log))
        threading.Thread(target=trabalho, daemon=True).start()

    def _fim(self, feitos, erros, log):
        self.botao.config(state='normal')
        self.status.config(text='%d convertido(s), %d erro(s)' % (feitos, erros))
        jan = tk.Toplevel(self)
        jan.title('Resultado')
        t = tk.Text(jan, width=100, height=24, wrap='none')
        t.insert('1.0', '\n'.join(log) + '\n\n%d convertido(s), %d erro(s).\nDestino: %s' % (feitos, erros, self.v['destino'].get()))
        t.config(state='disabled')
        t.pack(fill='both', expand=True)
        ttk.Button(jan, text='Abrir a pasta de destino',
                   command=lambda: os.startfile(self.v['destino'].get()) if hasattr(os, 'startfile') else None).pack(side='left', padx=8, pady=8)
        ttk.Button(jan, text='Fechar', command=jan.destroy).pack(side='right', padx=8, pady=8)
        self._recarregar()


if __name__ == '__main__':
    App().mainloop()
