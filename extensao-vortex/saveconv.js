'use strict';
// Conversor de saves do The Longest Journey: jogo original (SaveNN.tlj) -> ScummVM (<id>-NNN.tlj).
//
// Os dois guardam o estado de cada recurso do jogo, mas em formatos diferentes, e o ScummVM não abre os
// saves do jogo original. O save convertido é gravado na versão 12 do formato do ScummVM (o ScummVM 2.x
// lê da 6 à 13). A estrutura de cada fase vem dos próprios arquivos do jogo (.xarc), por isso a conversão
// precisa da pasta do jogo. Nada aqui altera os saves originais.
//
// Validado contra saves feitos no ScummVM nos mesmos pontos do jogo (início, capítulos 12 e 13) e
// carregando os convertidos no ScummVM 2.8.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SAVE_VERSION = 12;
const THUMB_W = 160;
const THUMB_H = 92;
const THUMB_SIZE = THUMB_W * THUMB_H * 4;

// ------------------------------------------------------------------ leitura/escrita binária
class Reader {
  constructor(buf, o = 0) { this.b = buf; this.o = o; }
  need(n) { if (this.o + n > this.b.length) throw new RangeError('unexpected end of data'); }
  u8() { this.need(1); return this.b[this.o++]; }
  u16() { this.need(2); const v = this.b.readUInt16LE(this.o); this.o += 2; return v; }
  u32() { this.need(4); const v = this.b.readUInt32LE(this.o); this.o += 4; return v; }
  i32() { this.need(4); const v = this.b.readInt32LE(this.o); this.o += 4; return v; }
  f32() { this.need(4); const v = this.b.readFloatLE(this.o); this.o += 4; return v; }
  raw(n) { this.need(n); const v = this.b.subarray(this.o, this.o + n); this.o += n; return v; }
  str32() { return this.raw(this.u32()); }
  ref() {
    const n = this.u32();
    if (n > 64) throw new RangeError('invalid reference');
    const out = [];
    for (let i = 0; i < n; i++) { const t = this.u8(); out.push([t, this.u16()]); }
    return out;
  }
  end() { return this.o >= this.b.length; }
}

class Writer {
  constructor() { this.parts = []; }
  num(fn, size, v) { const b = Buffer.alloc(size); b[fn](v, 0); this.parts.push(b); }
  u8(v) { this.parts.push(Buffer.from([v & 0xff])); }
  u16(v) { this.num('writeUInt16LE', 2, v & 0xffff); }
  u16be(v) { this.num('writeUInt16BE', 2, v & 0xffff); }
  u32(v) { this.num('writeUInt32LE', 4, v >>> 0); }
  i32(v) { this.num('writeInt32LE', 4, v | 0); }
  f32(v) { this.num('writeFloatLE', 4, v); }
  raw(b) { this.parts.push(Buffer.from(b)); }
  str32(b) { this.u32(b.length); this.raw(b); }
  ref(p) { this.u32(p.length); for (const [t, i] of p) { this.u8(t); this.u16(i); } }
  bytes() { return Buffer.concat(this.parts); }
}

const key = b => Buffer.from(b).toString('latin1');
const text = b => {
  try { return new TextDecoder('windows-1252').decode(b); } catch (err) { return Buffer.from(b).toString('latin1'); }
};
const u32AsF32 = v => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); return b.readFloatLE(0); };
const u32AsI32 = v => v | 0;

// ------------------------------------------------------------------ arquivos do jogo (.xarc / .xrc)
const dirCache = new Map();
function listDir(dir) {
  if (!dirCache.has(dir)) {
    let names = null;
    try { names = fs.readdirSync(dir); } catch (err) { names = null; }
    dirCache.set(dir, names);
  }
  return dirCache.get(dir);
}

/** caminho sem diferenciar maiúsculas (o jogo é do Windows) */
function ci(root, rel) {
  let cur = root;
  for (const p of rel.split(/[\\/]+/).filter(x => x)) {
    const names = listDir(cur);
    if (!names) return null;
    const hit = names.find(n => n.toLowerCase() === p.toLowerCase());
    if (hit === undefined) return null;
    cur = path.join(cur, hit);
  }
  return cur;
}

/** lê só o .xrc de dentro de um .xarc (o resto do arquivo não interessa) */
function readXrc(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(12);
    fs.readSync(fd, head, 0, 12, 0);
    const count = head.readUInt32LE(4);
    const dataOff = head.readUInt32LE(8);
    const table = Buffer.alloc(Math.max(0, dataOff - 12));
    fs.readSync(fd, table, 0, table.length, 12);
    let o = 0;
    let pos = dataOff;
    for (let i = 0; i < count; i++) {
      const e = table.indexOf(0, o);
      const name = table.subarray(o, e).toString('latin1');
      o = e + 1;
      const len = table.readUInt32LE(o);
      o += 8;
      if (/\.xrc$/i.test(name)) {
        const b = Buffer.alloc(len);
        fs.readSync(fd, b, 0, len, pos);
        return b;
      }
      pos += len;
    }
  } finally {
    fs.closeSync(fd);
  }
  throw new Error(`no .xrc in ${path.basename(file)}`);
}

