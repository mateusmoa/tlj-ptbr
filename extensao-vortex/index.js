/*
 * Vortex: suporte ao jogo The Longest Journey (2000, Funcom)
 *
 *  - encontra o jogo na Steam (6310) e na GOG (1207658794);
 *  - os mods vão para a pasta do jogo (onde fica o game.exe);
 *  - instalador para mods de tradução em formato .tljpatch: o pacote traz só
 *    os textos traduzidos e o instalador gera os .xarc traduzidos a partir dos
 *    arquivos ORIGINAIS do próprio jogador (nenhum arquivo do jogo é distribuído);
 *  - instalador para mods "soltos" (pastas 08..7c, global, static, *.ini),
 *    mesmo quando vêm dentro de uma pasta extra no zip.
 *
 * Sem dependências externas; código aberto e legível de propósito.
 * Licença: GPL-3.0
 */
'use strict';

const path = require('path');
const fsp = require('fs').promises;
const zlib = require('zlib');
const crypto = require('crypto');
const { util, log } = require('vortex-api');

const GAME_ID = 'thelongestjourney';
const STEAM_ID = '6310';
const GOG_ID = '1207658794';
const BACKUP_TAG = '.vortex_backup';      // nome que o Vortex dá aos originais que ele substitui
const OUT_DIR = '__tlj_gerado';

// ---------------------------------------------------------------- formato .tljpatch
const MAGIC = Buffer.from('TLJPTBR\u0001', 'latin1');
const KIND_XARC = 1, KIND_FILE = 2;
const OP_SPEECH = 1, OP_IMGTEXT = 2, OP_RENAME = 3, OP_DATA = 4;

class PatchError extends Error {}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest();

function readPatch(raw) {
  let d = raw;
  if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) {   // versões antigas vinham em gzip
    try { d = zlib.gunzipSync(raw); } catch (err) { throw new PatchError('arquivo .tljpatch corrompido'); }
  }
  let o = 0;
  const take = (n) => {
    if (o + n > d.length) throw new PatchError('arquivo .tljpatch truncado');
    const b = d.subarray(o, o + n); o += n; return b;
  };
  const u8 = () => take(1)[0];
  const u16 = () => take(2).readUInt16LE(0);
  const u32 = () => take(4).readUInt32LE(0);
  const s16 = () => take(u16()).toString('utf8');
  if (!take(8).equals(MAGIC)) throw new PatchError('formato de patch desconhecido');
  const patch = { version: s16(), title: s16(), entries: [] };
  const n = u32();
  for (let i = 0; i < n; i++) {
    const e = { kind: u8(), path: s16(), edits: [] };
    if (e.kind === KIND_XARC) {
      e.shaEn = take(20); e.sizeEn = u32();
      e.shaOut = take(20); e.sizeOut = u32();
      e.nodeCount = u32();
      const ne = u32();
      for (let k = 0; k < ne; k++) {
        const ed = { node: u32(), type: u8(), sub: u8(), op: u8(), aux: u32(), crcOrig: u32(), crcKeep: u32() };
        ed.payload = take(u32());
        e.edits.push(ed);
      }
    } else if (e.kind === KIND_FILE) {
      e.shaEn = take(20); e.shaOut = take(20); e.content = take(u32());
    } else {
      throw new PatchError('tipo de entrada desconhecido no patch');
    }
    patch.entries.push(e);
  }
  return patch;
}

function parseNodes(x) {
  const nodes = [];
  const stack = [1];
  let o = 0;
  while (stack.length > 0) {
    if (stack[stack.length - 1] === 0) { stack.pop(); continue; }
    stack[stack.length - 1] -= 1;
    if (o + 6 > x.length) throw new PatchError('árvore .xrc truncada');
    const nameOff = o + 4;
    const nameLen = x.readUInt16LE(nameOff);
    const dataOff = nameOff + 2 + nameLen;
    if (dataOff + 4 > x.length) throw new PatchError('árvore .xrc truncada');
    const dataLen = x.readUInt32LE(dataOff);
    o = dataOff + 4 + dataLen;
    if (o + 4 > x.length) throw new PatchError('árvore .xrc truncada');
    const nch = x.readUInt16LE(o);
    o += 4;
    nodes.push({ type: x[nameOff - 4], sub: x[nameOff - 3], nameOff, nameLen, dataOff, dataLen });
    stack.push(nch);
  }
  return nodes;
}

