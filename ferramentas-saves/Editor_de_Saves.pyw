# -*- coding: utf-8 -*-
"""Editor de saves do The Longest Journey (jogo original e ScummVM) - janela.
Precisa do converter_saves_tlj.py e do editor_saves_tlj.py na mesma pasta."""
import os
import sys
import tkinter as tk
from tkinter import ttk, filedialog, messagebox, simpledialog

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import converter_saves_tlj as C   # noqa: E402
import editor_saves_tlj as E      # noqa: E402


class Editor(tk.Tk):
    def __init__(self, arquivo=None):
        super().__init__()
        self.title('Editor de saves - The Longest Journey')
        self.geometry('900x680')
        self.minsize(760, 520)
        self.jogo_dir = tk.StringVar(value=C.achar_jogo() or '')
        self.J = None
        self.save = None
        self.filtro = tk.StringVar()
        self.so_editaveis = tk.BooleanVar(value=True)
        self._montar()
        self.protocol('WM_DELETE_WINDOW', self._sair)
        if arquivo:
            self.after(100, lambda: self._abrir(arquivo))

    # ---------------------------------------------------------------- interface
    def _montar(self):
        topo = ttk.Frame(self, padding=8)
        topo.pack(fill='x')
        ttk.Label(topo, text='Pasta do jogo:').grid(row=0, column=0, sticky='w')
        ttk.Entry(topo, textvariable=self.jogo_dir).grid(row=0, column=1, sticky='ew', padx=4)
        ttk.Button(topo, text='Procurar...', command=self._escolher_jogo).grid(row=0, column=2)
        bar = ttk.Frame(topo)
        bar.grid(row=1, column=0, columnspan=3, sticky='w', pady=(6, 0))
        ttk.Button(bar, text='Abrir save...', command=self._abrir_dialogo).pack(side='left')
        self.b_salvar = ttk.Button(bar, text='Salvar', command=self._salvar, state='disabled')
        self.b_salvar.pack(side='left', padx=4)
        self.b_salvar_como = ttk.Button(bar, text='Salvar como...', command=self._salvar_como, state='disabled')
        self.b_salvar_como.pack(side='left')
        self.info = ttk.Label(bar, text='Nenhum save aberto.')
        self.info.pack(side='left', padx=12)
        topo.columnconfigure(1, weight=1)

        self.abas = ttk.Notebook(self)
        self.abas.pack(fill='both', expand=True, padx=8, pady=(0, 8))
        self._aba_resumo()
        self._aba_inventario()
        self._aba_variaveis()
        self._aba_comparar()

    def _aba_resumo(self):
        f = ttk.Frame(self.abas, padding=10)
        self.abas.add(f, text='Resumo')
        self.r_lbl = {}
        for i, k in enumerate(('Arquivo', 'Formato', 'Local', 'Nome do save', 'Variáveis', 'Itens no inventário')):
            ttk.Label(f, text=k + ':').grid(row=i, column=0, sticky='w', pady=3)
            self.r_lbl[k] = ttk.Label(f, text='-')
            self.r_lbl[k].grid(row=i, column=1, sticky='w', padx=6)
        ttk.Button(f, text='Renomear o save...', command=self._renomear).grid(row=6, column=0, sticky='w', pady=10)
        ttk.Label(f, foreground='#555', justify='left', text=(
            'Dicas:\n'
            '• Antes de salvar, o editor confere o save inteiro com os arquivos do jogo e guarda uma cópia\n'
            '  do original na pasta _backup_editor (ao lado do save).\n'
            '• Para descobrir o que uma variável faz: salve antes e depois de uma ação no jogo e use a aba Comparar.\n'
            '• Mudar variáveis da história pode travar a sequência do jogo. Teste num save de cópia.')
        ).grid(row=7, column=0, columnspan=2, sticky='w')

    def _aba_inventario(self):
        f = ttk.Frame(self.abas, padding=8)
        self.abas.add(f, text='Inventário')
        esq = ttk.Frame(f)
        esq.pack(side='left', fill='both', expand=True)
        ttk.Label(esq, text='No inventário (nesta ordem):').pack(anchor='w')
        self.l_tem = tk.Listbox(esq, selectmode='extended', exportselection=False)
        self.l_tem.pack(fill='both', expand=True)
        meio = ttk.Frame(f, padding=8)
        meio.pack(side='left', fill='y')
        for t, c in (('◀ Adicionar', self._inv_add), ('Remover ▶', self._inv_rem), ('', None),
                     ('▲ Subir', lambda: self._inv_mover(-1)), ('▼ Descer', lambda: self._inv_mover(1)),
                     ('', None), ('Ordenar A-Z', self._inv_az)):
            if c:
                ttk.Button(meio, text=t, command=c, width=14).pack(pady=3)
            else:
                ttk.Frame(meio, height=14).pack()
        dir_ = ttk.Frame(f)
        dir_.pack(side='left', fill='both', expand=True)
        ttk.Label(dir_, text='Todos os outros itens do jogo:').pack(anchor='w')
        self.l_resto = tk.Listbox(dir_, selectmode='extended', exportselection=False)
        self.l_resto.pack(fill='both', expand=True)
        self.l_resto.bind('<Double-1>', lambda e: self._inv_add())
        self.l_tem.bind('<Double-1>', lambda e: self._inv_rem())
        self.inv_ordem, self.inv_nomes = [], {}

    def _aba_variaveis(self):
        f = ttk.Frame(self.abas, padding=8)
        self.abas.add(f, text='Variáveis da história')
        bar = ttk.Frame(f)
        bar.pack(fill='x')
        ttk.Label(bar, text='Procurar:').pack(side='left')
        e = ttk.Entry(bar, textvariable=self.filtro, width=40)
        e.pack(side='left', padx=4)
        self.filtro.trace_add('write', lambda *a: self._mostrar_variaveis())
        ttk.Checkbutton(bar, text='Só as editáveis', variable=self.so_editaveis,
                        command=self._mostrar_variaveis).pack(side='left', padx=8)
        ttk.Label(bar, text='(duplo clique para mudar)', foreground='#555').pack(side='left')
        cols = ('valor', 'tipo')
        self.t_var = ttk.Treeview(f, columns=cols, show='tree headings')
        self.t_var.heading('#0', text='Fase / lugar / variável')
        self.t_var.heading('valor', text='Valor')
        self.t_var.heading('tipo', text='Tipo')
        self.t_var.column('#0', width=560)
        self.t_var.column('valor', width=110, anchor='center')
        self.t_var.column('tipo', width=90, anchor='center')
        sb = ttk.Scrollbar(f, orient='vertical', command=self.t_var.yview)
        self.t_var.configure(yscrollcommand=sb.set)
        self.t_var.pack(side='left', fill='both', expand=True, pady=(6, 0))
        sb.pack(side='left', fill='y', pady=(6, 0))
        self.t_var.bind('<Double-1>', self._editar_variavel)
        self.vars, self.var_por_iid = [], {}

    def _aba_comparar(self):
        f = ttk.Frame(self.abas, padding=8)
        self.abas.add(f, text='Comparar')
        bar = ttk.Frame(f)
        bar.pack(fill='x')
        ttk.Button(bar, text='Comparar com outro save...', command=self._comparar).pack(side='left')
        self.c_info = ttk.Label(bar, text='Mostra só o que é diferente entre o save aberto (A) e outro (B).')
        self.c_info.pack(side='left', padx=8)
        self.t_cmp = ttk.Treeview(f, columns=('a', 'b'), show='tree headings')
        self.t_cmp.heading('#0', text='O quê')
        self.t_cmp.heading('a', text='A (aberto)')
        self.t_cmp.heading('b', text='B')
        self.t_cmp.column('#0', width=520)
        self.t_cmp.column('a', width=150)
        self.t_cmp.column('b', width=150)
        sb = ttk.Scrollbar(f, orient='vertical', command=self.t_cmp.yview)
        self.t_cmp.configure(yscrollcommand=sb.set)
        self.t_cmp.pack(side='left', fill='both', expand=True, pady=(6, 0))
        sb.pack(side='left', fill='y', pady=(6, 0))
        self.t_cmp.bind('<Double-1>', self._copiar_de_b)
        self.cmp_b = None

    # ---------------------------------------------------------------- abrir / salvar
    def _escolher_jogo(self):
        d = filedialog.askdirectory(initialdir=self.jogo_dir.get() or os.path.expanduser('~'))
        if d:
            self.jogo_dir.set(d)
            self.J = None

    def _jogo(self):
        if self.J is None or self.J.root != self.jogo_dir.get():
            self.J = C.Jogo(self.jogo_dir.get())
        return self.J

    def _pasta_inicial(self):
        for p in (C.pasta_saves_scummvm(), C.pasta_saves_original()):
            if p and os.path.isdir(p):
                return p
        return os.path.expanduser('~')

    def _abrir_dialogo(self):
        if not self._descartar_ok():
            return
        p = filedialog.askopenfilename(initialdir=self._pasta_inicial(), title='Abrir save',
                                       filetypes=[('Saves do TLJ', '*.tlj'), ('Todos', '*.*')])
        if p:
            self._abrir(p)

    def _carregar(self, p):
        try:
            return E.Save(self._jogo(), p)
        except SystemExit as ex:
            messagebox.showerror('Pasta do jogo', str(ex))
        except Exception as ex:
            messagebox.showerror('Não deu para abrir', '%s\n\n%s' % (os.path.basename(p), ex))
        return None

    def _abrir(self, p):
        s = self._carregar(p)
        if not s:
            return
        self.save = s
        self.cmp_b = None
        self.t_cmp.delete(*self.t_cmp.get_children())
        self._atualizar_tudo()
        self.b_salvar.config(state='normal')
        self.b_salvar_como.config(state='normal')

    def _salvar(self, destino=None):
        if not self.save:
            return
        self._aplicar_inventario()
        try:
            p = self.save.gravar(destino)
        except Exception as ex:
            messagebox.showerror('Não salvei', 'O save editado não passou na conferência, nada foi gravado.\n\n%s' % ex)
            return
        self.save.caminho = p
        self._atualizar_info()
        messagebox.showinfo('Salvo', 'Salvo em:\n%s%s' % (p, '\n\nO original ficou em _backup_editor.' if not destino else ''))

    def _salvar_como(self):
        if not self.save:
            return
        p = filedialog.asksaveasfilename(initialdir=os.path.dirname(self.save.caminho),
                                         initialfile=os.path.basename(self.save.caminho), defaultextension='.tlj',
                                         filetypes=[('Saves do TLJ', '*.tlj')])
        if p:
            self._salvar(p)

    def _descartar_ok(self):
        if self.save and (self.save.alterado or self._inv_mudou()):
            return messagebox.askyesno('Alterações', 'Tem alterações não salvas. Descartar?')
        return True

    def _sair(self):
        if self._descartar_ok():
            self.destroy()

    # ---------------------------------------------------------------- atualizar telas
    def _atualizar_tudo(self):
        self._carregar_inventario()
        self.vars = self.save.variaveis()
        self._mostrar_variaveis()
        self._atualizar_info()

    def _atualizar_info(self):
        s = self.save
        fmt = 'Jogo original' if s.formato == 'nativo' else 'ScummVM (versão %d)' % s.versao
        marca = ' *' if (s.alterado or self._inv_mudou()) else ''
        self.info.config(text='%s  —  %s%s' % (os.path.basename(s.caminho), fmt, marca))
        vals = {'Arquivo': s.caminho, 'Formato': fmt, 'Local': s.local(), 'Nome do save': s.nome_exibicao() or '-',
                'Variáveis': '%d (%d editáveis)' % (len(self.vars), sum(v['editavel'] for v in self.vars)),
                'Itens no inventário': str(len(self.inv_ordem))}
        for k, v in vals.items():
            self.r_lbl[k].config(text=v)

    def _renomear(self):
        if not self.save:
            return
        n = simpledialog.askstring('Renomear', 'Nome do save:', initialvalue=self.save.nome_exibicao(), parent=self)
        if n is None:
            return
        try:
            self.save.renomear(n)
        except Exception as ex:
            messagebox.showerror('Renomear', str(ex))
            return
        if self.save.formato == 'nativo':
            messagebox.showinfo('Renomear', 'Nome gravado no Index.dat.')
        self._atualizar_info()

    # ---------------------------------------------------------------- inventário
    def _carregar_inventario(self):
        todos, ordem = self.save.inventario()
        self.inv_nomes = {i: n for i, n, _t in todos}
        self.inv_todos = [i for i, _n, _t in todos]
        self.inv_ordem = list(ordem)
        self.inv_inicial = list(ordem)
        self._mostrar_inventario()

    def _mostrar_inventario(self):
        self.l_tem.delete(0, 'end')
        for i in self.inv_ordem:
            self.l_tem.insert('end', self.inv_nomes.get(i, str(i)))
        self.inv_resto = sorted((i for i in self.inv_todos if i not in self.inv_ordem), key=lambda i: self.inv_nomes[i].lower())
        self.l_resto.delete(0, 'end')
        for i in self.inv_resto:
            self.l_resto.insert('end', self.inv_nomes[i])
        if self.save:
            self._atualizar_info()

    def _inv_mudou(self):
        return bool(self.save) and getattr(self, 'inv_inicial', None) is not None and self.inv_ordem != self.inv_inicial

    def _inv_add(self):
        for k in self.l_resto.curselection():
            self.inv_ordem.append(self.inv_resto[k])
        self._mostrar_inventario()

    def _inv_rem(self):
        sel = set(self.l_tem.curselection())
        self.inv_ordem = [i for k, i in enumerate(self.inv_ordem) if k not in sel]
        self._mostrar_inventario()

    def _inv_mover(self, d):
        sel = list(self.l_tem.curselection())
        if not sel:
            return
        o = self.inv_ordem
        for k in (sel if d < 0 else reversed(sel)):
            j = k + d
            if 0 <= j < len(o) and j not in sel:
                o[k], o[j] = o[j], o[k]
                sel[sel.index(k)] = j
        self._mostrar_inventario()
        for k in sel:
            self.l_tem.selection_set(k)

    def _inv_az(self):
        self.inv_ordem.sort(key=lambda i: self.inv_nomes.get(i, '').lower())
        self._mostrar_inventario()

    def _aplicar_inventario(self):
        if self._inv_mudou():
            self.save.mudar_inventario(self.inv_ordem)
            self.inv_inicial = list(self.inv_ordem)

    # ---------------------------------------------------------------- variáveis
    def _mostrar_variaveis(self):
        t = self.t_var
        t.delete(*t.get_children())
        self.var_por_iid = {}
        filtro = self.filtro.get().strip().lower()
        pastas = {}
        n = 0
        for k, v in enumerate(self.vars):
            if self.so_editaveis.get() and not v['editavel']:
                continue
            if filtro and filtro not in v['nome'].lower():
                continue
            partes = v['nome'].split(' / ')
            pai = ''
            for d in range(len(partes) - 1):
                chave = (v['chave'],) + tuple(partes[:d + 1])
                if chave not in pastas:
                    pastas[chave] = t.insert(pai, 'end', text=partes[d], open=bool(filtro))
                pai = pastas[chave]
            iid = t.insert(pai, 'end', text=partes[-1], values=(self._fmt(v), v['tipo']))
            self.var_por_iid[iid] = k
            n += 1
            if n >= 5000:
                break

    @staticmethod
    def _fmt(v):
        if v['tipo'] == 'sim/não':
            return 'sim' if v['valor'] else 'não'
        return str(v['valor'])

    def _editar_variavel(self, _e=None):
        iid = self.t_var.focus()
        if iid not in self.var_por_iid:
            return
        v = self.vars[self.var_por_iid[iid]]
        if not v['editavel']:
            messagebox.showinfo('Variável', 'Esse tipo de variável (%s) só pode ser visto.' % v['tipo'])
            return
        if v['tipo'] == 'sim/não':
            novo = 0 if v['valor'] else 1
        else:
            novo = simpledialog.askinteger('Mudar valor', v['nome'], initialvalue=v['valor'], parent=self)
            if novo is None:
                return
        self.save.mudar_variavel(v['chave'], v['j'], novo)
        v['valor'] = novo
        self.t_var.item(iid, values=(self._fmt(v), v['tipo']))
        self._atualizar_info()

    # ---------------------------------------------------------------- comparar
    def _comparar(self):
        if not self.save:
            messagebox.showinfo('Comparar', 'Abra um save primeiro.')
            return
        p = filedialog.askopenfilename(initialdir=os.path.dirname(self.save.caminho), title='Save B',
                                       filetypes=[('Saves do TLJ', '*.tlj'), ('Todos', '*.*')])
        if not p:
            return
        b = self._carregar(p)
        if not b:
            return
        self._aplicar_inventario()
        self.cmp_b = b
        dif = E.comparar(self.save, b)
        self.t_cmp.delete(*self.t_cmp.get_children())
        self.cmp_linhas = {}
        for nome, va, vb in dif:
            iid = self.t_cmp.insert('', 'end', text=nome, values=(va, vb))
            self.cmp_linhas[iid] = nome
        self.c_info.config(text='%d diferença(s) com %s. Duplo clique numa variável copia o valor de B para A.'
                           % (len(dif), os.path.basename(p)))

    def _copiar_de_b(self, _e=None):
        iid = self.t_cmp.focus()
        nome = self.cmp_linhas.get(iid) if hasattr(self, 'cmp_linhas') else None
        if not nome or nome.startswith('['):
            return
        alvo = [v for v in self.vars if v['nome'] == nome and v['editavel']]
        origem = [v for v in self.cmp_b.variaveis() if v['nome'] == nome]
        if not alvo or not origem:
            messagebox.showinfo('Copiar', 'Essa variável não existe (ou não é editável) no save A.')
            return
        a, b = alvo[0], origem[0]
        self.save.mudar_variavel(a['chave'], a['j'], b['valor'])
        a['valor'] = b['valor']
        self.t_cmp.item(iid, values=(b['valor'], b['valor']))
        self._mostrar_variaveis()
        self._atualizar_info()


if __name__ == '__main__':
    Editor(sys.argv[1] if len(sys.argv) > 1 else None).mainloop()