function parseXrc(x) {
  const nodes = [];
  let o = 0;
  const stack = [[1, -1]];
  while (stack.length) {
    const top = stack[stack.length - 1];
    if (top[0] === 0) { stack.pop(); continue; }
    top[0]--;
    const parent = top[1];
    const t = x[o], s = x[o + 1], idx = x.readUInt16LE(o + 2);
    const nl = x.readUInt16LE(o + 4);
    const name = x.subarray(o + 6, o + 6 + nl);
    const d = o + 6 + nl;
    const dl = x.readUInt32LE(d);
    const data = x.subarray(d + 4, d + 4 + dl);
    o = d + 4 + dl;
    const nch = x.readUInt16LE(o);
    o += 4;
    const n = { t, s, idx, name, data, parent, kids: [], i: nodes.length };
    nodes.push(n);
    if (parent >= 0) nodes[parent].kids.push(n.i);
    stack.push([nch, n.i]);
  }
  return nodes;
}

/** ordem em que o ScummVM grava e lê os recursos: pai antes dos filhos, filhos na ordem do arquivo */
function traverse(nodes) {
  const out = [];
  const stack = [0];
  while (stack.length) {
    const i = stack.pop();
    out.push(nodes[i]);
    for (let k = nodes[i].kids.length - 1; k >= 0; k--) stack.push(nodes[i].kids[k]);
  }
  return out;
}

function commandArgs(data) {
  const r = new Reader(data);
  const out = [];
  const n = r.u32();
  for (let i = 0; i < n; i++) {
    const t = r.u32();
    if (t === 0) out.push(0);
    else if (t === 1 || t === 2) out.push(r.i32());
    else if (t === 3) out.push(r.ref());
    else if (t === 4) out.push(r.raw(r.u16()));
    else throw new Error(`unknown argument type ${t}`);
  }
  return out;
}

class Game {
  constructor(root) {
    this.root = root;
    if (!ci(root, 'x.xarc')) throw new Error(`x.xarc not found in ${root}`);
    this.cache = new Map();
    this.levels = this.xrc('x.xarc').filter(n => n.t === 2);
  }

  xrc(rel) {
    const k = rel.toLowerCase();
    if (!this.cache.has(k)) {
      const p = ci(this.root, rel);
      if (!p) { const e = new Error(`${rel} not found`); e.code = 'ENOENT'; throw e; }
      this.cache.set(k, parseXrc(readXrc(p)));
    }
    return this.cache.get(k);
  }

  globalLevel() { return this.levels.find(lv => lv.s === 1); }
  levelByIndex(idx) {
    if (idx === 0) return this.globalLevel();
    return this.levels.find(lv => lv.idx === idx && lv.s === 2) || null;
  }
  levelTree(lv) {
    if (lv.s === 1) { const n = text(lv.name); return this.xrc(`${n}/${n}.xarc`); }
    const h = lv.idx.toString(16).padStart(2, '0');
    return this.xrc(`${h}/${h}.xarc`);
  }
  locationTree(lv, loc) {
    const h = lv.idx.toString(16).padStart(2, '0');
    const l = loc.toString(16).padStart(2, '0');
    return this.xrc(`${h}/${l}/${l}.xarc`);
  }
  locations(lv) { return this.levelTree(lv).filter(n => n.t === 3); }

  /** árvore salva com essa chave: { nodes, level } */
  tree(k, lvl, loc) {
    const s = key(k);
    if (s === 'Global' || s === 'CurrentGlobal') return { nodes: this.levelTree(this.globalLevel()), level: 0 };
    if (s === 'Current') return { nodes: this.levelTree(this.levelByIndex(lvl)), level: lvl };
    if (s === 'CurrentCurrent') return { nodes: this.locationTree(this.levelByIndex(lvl), loc), level: lvl };
    const byName = this.levels.find(lv => key(lv.name) === s);
    if (byName) return { nodes: this.levelTree(byName), level: byName.idx };
    for (const lv of [...this.levels].sort((a, b) => b.name.length - a.name.length)) {
      if (lv.s === 2 && s.startsWith(key(lv.name))) {
        const rest = s.slice(lv.name.length);
        const l = this.locations(lv).find(x => key(x.name) === rest);
        if (l) return { nodes: this.locationTree(lv, l.idx), level: lv.idx };
      }
    }
    const e = new Error(`"${text(k)}" is not in the game files`);
    e.code = 'NOTREE';
    throw e;
  }

  locationName(lvl, loc) {
    const lv = this.levelByIndex(lvl);
    let ln = '?';
    try { ln = text(this.locationTree(lv, loc)[0].name); } catch (err) { /* sem a location */ }
    return `${lv ? text(lv.name) : '?'} / ${ln}`;
  }

  /** nomes dos personagens (os mesmos que o ScummVM põe no registro de conversas) */
  characters() {
    const g = this.levelTree(this.globalLevel());
    const set = g.find(n => n.t === 20 && n.s === 3);
    const out = new Map();
    if (set) for (const k of set.kids) if (g[k].t === 21) out.set(g[k].idx, g[k].name);
    return out;
  }