const le16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v, 0); return b; };
const le32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); return b; };

/** Aplica um patch .xarc. Retorna { data, status, others }.
 *  status: 'original' | 'ja_instalado' | 'atualizado' | 'divergente' */
function applyXarc(buf, e) {
  const h = sha1(buf);
  if (h.equals(e.shaOut) && buf.length === e.sizeOut) return { data: buf, status: 'ja_instalado', others: 0 };
  const isOrig = h.equals(e.shaEn) && buf.length === e.sizeEn;
  if (buf.length < 12) throw new PatchError('arquivo .xarc muito pequeno');
  const version = buf.readUInt32LE(0), num = buf.readUInt32LE(4), first = buf.readUInt32LE(8);
  const members = [];
  let o = 12;
  for (let i = 0; i < num; i++) {
    const z = buf.indexOf(0, o);
    if (z < 0 || z + 9 > buf.length) throw new PatchError('tabela do .xarc inconsistente');
    const name = buf.subarray(o, z);
    o = z + 1;
    members.push({ name, len: buf.readUInt32LE(o), flag: buf.readUInt32LE(o + 4) });
    o += 8;
  }
  let off = first;
  for (const m of members) {
    if (off + m.len > buf.length) throw new PatchError('tabela do .xarc inconsistente');
    m.off = off; off += m.len;
  }
  if (off !== buf.length) throw new PatchError('tamanho do .xarc inconsistente');
  const xi = members.findIndex(m => m.name.toString('latin1').toLowerCase().endsWith('.xrc'));
  if (xi < 0) throw new PatchError('o .xarc não contém .xrc');
  const xrc = buf.subarray(members[xi].off, members[xi].off + members[xi].len);
  const nodes = parseNodes(xrc);
  if (nodes.length !== e.nodeCount) {
    throw new PatchError(`estrutura diferente da esperada (${nodes.length} nós, esperado ${e.nodeCount})`);
  }
  const reps = [];
  let others = 0;
  for (const ed of e.edits) {
    const nd = nodes[ed.node];
    if (nd === undefined) throw new PatchError('nó inexistente');
    if (nd.type !== ed.type || nd.sub !== ed.sub) throw new PatchError('tipo de nó diferente do esperado');
    if (ed.op === OP_RENAME) {
      const cur = xrc.subarray(nd.nameOff + 2, nd.nameOff + 2 + nd.nameLen);
      if (!cur.equals(ed.payload) && crc32(cur) !== ed.crcOrig) others++;
      reps.push([nd.nameOff, nd.nameOff + 2 + nd.nameLen, Buffer.concat([le16(ed.payload.length), ed.payload])]);
      continue;
    }
    const data = xrc.subarray(nd.dataOff + 4, nd.dataOff + 4 + nd.dataLen);
    let nw;
    if (ed.op === OP_SPEECH) {
      if (data.length < 2) throw new PatchError('fala inválida');
      const tl = data.readUInt16LE(0);
      if (2 + tl > data.length) throw new PatchError('fala inválida');
      const cur = data.subarray(2, 2 + tl), tail = data.subarray(2 + tl);
      if (crc32(tail) !== ed.crcKeep) throw new PatchError('dados da fala diferentes do esperado');
      if (!cur.equals(ed.payload) && crc32(cur) !== ed.crcOrig) others++;
      nw = Buffer.concat([le16(ed.payload.length), ed.payload, tail]);
    } else if (ed.op === OP_IMGTEXT) {
      const x = ed.aux;
      if (x + 2 > data.length) throw new PatchError('texto de imagem inválido');
      const tl = data.readUInt16LE(x);
      if (x + 2 + tl > data.length) throw new PatchError('texto de imagem inválido');
      const head = data.subarray(0, x), cur = data.subarray(x + 2, x + 2 + tl), trail = data.subarray(x + 2 + tl);
      if (crc32(Buffer.concat([head, trail])) !== ed.crcKeep) throw new PatchError('dados do texto de imagem diferentes do esperado');
      if (!cur.equals(ed.payload) && crc32(cur) !== ed.crcOrig) others++;
      nw = Buffer.concat([head, le16(ed.payload.length), ed.payload, trail]);
    } else if (ed.op === OP_DATA) {
      if (!data.equals(ed.payload) && crc32(data) !== ed.crcOrig) others++;
      nw = ed.payload;
    } else {
      throw new PatchError('operação desconhecida no patch');
    }
    reps.push([nd.dataOff, nd.dataOff + 4 + nd.dataLen, Buffer.concat([le32(nw.length), nw])]);
  }
  reps.sort((a, b) => a[0] - b[0]);
  const parts = [];
  let pos = 0;
  for (const [a, b, bytes] of reps) {
    if (a < pos) throw new PatchError('edições sobrepostas');
    parts.push(xrc.subarray(pos, a), bytes);
    pos = b;
  }
  parts.push(xrc.subarray(pos));
  const newXrc = Buffer.concat(parts);
  const table = [];
  members.forEach((m, i) => {
    table.push(m.name, Buffer.from([0]), le32(i === xi ? newXrc.length : m.len), le32(m.flag));
  });
  const tableBuf = Buffer.concat(table);
  const out = [le32(version), le32(members.length), le32(12 + tableBuf.length), tableBuf];
  members.forEach((m, i) => out.push(i === xi ? newXrc : buf.subarray(m.off, m.off + m.len)));
  const res = Buffer.concat(out);
  const ok = sha1(res).equals(e.shaOut) && res.length === e.sizeOut;
  if (isOrig) {
    if (!ok) throw new PatchError('resultado inesperado (patch e jogo não combinam)');
    return { data: res, status: 'original', others: 0 };
  }
  return { data: res, status: ok ? 'atualizado' : 'divergente', others };
}