  /** o jogo original guarda o inventário pela posição do item na lista; o ScummVM, pelo índice */
  inventoryItems() {
    const g = this.levelTree(this.globalLevel());
    const set = g.find(n => n.t === 20 && n.s === 1);
    return set ? set.kids.filter(k => g[k].t === 8).map(k => g[k].idx) : [];
  }

  *commands(nodes, sub) {
    for (const n of nodes) if (n.t === 22 && n.s === sub) yield commandArgs(n.data);
  }
}

/** referência (tipo, índice) do recurso, do Level até ele, como o ScummVM monta */
function refPath(nodes, i, level) {
  const out = [];
  let n = nodes[i];
  for (;;) {
    if (n.t === 1) break;
    out.push([n.t, n.idx]);
    if (n.parent < 0) {
      if (n.t === 3) out.push([2, level]);
      break;
    }
    n = nodes[n.parent];
  }
  return out.reverse();
}

// ------------------------------------------------------------------ AnimHierarchy padrão de itens desligados
// O jogo original não grava a animação de itens desligados; o ScummVM exige uma válida para cada item.
class Resolver {
  constructor(game, templateIdx) { this.G = game; this.tpl = templateIdx; }

  resolve(p) {
    if (!p.length || p[0][0] !== 2) return null;
    const lvIdx = p[0][1];
    const lv = this.G.levelByIndex(lvIdx);
    if (!lv) return null;
    let nodes = this.G.levelTree(lv);
    let cur = 0;
    for (const [t, i] of p.slice(1)) {
      if (t === 3) {
        try { nodes = this.G.locationTree(lv, i); } catch (err) { return null; }
        cur = 0;
        continue;
      }
      const hit = nodes[cur].kids.find(k => nodes[k].t === t && nodes[k].idx === i);
      if (hit === undefined) return null;
      cur = hit;
    }
    return { nodes, i: cur, level: lvIdx };
  }

  stock(nodes, i, level, depth = 0) {
    const n = nodes[i];
    if (depth > 4 || n.t !== 8) return null;
    let idx = this.tpl.has(`${level}:${n.idx}`) ? this.tpl.get(`${level}:${n.idx}`) : -1;
    if (n.s === 3) {
      const ref = n.data.length >= 12 ? new Reader(n.data, 8).ref() : [];
      const target = ref.length ? this.resolve(ref) : null;
      if (idx === -1 && !target) idx = 0;
      if (idx === -1) return this.stock(target.nodes, target.i, target.level, depth + 1);
    } else if (n.s !== 1) {
      return null;
    }
    if (idx === -1) return null;
    const hit = n.kids.find(k => nodes[k].t === 10 && nodes[k].idx === idx);
    return hit === undefined ? null : refPath(nodes, hit, level);
  }

  defaultAnim(nodes, i, level) {
    const n = nodes[i];
    if (n.s === 10 && n.data.length >= 16) {
      const ref = new Reader(n.data, 12).ref();
      if (ref.length) {
        const target = this.resolve(ref);
        if (target) {
          const s = this.stock(target.nodes, target.i, target.level);
          if (s) return s;
        }
      }
    }
    const own = n.kids.find(k => nodes[k].t === 10);
    return own === undefined ? [] : refPath(nodes, own, level);
  }
}

// ------------------------------------------------------------------ piso (arestas bloqueadas)
const ORDER_SCUMMVM = [[2, 0], [0, 1], [1, 2]];
const ORDER_NATIVE = [[0, 1], [1, 2], [2, 0]];
const edgeKey = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
const isEmptyFace = f => f[0] === 0 && f[1] === 0 && f[2] === 0;

function edges(faces, order) {
  const out = [];
  const seen = new Set();
  for (const f of faces) {
    if (isEmptyFace(f)) continue;
    for (const [a, b] of order) {
      const e = edgeKey(f[a], f[b]);
      if (!seen.has(e)) { seen.add(e); out.push(e); }
    }
  }
  return out;
}

/** O jogo original guarda 1 byte por aresta (1 = passagem entre duas faces bloqueada), na ordem dele;
 *  o ScummVM guarda "enabled" (u32) por aresta, e as arestas da borda seguem o estado da face. */
function convertFloor(nodes, floorI, nat) {
  const fl = nodes[floorI];
  const faces = fl.kids.filter(k => nodes[k].t === 7)
    .map(k => [0, 2, 4].map(o => nodes[k].data.readInt16LE(o)));
  const natEdges = edges(faces, ORDER_NATIVE);
  if (natEdges.length !== nat.length) {
    throw new Error(`the floor has ${natEdges.length} edges, the save has ${nat.length}`);
  }
  const nb = new Map(natEdges.map((e, i) => [e, nat[i]]));
  const ef = new Map();
  faces.forEach((f, fi) => {
    if (isEmptyFace(f)) return;
    for (const [x, y] of ORDER_NATIVE) {
      const e = edgeKey(f[x], f[y]);
      if (!ef.has(e)) ef.set(e, []);
      ef.get(e).push(fi);
    }
  });
  const inner = new Map();
  for (const [e, fs] of ef) {
    if (fs.length >= 2) {
      for (const fi of fs) {
        if (!inner.has(fi)) inner.set(fi, []);
        inner.get(fi).push(e);
      }
    }
  }
  const fields = [];
  for (const m of nodes) {
    if (m.t === 18 && m.data.length >= 4) {
      const cnt = m.data.readUInt32LE(0);
      const set = new Set();
      for (let i = 0; i < Math.min(cnt, m.data.length - 4); i++) if (m.data[4 + i]) set.add(i);
      fields.push(set);
    }
  }
  const off = new Set();
  const noField = new Set(faces.map((_, i) => i));
  for (const field of fields) {
    for (const f of field) noField.delete(f);
    const own = [...ef].filter(([, fs]) => fs.length >= 2 && fs.every(f => field.has(f))).map(([e]) => e);
    const base = own.length ? own : [].concat(...[...field].map(f => inner.get(f) || []));
    if (base.length && base.every(e => nb.get(e))) for (const f of field) off.add(f);
  }
  for (const fi of noField) {
    const es = inner.get(fi);
    if (es && es.length && es.every(e => nb.get(e))) off.add(fi);
  }
  const w = new Writer();
  for (const e of edges(faces, ORDER_SCUMMVM)) {
    const fs = ef.get(e);
    if (fs.length >= 2) w.u32(nb.get(e) ? 0 : 1);
    else w.u32(off.has(fs[0]) ? 0 : 1);
  }
  return w.bytes();
}

// ------------------------------------------------------------------ save do jogo original
const NAT_NORMAL = new Set([4, 6, 8, 9, 11, 14, 21, 23, 27, 30]);
const NAT_CURRENT = new Set([2, 3, 4, 8, 9, 11, 16, 20, 29, 30, 33, 35]);
const CURRENT = new Set(['Current', 'CurrentCurrent', 'CurrentGlobal']);

function records(data) {
  const r = new Reader(data);
  const out = [];
  while (!r.end()) {
    const t = r.u8(), s = r.u8();
    out.push([t, s, r.raw(r.u32())]);
  }
  return out;
}

function readNative(data) {
  const r = new Reader(data);
  const h = { description: r.str32(), level: r.str32(), location: r.str32(), version: r.str32() };
  const v = key(h.version);
  if (!v.startsWith('Version:\t')) throw new Error('not a The Longest Journey save');
  if (v !== 'Version:\t06') throw new Error(`version "${v.slice(9)}": not a save from the original game (game.exe)`);
  h.extra = r.str32();
  if (h.extra.length > 8 || !/^\d+$/.test(key(h.extra))) {
    throw new Error('not a save from the original game (game.exe)');
  }
  h.trees = [];
  const nt = r.u32();
  for (let i = 0; i < nt; i++) { const k = r.str32(); h.trees.push([k, r.str32()]); }
  const d = { entries: [], fmv: [], conv: [] };
  let n = r.u32();
  for (let i = 0; i < n; i++) d.entries.push(r.str32());
  n = r.u32();
  for (let i = 0; i < n; i++) d.fmv.push([r.str32(), r.str32(), r.u32()]);
  n = r.u32();
  for (let i = 0; i < n; i++) {
    const e = { chapter: r.i32(), name: r.str32(), char: r.i32(), title: r.str32(), lines: [] };
    const nl = r.u32();
    for (let j = 0; j < nl; j++) { const c = r.i32(); e.lines.push([r.str32(), c]); }
    d.conv.push(e);
  }
  d.unread = r.u8();
  d.page = r.u32();
  h.diary = d;
  return h;
}

function match(order, recs, current) {
  const types = current ? NAT_CURRENT : NAT_NORMAL;
  const out = [];
  let j = 0;
  for (const n of order) {
    if (!types.has(n.t)) { out.push(null); continue; }
    if (j >= recs.length) throw new Error(`the save is missing data for "${text(n.name)}"`);
    const [t, s, b] = recs[j++];
    if (t !== n.t || s !== n.s) throw new Error(`the save does not match the game files ("${text(n.name)}")`);
    out.push(b);
  }
  if (j !== recs.length) throw new Error(`the save has ${recs.length - j} more records than the game files`);
  return out;
}

/** o jogo original guarda a direção como vetor; o ScummVM, como ângulo (vetor = cos a, -sin a) */
function directionAngle(x, y) {
  if (Math.abs(x) < 1e-9 && Math.abs(y) < 1e-9) return 0;
  const a = Math.atan2(-y, x) * (180 / Math.PI);
  return a < 0 ? a + 360 : a + 0;   // + 0: nunca -0
}

const pathKey = p => p.map(([t, i]) => `${t}.${i}`).join('/');

class Converter {
  constructor(game, nat, notes) {
    this.G = game;
    this.nat = nat;
    this.notes = notes;
    this.lvl = parseInt(key(nat.level), 16);
    this.loc = parseInt(key(nat.location), 16);
    this.trees = new Map(nat.trees.map(([k, d]) => [key(k), d]));
    this.stopped = new Set();     // itens cujo movimento não deu para converter
    this.prepare();
  }