function applyEntry(buf, e) {
  if (e.kind === KIND_FILE) {
    if (buf && sha1(buf).equals(e.shaOut)) return { data: buf, status: 'ja_instalado', others: 0 };
    return { data: e.content, status: (buf && sha1(buf).equals(e.shaEn)) ? 'original' : 'atualizado', others: 0 };
  }
  if (!buf) throw new PatchError('arquivo não encontrado');
  return applyXarc(buf, e);
}

// ---------------------------------------------------------------- utilidades
/** Acha o caminho real (com as maiúsculas/minúsculas do disco) de rel dentro de root. */
async function resolveCi(root, rel, cache) {
  let cur = root;
  const real = [];
  for (const part of rel.split(/[\\/]/).filter(p => p.length > 0)) {
    let names = cache.get(cur);
    if (names === undefined) {
      try { names = await fsp.readdir(cur); } catch (err) { names = []; }
      cache.set(cur, names);
    }
    const hit = names.find(n => n === part) || names.find(n => n.toLowerCase() === part.toLowerCase());
    const name = hit || part;
    real.push(name);
    cur = path.join(cur, name);
  }
  return { abs: cur, rel: real.join(path.sep) };
}

async function readIfExists(p) {
  try { return await fsp.readFile(p); } catch (err) { return null; }
}

function gamePath(api) {
  const state = api.getState();
  return util.getSafe(state, ['settings', 'gameMode', 'discovered', GAME_ID, 'path'], undefined);
}