  aligned(k) {
    const { nodes, level } = this.G.tree(Buffer.from(k, 'latin1'), this.lvl, this.loc);
    const order = traverse(nodes);
    return { nodes, level, order, recs: match(order, records(this.trees.get(k)), CURRENT.has(k)) };
  }

  prepare() {
    // inventário e índices de AnimHierarchy dos templates ficam nas árvores "Current" do jogo original
    this.inventory = [];
    const tpl = new Map();
    for (const [k, lv] of [['CurrentGlobal', 0], ['Current', this.lvl]]) {
      if (!this.trees.has(k)) continue;
      const a = this.aligned(k);
      a.order.forEach((n, i) => {
        const b = a.recs[i];
        if (!b) return;
        if (n.t === 8 && (n.s === 1 || n.s === 3) && b.length >= 20 && b.readUInt32LE(0) === 0) {
          tpl.set(`${lv}:${n.idx}`, b.readInt32LE(16));
        }
        if (k === 'CurrentGlobal' && n.t === 20 && n.s === 1 && b.length >= 4) {
          const cnt = b.readUInt32LE(0);
          for (let x = 0; x < cnt && 4 + x * 4 + 4 <= b.length; x++) this.inventory.push(b.readUInt32LE(4 + x * 4));
        }
      });
    }
    this.R = new Resolver(this.G, tpl);
    // movimentos que não dá para converter: os scripts que esperam por eles seguem em frente
    if (this.trees.has('CurrentCurrent')) {
      const a = this.aligned('CurrentCurrent');
      a.order.forEach((n, i) => {
        const b = a.recs[i];
        if (b && n.t === 8 && b.length >= 8 && b.readUInt32LE(0) === 1 && ![1, 3].includes(b.readUInt32LE(4))) {
          this.stopped.add(pathKey(refPath(a.nodes, n.i, a.level)));
        }
      });
    }
  }

  // ---- árvores normais (estado de cada fase)
  normal(nodes, n, b, level) {
    const { t, s } = n;
    const w = new Writer();
    if (t === 8) {
      const r = new Reader(b);
      const enabled = r.u8();
      if (s === 1 || s === 3) { w.i32(enabled); return w.bytes(); }
      const activity = r.i32();
      let anim = [];
      let action = [];
      if (enabled) { anim = r.ref(); action = r.ref(); } else { anim = this.R.defaultAnim(nodes, n.i, level); }
      w.i32(enabled);
      w.i32(activity);
      w.ref(anim);
      w.ref(action);
      if (s === 5 || s === 6 || s === 10) {
        const pos = [r.f32(), r.f32(), r.f32()];
        const dx = r.f32(), dy = r.f32();
        r.f32();
        const face = r.i32();
        pos.forEach(v => w.f32(v));
        w.f32(directionAngle(dx, dy));
        w.i32(face);
      }
      return w.bytes();
    }
    if (t === 9) { w.i32(b[0]); return w.bytes(); }
    if (t === 21) {
      const v = b && b.length >= 4 ? b.readInt32LE(0) : 0;
      if (s === 0 || s === 5) { w.i32(0); w.i32(v); w.ref([]); }
      else if (s === 2 || s === 3) { w.i32(v); w.i32(0); w.ref([]); }
      else if (s === 4) { w.i32(0); w.i32(0); w.ref(b && b.length ? new Reader(b).ref() : []); }
      else { w.i32(0); w.i32(0); w.ref([]); }
      return w.bytes();
    }
    if (t === 6) return convertFloor(nodes, n.i, b);
    if (t === 20) {
      if (s === 1) {
        const items = this.G.inventoryItems();
        const order = this.inventory.filter(v => v < items.length).map(v => items[v]);
        if (order.length !== this.inventory.length) this.notes.push('unknownItem');
        w.u32(order.length);
        order.forEach(v => w.u16(v));
      }
      return w.bytes();
    }
    if ([4, 11, 14, 23, 27, 30].includes(t) && b) return b;
    return Buffer.alloc(0);
  }

  // ---- árvores "Current" (estado do momento: sons, scripts em andamento, câmera...)
  current(nodes, n, b, level, isCurrentLocation) {
    const { t, s } = n;
    const w = new Writer();
    if (t === 3) return this.location(b, isCurrentLocation);
    if (t === 8) return this.itemCurrent(n, b);
    if (t === 9) return this.scriptCurrent(b);
    if (t === 11) {
      if (s === 3 && b.length >= 12) { w.i32(b.readInt32LE(4)); w.i32(b.readInt32LE(8)); return w.bytes(); }
      return b;
    }
    if (t === 16) {
      const r = new Reader(b);
      r.u32();
      const playing = r.u32();
      w.u32(playing);
      if (b.length >= 36 && playing && s !== 3) {
        w.u32(r.u32());   // tempo
        w.f32(r.f32());   // volume
        w.f32(r.f32());   // pan
        w.u32(r.u32());   // fade restante
        w.f32(r.f32());   // volume alvo
        w.f32(r.f32());   // pan alvo
      }
      return w.bytes();
    }
    if (t === 29) {
      if (b.length >= 4 && b.readUInt32LE(0) !== 0) {
        this.notes.push('speechStopped');
        w.u32(0);
        return w.bytes();
      }
      return b;
    }
    if ([4, 30, 33, 35].includes(t) && b) return b;
    return Buffer.alloc(0);
  }

  location(b, isCurrentLocation) {
    const w = new Writer();
    if (!isCurrentLocation) return Buffer.alloc(44);
    const r = new Reader(b);
    const sx = r.i32(), sy = r.i32();
    const f = [];
    for (let i = 0; i < 13; i++) f.push(r.u32());
    w.i32(sx);
    w.i32(sy);
    w.ref([]);
    const period = u32AsI32(f[5]);
    const sway = period > 0;
    let float = null;
    let angle = 0;
    if (sway) {
      // o ângulo do balanço e a flutuação vêm do comando do script da própria location
      const nodes = this.G.locationTree(this.G.levelByIndex(this.lvl), this.loc);
      for (const a of this.G.commands(nodes, 21)) if (a.length >= 5) angle = Math.abs(a[2]) % 360;
      for (const a of this.G.commands(nodes, 25)) {
        if (a.length >= 4) float = [a[1] >= 33 ? a[1] : 1000, a[2] / 10, a[3] / 100];
      }
    }
    if (float) { w.i32(float[0]); w.f32(float[1]); w.f32(float[2]); } else { w.i32(0); w.f32(0); w.f32(0); }
    if (sway) {
      w.i32(period);
      w.f32(u32AsF32(f[9]));    // amplitude
      w.f32(u32AsF32(f[10]));   // deslocamento
      w.f32(u32AsF32(f[11]));   // posição no ciclo
      w.f32(angle);
    } else {
      w.raw(Buffer.alloc(20));
    }
    return w.bytes();
  }

  scriptCurrent(b) {
    const r = new Reader(b);
    const started = r.u32();
    const w = new Writer();
    w.u32(started);
    if (!started) return w.bytes();
    w.ref(r.ref());
    const n = r.u32();
    w.u32(n);
    for (let i = 0; i < n; i++) w.ref(r.ref());
    w.i32(r.i32());
    const waiting = r.ref();
    w.ref(waiting);
    let status = r.i32();
    if (![0, 1, 2].includes(status)) status = this.stopped.has(pathKey(waiting)) ? 0 : 2;
    w.i32(status);
    return w.bytes();
  }

  itemCurrent(n, b) {
    const r = new Reader(b);
    if (!r.u32()) return b;
    const type = r.u32();
    try {
      const w = new Writer();
      r.u32();
      if (type === 1) {                     // andando até um ponto
        const dest = [r.f32(), r.f32(), r.f32()];
        r.u32();
        const running = r.u8();
        const script = r.u32() ? r.ref() : [];
        w.u32(1); w.u32(1);
        dest.forEach(v => w.f32(v));
        w.u32(running);
        w.ref(script);
      } else if (type === 3) {              // luz seguindo um caminho
        const p = r.ref();
        r.ref();
        const light = r.ref();
        r.u32(); r.u32();
        const pos = r.f32();
        r.f32(); r.f32();
        const speed = r.f32();
        const before = r.u32();
        const script = r.u32() ? r.ref() : [];
        w.u32(1); w.u32(3);
        w.ref(p); w.ref(light);
        w.f32(pos); w.f32(speed);
        w.u32(before);
        w.ref(script);
      } else {
        throw new RangeError(`movimento ${type}`);
      }
      w.raw(b.subarray(r.o));
      return w.bytes();
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
      this.notes.push('movementStopped');
      const w = new Writer();
      w.u32(0);
      w.raw(Converter.visualTail(b, n.s));
      return w.bytes();
    }
  }

  /** acha, do fim para o começo, onde começa a parte comum (atividade + 2 referências [+ 3 índices]) */
  static visualTail(b, sub) {
    const extra = sub === 10 ? 12 : ((sub === 1 || sub === 3) ? 16 : 0);
    for (let o = b.length - 12 - extra; o > 3; o--) {
      try {
        const r = new Reader(b, o);
        if (sub === 1 || sub === 3) r.raw(16);
        else { r.i32(); r.ref(); r.ref(); r.raw(extra); }
        if (r.o === b.length) return b.subarray(o);
      } catch (err) {
        if (!(err instanceof RangeError)) throw err;
      }
    }
    throw new Error('could not read the item movement');
  }

  // ---- árvore inteira
  tree(k) {
    const a = this.aligned(k);
    const cur = CURRENT.has(k);
    const w = new Writer();
    a.order.forEach((n, i) => {
      const b = a.recs[i];
      let d;
      if (cur) {
        d = b ? this.current(a.nodes, n, b, a.level, k === 'CurrentCurrent' && n.i === 0) : Buffer.alloc(0);
        if (n.t === 2 || n.t === 20) d = Buffer.alloc(0);
      } else {
        d = this.normal(a.nodes, n, b, a.level);
      }
      w.u8(n.t);
      w.u8(n.s);
      w.u32(d.length);
      w.raw(d);
    });
    return w.bytes();
  }