// ---------------------------------------------------------------- abrir o jogo
// O game.exe da versão Steam tem a proteção da Steam: aberto direto, ele mostra
// "Failed to find Steam". Por isso a versão Steam é aberta pela própria Steam.
// GOG e outras cópias não têm proteção e abrem direto pelo game.exe.
async function requiresLauncher(gamePath, store) {
  const inSteamLibrary = String(gamePath || '').toLowerCase().split(/[\\/]/).includes('steamapps');
  if (store !== 'steam' && !(store === undefined && inSteamLibrary)) {
    return undefined;
  }
  try {
    await util.steam.findByAppId(STEAM_ID);
    return { launcher: 'steam' };   // Vortex usa details.steamAppId -> steam.exe -applaunch 6310
  } catch (err) {
    // a Steam do Vortex não listou o jogo: abre pelo protocolo steam://launch/6310
    return { launcher: 'steam', addInfo: { appId: STEAM_ID, parameters: [], launchType: 'gamestore' } };
  }
}

// ---------------------------------------------------------------- instalador: tradução .tljpatch
function testPatchMod(files, gameId) {
  const supported = (gameId === GAME_ID)
    && files.some(f => path.basename(f).toLowerCase().endsWith('.tljpatch'));
  return Promise.resolve({ supported, requiredFiles: [] });
}

function makeInstallPatchMod(api) {
  return async (files, destinationPath, gameId, progress) => {
    const patchRel = files.find(f => path.basename(f).toLowerCase().endsWith('.tljpatch'));
    const game = gamePath(api);
    if (!game) {
      throw new util.ProcessCanceled('The Longest Journey não foi encontrado. Abra a aba Games e configure o jogo primeiro.');
    }
    let patch;
    try {
      patch = readPatch(await fsp.readFile(path.join(destinationPath, patchRel)));
    } catch (err) {
      throw new util.ProcessCanceled(`Não foi possível ler ${path.basename(patchRel)}: ${err.message}`);
    }
    log('info', 'tlj: aplicando patch', { version: patch.version, entries: patch.entries.length, game });
    const cache = new Map();
    const instructions = [];
    const problems = [];
    const counts = {};
    for (let i = 0; i < patch.entries.length; i++) {
      const e = patch.entries[i];
      const real = await resolveCi(game, e.path, cache);
      // se o Vortex já substituiu o arquivo (mod instalado), o original está no .vortex_backup
      let buf = await readIfExists(real.abs + BACKUP_TAG);
      if (buf === null) buf = await readIfExists(real.abs);
      if (buf === null && e.kind === KIND_XARC) {
        problems.push(`faltando: ${e.path}`);
        continue;
      }
      let res;
      try {
        res = applyEntry(buf, e);
      } catch (err) {
        problems.push(`diferente: ${e.path} (${err.message})`);
        continue;
      }
      counts[res.status] = (counts[res.status] || 0) + 1;
      const outRel = path.join(OUT_DIR, real.rel);
      const outAbs = path.join(destinationPath, outRel);
      await fsp.mkdir(path.dirname(outAbs), { recursive: true });
      await fsp.writeFile(outAbs, res.data);
      instructions.push({ type: 'copy', source: outRel, destination: real.rel });
      if (progress && (i % 10 === 0)) progress(Math.round((i * 100) / patch.entries.length));
    }
    if (problems.length > 0) {
      const lista = problems.slice(0, 12).map(p => '- ' + p).join('\n');
      api.showDialog('error', 'Tradução não instalada', {
        text: 'Alguns arquivos do jogo não são os esperados (podem ser de outra versão, estar corrompidos '
          + 'ou ter sido substituídos por uma tradução copiada manualmente):\n\n' + lista
          + (problems.length > 12 ? `\n... e mais ${problems.length - 12}` : '')
          + '\n\nSolução: desinstale outros mods que mexem nesses arquivos e, na Steam, use '
          + 'Propriedades > Arquivos instalados > Verificar integridade (na GOG Galaxy: Gerenciar '
          + 'instalação > Verificar/Reparar). Depois instale a tradução de novo.',
      }, [{ label: 'Fechar' }]);
      throw new util.ProcessCanceled('arquivos do jogo diferentes do esperado');
    }
    log('info', 'tlj: patch aplicado', counts);
    if (progress) progress(100);
    return { instructions };
  };
}