  // ---- pilha de locations (para voltar de um close-up 2D)
  locationStack() {
    const lv = this.G.levelByIndex(this.lvl);
    const nodes = this.G.locationTree(lv, this.loc);
    if (nodes.some(n => n.t === 4 && n.s === 2)) return [];
    const origins = [];
    const seen = new Set();
    for (const l of this.G.levels) {
      if (l.s !== 2) continue;
      let locs = [];
      try { locs = this.G.locations(l); } catch (err) { continue; }
      for (const loc of locs) {
        let tree;
        try { tree = this.G.locationTree(l, loc.idx); } catch (err) { continue; }
        for (const a of this.G.commands(tree, 17)) {
          if (a.length < 2 || !Buffer.isBuffer(a[0]) || !Buffer.isBuffer(a[1])) continue;
          const tl = parseInt(key(a[0]), 16), tc = parseInt(key(a[1]), 16);
          const id = `${l.idx}:${loc.idx}`;
          if (tl === this.lvl && tc === this.loc && !seen.has(id)) { seen.add(id); origins.push([l, loc]); }
        }
      }
    }
    if (!origins.length) return [];
    const visited = origins.filter(([l, loc]) => this.trees.has(key(l.name) + key(loc.name)));
    const [l, loc] = (visited.length ? visited : origins)[0];
    if (origins.length > 1) this.notes.push('returnGuessed');
    return [[l.idx, loc.idx, 0]];
  }
}

// ------------------------------------------------------------------ miniatura e Index.dat
/** TGA 24/32 bits sem compressão -> pixels RGBA de cima para baixo (160x92) */
function readTga(file) {
  try {
    const d = fs.readFileSync(file);
    const idl = d[0], cmap = d[1], type = d[2];
    const w = d.readUInt16LE(12), h = d.readUInt16LE(14);
    const bpp = d[16], desc = d[17];
    if (type !== 2 || cmap || (bpp !== 24 && bpp !== 32)) return null;
    const bp = bpp / 8;
    const o = 18 + idl;
    if (d.length < o + w * h * bp) return null;
    const out = Buffer.alloc(THUMB_SIZE);
    for (let y = 0; y < THUMB_H; y++) {
      let sy = Math.floor(y * h / THUMB_H);
      if (!(desc & 0x20)) sy = h - 1 - sy;
      for (let x = 0; x < THUMB_W; x++) {
        const sx = Math.floor(x * w / THUMB_W);
        const si = o + (sy * w + sx) * bp;
        const di = (y * THUMB_W + x) * 4;
        out[di] = d[si + 2];
        out[di + 1] = d[si + 1];
        out[di + 2] = d[si];
        out[di + 3] = 255;
      }
    }
    return out;
  } catch (err) {
    return null;
  }
}

/** Index.dat do jogo original: uma linha por slot, "Nome<TAB>HH:MM:SS MM/DD/AA" */
function readIndex(dir) {
  const out = new Map();
  const p = ci(dir, 'Index.dat');
  if (!p) return out;
  let lines;
  try { lines = fs.readFileSync(p).toString('latin1').split('\r\n'); } catch (err) { return out; }
  lines.slice(2).forEach((l, i) => {
    l = l.replace(/[\r\n]+$/, '');
    if (!l) return;
    const tab = l.indexOf('\t');
    const name = Buffer.from(tab >= 0 ? l.slice(0, tab) : l, 'latin1');
    const m = /^(\d+):(\d+):(\d+) (\d+)\/(\d+)\/(\d+)/.exec((tab >= 0 ? l.slice(tab + 1) : '').trim());
    let when = null;
    if (m) {
      const [hh, mi, ss, mm, dd, aa] = m.slice(1).map(Number);
      if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31 && hh < 24 && mi < 60 && ss < 60) {
        when = { year: aa < 70 ? 2000 + aa : 1900 + aa, month: mm, day: dd, hour: hh, minute: mi, second: ss };
      }
    }
    out.set(i, { name, when });
  });
  return out;
}

// ------------------------------------------------------------------ gravação no formato do ScummVM
function buildScummVM(desc, lvl, loc, when, thumb, trees, diary, stack) {
  const w = new Writer();
  w.str32(desc);
  w.str32(Buffer.from(lvl.toString(16).padStart(2, '0'), 'latin1'));
  w.str32(Buffer.from(loc.toString(16).padStart(2, '0'), 'latin1'));
  w.str32(Buffer.from(`Version:\t${String(SAVE_VERSION).padStart(2, '0')}`, 'latin1'));
  w.u8(when.day);
  w.u8(when.month);
  w.u16be(when.year);
  w.u8(when.hour);
  w.u8(when.minute);
  w.i32(0);                       // tempo de jogo: o jogo original não guarda
  w.u8(when.second);
  w.raw(thumb || Buffer.alloc(THUMB_SIZE));
  w.u32(trees.length);
  for (const [k, d] of trees) { w.str32(k); w.u32(SAVE_VERSION); w.str32(d); }
  w.u32(diary.entries.length);
  diary.entries.forEach(e => w.str32(e));
  w.u32(diary.fmv.length);
  for (const [fn, title, disc] of diary.fmv) { w.str32(fn); w.str32(title); w.u32(disc); }
  w.u32(diary.conv.length);
  for (const c of diary.conv) {
    w.i32(c.chapter);
    w.i32(c.char);
    w.str32(c.name);
    w.str32(c.title);
    w.u32(c.lines.length);
    for (const [line, ch] of c.lines) { w.str32(line); w.i32(ch); }
  }
  w.u8(diary.unread);
  w.u32(diary.page);
  w.u32(stack.length);
  for (const [lv, lc, inv] of stack) { w.u16(lv); w.u16(lc); w.u32(inv); }
  return w.bytes();
}