// ---------------------------------------------------------------- instalador: arquivos soltos
const ROOT_DIR = /^([0-9a-f]{2}|global|static)$/i;
const ROOT_FILE = /^(chapters\.ini|language\.ini|gui\.ini|w_world\.ini|x\.xarc)$/i;

/** índice do primeiro segmento que pertence à raiz do jogo, ou -1 */
function rootIndex(file) {
  const parts = file.split(/[\\/]/).filter(p => p.length > 0);
  for (let i = 0; i < parts.length; i++) {
    if (i === parts.length - 1) return ROOT_FILE.test(parts[i]) ? i : -1;
    if (ROOT_DIR.test(parts[i]) && parts.slice(i + 1).some(p => /\.xarc$/i.test(p))) return i;
  }
  return -1;
}

function testRootMod(files, gameId) {
  const supported = (gameId === GAME_ID)
    && !files.some(f => path.basename(f).toLowerCase().endsWith('.tljpatch'))
    && files.some(f => rootIndex(f) >= 0);
  return Promise.resolve({ supported, requiredFiles: [] });
}

function makeInstallRootMod(api) {
  return async (files) => {
    // o "prefixo" (pasta extra do zip) mais comum entre os arquivos do jogo
    const votes = new Map();
    for (const f of files) {
      const idx = rootIndex(f);
      if (idx < 0) continue;
      const pre = f.split(/[\\/]/).filter(p => p.length > 0).slice(0, idx).join('/');
      votes.set(pre, (votes.get(pre) || 0) + 1);
    }
    let prefix = '';
    let best = -1;
    for (const [pre, n] of votes) if (n > best) { best = n; prefix = pre; }
    const game = gamePath(api);
    const cache = new Map();
    const instructions = [];
    for (const f of files) {
      if (f.endsWith('/') || f.endsWith('\\')) continue;
      const parts = f.split(/[\\/]/).filter(p => p.length > 0);
      const pre = prefix ? prefix.split('/') : [];
      if (parts.length <= pre.length || parts.slice(0, pre.length).join('/') !== pre.join('/')) continue;
      const rel = parts.slice(pre.length).join('/');
      if (rel.toLowerCase().endsWith('.vortex_backup')) continue;
      const dest = game ? (await resolveCi(game, rel, cache)).rel : rel.split('/').join(path.sep);
      instructions.push({ type: 'copy', source: f, destination: dest });
    }
    return { instructions };
  };
}

// ---------------------------------------------------------------- registro
function main(context) {
  context.registerGame({
    id: GAME_ID,
    name: 'The Longest Journey',
    shortName: 'TLJ',
    mergeMods: true,
    logo: 'gameart.png',
    // com as duas versões instaladas, prefere a da Steam (sem isso o Vortex escolhe a GOG,
    // que tem prioridade padrão maior); quem já tinha uma descoberta continua com a dela
    queryArgs: {
      steam: [{ id: STEAM_ID, prefer: 1 }],
      gog: [{ id: GOG_ID, prefer: 2 }],
    },
    queryModPath: () => '.',
    executable: () => 'game.exe',
    requiredFiles: ['game.exe', 'x.xarc'],
    supportedTools: [
      {
        id: 'tlj-configure',
        name: 'Configurações (configure.exe)',
        executable: () => 'configure.exe',
        requiredFiles: ['configure.exe'],
        relative: true,
      },
    ],
    requiresLauncher,
    details: {
      steamAppId: +STEAM_ID,
      gogAppId: GOG_ID,
    },
  });

  context.registerInstaller('tlj-tljpatch', 25, testPatchMod, makeInstallPatchMod(context.api));
  context.registerInstaller('tlj-root-files', 30, testRootMod, makeInstallRootMod(context.api));
  return true;
}

module.exports = {
  default: main,
  // exportado só para testes automatizados
  _internals: { readPatch, applyEntry, applyXarc, crc32, rootIndex, resolveCi, GAME_ID },
};