/** relê o save gerado como o ScummVM lê e confere cada árvore com os arquivos do jogo */
function verifyScummVM(data, game) {
  const r = new Reader(data);
  r.str32();
  const lvl = parseInt(key(r.str32()), 16);
  const loc = parseInt(key(r.str32()), 16);
  const ver = parseInt(key(r.str32()).split('\t')[1], 10);
  r.raw(11 + THUMB_SIZE);
  const nt = r.u32();
  for (let i = 0; i < nt; i++) {
    const k = r.str32();
    const tv = r.u32();
    const d = r.str32();
    const order = traverse(game.tree(k, lvl, loc).nodes);
    const recs = records(d);
    if (tv !== ver || recs.length !== order.length || order.some((n, j) => n.t !== recs[j][0] || n.s !== recs[j][1])) {
      throw new Error(`converted state of "${text(k)}" does not match the game files`);
    }
  }
  let n = r.u32();
  for (let i = 0; i < n; i++) r.str32();
  n = r.u32();
  for (let i = 0; i < n; i++) { r.str32(); r.str32(); r.u32(); }
  n = r.u32();
  for (let i = 0; i < n; i++) {
    r.i32(); r.i32(); r.str32(); r.str32();
    const nl = r.u32();
    for (let j = 0; j < nl; j++) { r.str32(); r.i32(); }
  }
  r.u8(); r.u32();
  n = r.u32();
  for (let i = 0; i < n; i++) { r.u16(); r.u16(); r.u32(); }
  if (!r.end()) throw new Error(`${data.length - r.o} bytes left over`);
}

const NATIVE_SAVE = /^save(\d+)\.tlj$/i;

/** número do slot de um SaveNN.tlj (ou null) */
function nativeSlot(file) {
  const m = NATIVE_SAVE.exec(String(file).split(/[\\/]/).pop());
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Converte um save do jogo original.
 * @param {Game} game  arquivos do jogo (new Game(pastaDoJogo))
 * @param {string} file  SaveNN.tlj (o .tga e o Index.dat da mesma pasta são usados se existirem)
 * @param {Map} [index]  readIndex(pasta) já lido, para não reler a cada save
 * @returns {{data: Buffer, slot: number, description: string, location: string, notes: string[]}}
 *          data = save do ScummVM já comprimido (gzip), como o ScummVM grava
 */
function convertSave(game, file, index) {
  let raw = fs.readFileSync(file);
  if (raw[0] === 0x1f && raw[1] === 0x8b) raw = zlib.gunzipSync(raw);
  const nat = readNative(raw);
  const notes = [];
  const C = new Converter(game, nat, notes);
  const trees = [];
  for (const [k] of nat.trees) {
    try {
      trees.push([k, C.tree(key(k))]);
    } catch (err) {
      if (err.code !== 'NOTREE') throw err;
      notes.push('missingTree');
    }
  }
  const names = game.characters();
  const d = nat.diary;
  const diary = {
    entries: d.entries, unread: d.unread, page: d.page,
    fmv: d.fmv.map(([fn, title, disc]) => [Buffer.from(key(fn).split(/[\\/]/).pop(), 'latin1'), title, disc]),
    conv: d.conv.map(c => ({ ...c, name: names.get(c.char) || c.name })),
  };
  const slot = nativeSlot(file);
  const idx = index || readIndex(path.dirname(file));
  const entry = slot !== null ? idx.get(slot) : undefined;
  let when = entry && entry.when;
  if (!when) {
    const t = fs.statSync(file).mtime;
    when = { year: t.getFullYear(), month: t.getMonth() + 1, day: t.getDate(),
             hour: t.getHours(), minute: t.getMinutes(), second: t.getSeconds() };
  }
  const desc = (entry && entry.name.length) ? entry.name
    : Buffer.from(`Save ${String(slot === null ? 0 : slot).padStart(2, '0')}`, 'latin1');
  const tga = ci(path.dirname(file), path.basename(file).replace(/\.tlj$/i, '.tga'));
  const thumb = tga ? readTga(tga) : null;
  const data = buildScummVM(desc, C.lvl, C.loc, when, thumb, trees, diary, C.locationStack());
  verifyScummVM(data, game);
  return {
    data: zlib.gzipSync(data), raw: data, slot, description: text(desc),
    location: game.locationName(C.lvl, C.loc), notes: [...new Set(notes)],
  };
}

module.exports = { Game, convertSave, readIndex, nativeSlot, NATIVE_SAVE, SAVE_VERSION,
                   _internals: { readNative, readXrc, parseXrc, convertFloor, directionAngle, records, traverse } };
