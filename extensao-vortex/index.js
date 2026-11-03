/*
 * Vortex: suporte ao jogo The Longest Journey (2000, Funcom)
 *
 *  - encontra o jogo na Steam (6310) e na GOG (1207658794);
 *  - os mods vão para a pasta do jogo (onde fica o game.exe);
 *  - instalador para mods de tradução em formato .tljpatch: o pacote traz só
 *    os textos traduzidos e o instalador gera os .xarc traduzidos a partir dos
 *    arquivos ORIGINAIS do próprio jogador (nenhum arquivo do jogo é distribuído);
 *  - instalador para mods "soltos" (pastas 08..7c, global, static, *.ini,
 *    vídeos .bbb dos FMV Packs), mesmo quando vêm dentro de uma pasta extra no zip;
 *  - instalador para mods do ScummVM, como o TLJ HD Mod: o resultado é o mesmo
 *    de extrair o zip na pasta do jogo (mods/<NomeDoMod>/.../xarc/, fonts/);
 *  - ScummVM automático: com mods do ScummVM ativos, o botão Jogar abre o jogo no
 *    ScummVM (acha ou baixa o ScummVM oficial, cadastra o jogo e, se a tradução
 *    trocou o chapters.ini, usa uma pasta-sombra com o original, que é por onde o
 *    ScummVM reconhece o jogo). O botão "ScummVM" da aba Mods mostra onde ficam os saves
 *    e remove o ScummVM que o Vortex baixou (sem tocar nos saves nem nos arquivos do jogo). Na primeira
 *    vez no ScummVM, avisa que os saves do jogo original não abrem nele (formatos diferentes) e
 *    oferece converter cópias deles para o ScummVM (saveconv.js); os originais não mudam.
 *  - mensagens em 15 idiomas (locales/): alemão, chinês simplificado, coreano, espanhol,
 *    francês, holandês, húngaro, inglês, italiano, norueguês, polonês, português do Brasil,
 *    russo, sueco e tcheco.
 *
 * Sem dependências externas; código aberto e legível de propósito.
 * Licença: GPL-3.0
 */
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = require('fs').promises;
const http = require('http');
const https = require('https');
const stream = require('stream');
const nodeUtil = require('util');
const zlib = require('zlib');
const crypto = require('crypto');
const { actions, util, log, selectors } = require('vortex-api');

const GAME_ID = 'thelongestjourney';
const STEAM_ID = '6310';
const GOG_ID = '1207658794';
const BACKUP_TAG = '.vortex_backup';      // nome que o Vortex dá aos originais que ele substitui
const OUT_DIR = '__tlj_gerado';

// ---------------------------------------------------------------- idioma das mensagens
// O idioma do Vortex tem prioridade; no padrão inglês, mantém a preferência pelo idioma do sistema.
const { pickLanguage, translate } = require('./i18n');
let saveconv = require('./saveconv');   // conversor de saves do jogo original -> ScummVM
let apiRef;   // api do Vortex (definida em main), para ler o idioma escolhido nas configurações

function vortexLanguage() {
  try { return util.getSafe(apiRef.getState(), ['settings', 'interface', 'language'], undefined); } catch (err) { return undefined; }
}

/** idioma do sistema: no Vortex, navigator.language é o idioma de exibição do Windows */
function systemLocale() {
  try {
    if (typeof navigator !== 'undefined' && navigator.language) return String(navigator.language);
  } catch (err) {
    // sem navigator
  }
  const env = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG;
  if (env) return env;
  try { return Intl.DateTimeFormat().resolvedOptions().locale || ''; } catch (err) { return ''; }
}

const tr = (key, values) => translate(pickLanguage(vortexLanguage(), systemLocale()), key, values);

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
    try { d = zlib.gunzipSync(raw); } catch (err) { throw new PatchError(tr('patchCorrupted')); }
  }
  let o = 0;
  const take = (n) => {
    if (o + n > d.length) throw new PatchError(tr('patchTruncated'));
    const b = d.subarray(o, o + n); o += n; return b;
  };
  const u8 = () => take(1)[0];
  const u16 = () => take(2).readUInt16LE(0);
  const u32 = () => take(4).readUInt32LE(0);
  const s16 = () => take(u16()).toString('utf8');
  if (!take(8).equals(MAGIC)) throw new PatchError(tr('patchUnknown'));
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
      throw new PatchError(tr('entryUnknown'));
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
    if (o + 6 > x.length) throw new PatchError(tr('xrcTruncated'));
    const nameOff = o + 4;
    const nameLen = x.readUInt16LE(nameOff);
    const dataOff = nameOff + 2 + nameLen;
    if (dataOff + 4 > x.length) throw new PatchError(tr('xrcTruncated'));
    const dataLen = x.readUInt32LE(dataOff);
    o = dataOff + 4 + dataLen;
    if (o + 4 > x.length) throw new PatchError(tr('xrcTruncated'));
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
  if (buf.length < 12) throw new PatchError(tr('xarcTooSmall'));
  const version = buf.readUInt32LE(0), num = buf.readUInt32LE(4), first = buf.readUInt32LE(8);
  const members = [];
  let o = 12;
  for (let i = 0; i < num; i++) {
    const z = buf.indexOf(0, o);
    if (z < 0 || z + 9 > buf.length) throw new PatchError(tr('xarcTable'));
    const name = buf.subarray(o, z);
    o = z + 1;
    members.push({ name, len: buf.readUInt32LE(o), flag: buf.readUInt32LE(o + 4) });
    o += 8;
  }
  let off = first;
  for (const m of members) {
    if (off + m.len > buf.length) throw new PatchError(tr('xarcTable'));
    m.off = off; off += m.len;
  }
  if (off !== buf.length) throw new PatchError(tr('xarcSize'));
  const xi = members.findIndex(m => m.name.toString('latin1').toLowerCase().endsWith('.xrc'));
  if (xi < 0) throw new PatchError(tr('xarcNoXrc'));
  const xrc = buf.subarray(members[xi].off, members[xi].off + members[xi].len);
  const nodes = parseNodes(xrc);
  if (nodes.length !== e.nodeCount) {
    throw new PatchError(tr('structureUnexpected', { count: nodes.length, expected: e.nodeCount }));
  }
  const reps = [];
  let others = 0;
  for (const ed of e.edits) {
    const nd = nodes[ed.node];
    if (nd === undefined) throw new PatchError(tr('nodeMissing'));
    if (nd.type !== ed.type || nd.sub !== ed.sub) throw new PatchError(tr('nodeType'));
    if (ed.op === OP_RENAME) {
      const cur = xrc.subarray(nd.nameOff + 2, nd.nameOff + 2 + nd.nameLen);
      if (!cur.equals(ed.payload) && crc32(cur) !== ed.crcOrig) others++;
      reps.push([nd.nameOff, nd.nameOff + 2 + nd.nameLen, Buffer.concat([le16(ed.payload.length), ed.payload])]);
      continue;
    }
    const data = xrc.subarray(nd.dataOff + 4, nd.dataOff + 4 + nd.dataLen);
    let nw;
    if (ed.op === OP_SPEECH) {
      if (data.length < 2) throw new PatchError(tr('speechInvalid'));
      const tl = data.readUInt16LE(0);
      if (2 + tl > data.length) throw new PatchError(tr('speechInvalid'));
      const cur = data.subarray(2, 2 + tl), tail = data.subarray(2 + tl);
      if (crc32(tail) !== ed.crcKeep) throw new PatchError(tr('speechData'));
      if (!cur.equals(ed.payload) && crc32(cur) !== ed.crcOrig) others++;
      nw = Buffer.concat([le16(ed.payload.length), ed.payload, tail]);
    } else if (ed.op === OP_IMGTEXT) {
      const x = ed.aux;
      if (x + 2 > data.length) throw new PatchError(tr('imageTextInvalid'));
      const tl = data.readUInt16LE(x);
      if (x + 2 + tl > data.length) throw new PatchError(tr('imageTextInvalid'));
      const head = data.subarray(0, x), cur = data.subarray(x + 2, x + 2 + tl), trail = data.subarray(x + 2 + tl);
      if (crc32(Buffer.concat([head, trail])) !== ed.crcKeep) {
        throw new PatchError(tr('imageTextData'));
      }
      if (!cur.equals(ed.payload) && crc32(cur) !== ed.crcOrig) others++;
      nw = Buffer.concat([head, le16(ed.payload.length), ed.payload, trail]);
    } else if (ed.op === OP_DATA) {
      if (!data.equals(ed.payload) && crc32(data) !== ed.crcOrig) others++;
      nw = ed.payload;
    } else {
      throw new PatchError(tr('operationUnknown'));
    }
    reps.push([nd.dataOff, nd.dataOff + 4 + nd.dataLen, Buffer.concat([le32(nw.length), nw])]);
  }
  reps.sort((a, b) => a[0] - b[0]);
  const parts = [];
  let pos = 0;
  for (const [a, b, bytes] of reps) {
    if (a < pos) throw new PatchError(tr('editsOverlap'));
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
    if (!ok) throw new PatchError(tr('resultUnexpected'));
    return { data: res, status: 'original', others: 0 };
  }
  return { data: res, status: ok ? 'atualizado' : 'divergente', others };
}

function applyEntry(buf, e) {
  if (e.kind === KIND_FILE) {
    if (buf && sha1(buf).equals(e.shaOut)) return { data: buf, status: 'ja_instalado', others: 0 };
    return { data: e.content, status: (buf && sha1(buf).equals(e.shaEn)) ? 'original' : 'atualizado', others: 0 };
  }
  if (!buf) throw new PatchError(tr('fileMissing'));
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

// pasta (dentro de mods/) com o chapters.ini traduzido para o ScummVM: ele reconhece o jogo pelo
// chapters.ini original, mas depois lê os arquivos de mods/ antes dos do jogo
const SCUMMVM_MOD_DIR = 'TLJ_PTBR';

function makeInstallPatchMod(api) {
  return async (files, destinationPath, gameId, progress, choices, unattended) => {
    const patchRel = files.find(f => path.basename(f).toLowerCase().endsWith('.tljpatch'));
    const game = gamePath(api);
    if (!game) {
      throw new util.ProcessCanceled(tr('gameNotFound'));
    }
    let patch;
    try {
      patch = readPatch(await fsp.readFile(path.join(destinationPath, patchRel)));
    } catch (err) {
      throw new util.ProcessCanceled(tr('patchReadFailed', { file: path.basename(patchRel), error: err.message }));
    }
    const cache = new Map();
    log('info', 'tlj: aplicando patch', { version: patch.version, entries: patch.entries.length, game });
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
        problems.push(tr('pathMissing', { path: e.path }));
        continue;
      }
      let res;
      try {
        res = applyEntry(buf, e);
      } catch (err) {
        problems.push(tr('pathDifferent', { path: e.path, error: err.message }));
        continue;
      }
      counts[res.status] = (counts[res.status] || 0) + 1;
      const outRel = path.join(OUT_DIR, real.rel);
      const outAbs = path.join(destinationPath, outRel);
      await fsp.mkdir(path.dirname(outAbs), { recursive: true });
      await fsp.writeFile(outAbs, res.data);
      instructions.push({ type: 'copy', source: outRel, destination: real.rel });
      if (e.kind === KIND_FILE && e.path.toLowerCase() === 'chapters.ini') {
        // cópia para o ScummVM: nomes dos capítulos em português também nele
        const modRel = path.join(OUT_DIR, 'mods', SCUMMVM_MOD_DIR, 'chapters.ini');
        await fsp.mkdir(path.dirname(path.join(destinationPath, modRel)), { recursive: true });
        await fsp.writeFile(path.join(destinationPath, modRel), e.content);
        const modDest = await resolveCi(game, `mods/${SCUMMVM_MOD_DIR}/chapters.ini`, cache);
        instructions.push({ type: 'copy', source: modRel, destination: modDest.rel });
      }
      if (progress && (i % 10 === 0)) progress(Math.round((i * 100) / patch.entries.length));
    }
    if (problems.length > 0) {
      const lista = problems.slice(0, 12).map(p => '- ' + p).join('\n');
      const more = problems.length - 12;
      api.showDialog('error', tr('translationNotInstalled'), {
        text: tr('translationMismatchBody', { problems: lista, more: more > 0 ? tr('problemsMore', { count: more }) : '' }),
      }, [{ label: tr('close') }]);
      throw new util.ProcessCanceled(tr('gameMismatch'));
    }
    log('info', 'tlj: patch aplicado', counts);
    if (progress) progress(100);
    instructions.push({ type: 'attribute', key: ENGINE_ATTR, value: 'both' });   // tradução: game.exe e ScummVM
    return { instructions };
  };
}

// ---------------------------------------------------------------- onde cada mod funciona
// 'scummvm': precisa do ScummVM (arquivos em mods/, fora a pasta da tradução)
// 'exe':     só faz efeito no game.exe original (executáveis, DLLs, wrappers como o dgVoodoo)
// 'both':    funciona nos dois (traduções, .xarc, vídeos, fontes, .ini do jogo)
const ENGINE_ATTR = 'tljEngine';
const EXE_ONLY_EXT = /\.(exe|dll|asi)$/i;
const EXE_ONLY_NAME = /^(dgvoodoo\.conf|dxwrapper\.ini|ddraw\.ini)$/i;

function isExeOnly(rel) {
  const parts = rel.split(/[\\/]/).filter(p => p.length > 0);
  const name = parts[parts.length - 1] || '';
  return EXE_ONLY_EXT.test(name) || EXE_ONLY_NAME.test(name);
}

function isScummVMOnly(rel) {
  const parts = rel.split(/[\\/]/).filter(p => p.length > 0);
  return parts.length > 2 && parts[0].toLowerCase() === 'mods'
    && parts[1].toLowerCase() !== SCUMMVM_MOD_DIR.toLowerCase();
}

function archiveLabel(archivePath, destinationPath) {
  if (typeof archivePath === 'string' && archivePath.length > 0) return path.basename(archivePath);
  if (typeof destinationPath === 'string') return path.basename(destinationPath).replace(/\.installing$/i, '');
  return 'mod';
}

/** avisa como o mod foi identificado (só para os que mudam onde o jogo abre) */
function notifyIdentified(api, engine, archivePath, destinationPath) {
  if (typeof api.sendNotification !== 'function' || engine === 'both') return;
  const name = archiveLabel(archivePath, destinationPath);
  api.sendNotification({
    id: `tlj-identificado-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
    type: 'info',
    message: engine === 'scummvm'
      ? tr('detectedScummvmMod', { name })
      : tr('detectedOriginalMod', { name }),
  });
}

function engineOfFiles(rels) {
  let exe = false;
  for (const r of rels) {
    if (isScummVMOnly(r)) return 'scummvm';
    if (isExeOnly(r)) exe = true;
  }
  return exe ? 'exe' : 'both';
}

// ---------------------------------------------------------------- instalador: arquivos soltos
const ROOT_DIR = /^([0-9a-f]{2}|global|static)$/i;
const ROOT_FILE = /^(chapters\.ini|language\.ini|gui\.ini|w_world\.ini|x\.xarc)$/i;
// arquivos do próprio jogo, que um mod substitui com o mesmo nome (.xarc, vídeos .bbb/.sss, sons .iss/.ovs),
// p.ex. os pacotes de vídeos em HD (FMV Pack) do TLJ HD Mod
const ROOT_ASSET = /\.(xarc|bbb|sss|iss|ovs)$/i;
// leia-me, imagens de divulgação etc. soltos na raiz do mod não vão para a pasta do jogo
const DOC_EXT = /\.(txt|md|pdf|nfo|url|html?|rtf|docx?|jpe?g|png|gif|bmp|webp)$/i;

/** índice do primeiro segmento que pertence à raiz do jogo, ou -1 */
function rootIndex(file) {
  const parts = file.split(/[\\/]/).filter(p => p.length > 0);
  if (parts.some(p => p.toLowerCase() === 'mods')) return -1;   // pasta mods do ScummVM: outro instalador
  for (let i = 0; i < parts.length; i++) {
    if (i === parts.length - 1) return ROOT_FILE.test(parts[i]) ? i : -1;
    if (ROOT_DIR.test(parts[i]) && ROOT_ASSET.test(parts[parts.length - 1])) return i;
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
  return async (files, destinationPath, gameId, progress, choices, unattended, archivePath) => {
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
      if (parts.length === pre.length + 1 && DOC_EXT.test(rel)) continue;   // leia-me na raiz
      const dest = game ? (await resolveCi(game, rel, cache)).rel : rel.split('/').join(path.sep);
      instructions.push({ type: 'copy', source: f, destination: dest });
    }
    const engine = engineOfFiles(instructions.map(i => i.destination));
    instructions.push({ type: 'attribute', key: ENGINE_ATTR, value: engine });
    notifyIdentified(api, engine, archivePath, destinationPath);
    return { instructions };
  };
}

// ---------------------------------------------------------------- instalador: mods do ScummVM (TLJ HD Mod)
// O ScummVM ("Load modded assets") lê imagens .png, vídeos .bik/.smk e texturas .zip (DDS) de
// <jogo>/mods/<NomeDoMod>/<nível>/<local>/xarc/..., e fontes de <jogo>/fonts.
const ASSET_EXT = /\.(png|bik|smk|dds|zip)$/i;
const FONT_EXT = /\.(ttf|otf|ttc)$/i;
const splitPath = (f) => f.split(/[\\/]/).filter(p => p.length > 0);
const isDirEntry = (f) => f.endsWith('/') || f.endsWith('\\');

/** índice do segmento "mods" (seguido de pasta do mod + arquivo), ou -1 */
function modsIndex(parts) {
  return parts.findIndex((p, i) => p.toLowerCase() === 'mods' && i < parts.length - 2);
}

/** índice da pasta de nível (08..7c, global, static) num caminho .../<nível>/.../xarc/arquivo.png */
function assetLevelIndex(parts) {
  if (parts.length < 3 || !ASSET_EXT.test(parts[parts.length - 1])) return -1;
  const xi = parts.findIndex(p => p.toLowerCase() === 'xarc');
  if (xi < 1) return -1;
  for (let i = 0; i < xi; i++) if (ROOT_DIR.test(parts[i])) return i;
  return -1;
}

function testAssetMod(files, gameId) {
  const real = files.filter(f => !isDirEntry(f));
  const supported = (gameId === GAME_ID)
    && !real.some(f => path.basename(f).toLowerCase().endsWith('.tljpatch'))
    // .xarc fora de uma pasta mods = tradução/arquivos do jogo: fica com o instalador de arquivos soltos
    && !real.some(f => { const p = splitPath(f); return modsIndex(p) < 0 && /\.xarc$/i.test(p[p.length - 1]); })
    && real.some(f => { const p = splitPath(f); return modsIndex(p) >= 0 || assetLevelIndex(p) >= 0; });
  return Promise.resolve({ supported, requiredFiles: [] });
}

function mostVoted(votes) {
  let key = null;
  let best = -1;
  for (const [k, n] of votes) if (n > best) { best = n; key = k; }
  return key === null ? null : (key ? key.split('/') : []);
}

const startsWith = (p, pre) => p.length > pre.length && pre.every((s, i) => s === p[i]);

/** nome para mods/<Nome> quando o zip não traz a pasta do mod: vem do arquivo baixado
 *  ("HDCharacters.7z" -> HDCharacters, "TLJHD_1.02.zip" -> TLJHD) */
function modNameFrom(archivePath, destinationPath) {
  let base = '';
  if (typeof archivePath === 'string' && archivePath.length > 0) {
    base = path.basename(archivePath).replace(/\.(zip|7z|rar|tar|gz|tgz)$/i, '');
  } else if (typeof destinationPath === 'string') {
    base = path.basename(destinationPath).replace(/\.installing$/i, '');
  }
  base = base.replace(/\s*\(\d+\)$/, '')            // "Nome (1)" de download repetido
    .replace(/-\d+-[\d-]+$/, '')                     // sufixo do Nexus: nome-123-1-0-1600000000
    .replace(/[ _.-]+v?\d+([._]\d+)*$/i, '')         // versão no fim: TLJHD_1.02
    .replace(/[<>:"/\\|?*]/g, '').trim();
  return base || 'TLJHD';
}

function makeInstallAssetMod(api) {
  return async (files, destinationPath, gameId, progress, choices, unattended, archivePath) => {
    const real = files.filter(f => !isDirEntry(f));
    // zip com a pasta "mods" (caso do TLJ HD Mod): o que vem antes de "mods" é a raiz do jogo e tudo
    // vai para o mesmo lugar de quando se extrai o zip na pasta do jogo (como o autor manda fazer).
    // zip sem "mods": a raiz do mod é o que vem antes da pasta de nível -> mods/<NomeDoMod>/...
    const baseVotes = new Map();
    const rootVotes = new Map();
    for (const f of real) {
      const p = splitPath(f);
      const mi = modsIndex(p);
      if (mi >= 0) {
        const key = p.slice(0, mi).join('/');
        baseVotes.set(key, (baseVotes.get(key) || 0) + 1);
        continue;
      }
      const li = assetLevelIndex(p);
      if (li >= 0) {
        const key = p.slice(0, li).join('/');
        rootVotes.set(key, (rootVotes.get(key) || 0) + 1);
      }
    }
    const base = mostVoted(baseVotes);
    const root = base === null ? mostVoted(rootVotes) : null;
    const modName = (root && root.length > 0) ? root[root.length - 1] : modNameFrom(archivePath, destinationPath);
    const game = gamePath(api);
    const cache = new Map();
    const instructions = [];
    for (const f of real) {
      const p = splitPath(f);
      let dest = null;
      const fi = p.findIndex(s => s.toLowerCase() === 'fonts');
      if (base !== null && (base.length === 0 || startsWith(p, base))) {
        const rel = p.slice(base.length);
        if (!(rel.length === 1 && DOC_EXT.test(rel[0]))) dest = rel;
      } else if (root !== null && (root.length === 0 ? p.length > 0 : startsWith(p, root))) {
        dest = ['mods', modName, ...p.slice(root.length)];
      } else if (fi >= 0 && fi < p.length - 1 && FONT_EXT.test(p[p.length - 1])) {
        dest = ['fonts', ...p.slice(fi + 1)];
      }
      if (dest === null || dest.length === 0) continue;   // leia-me e afins fora do mod
      const rel = dest.join('/');
      const destination = game ? (await resolveCi(game, rel, cache)).rel : dest.join(path.sep);
      instructions.push({ type: 'copy', source: f, destination });
    }
    const engine = engineOfFiles(instructions.map(i => i.destination));
    instructions.push({ type: 'attribute', key: ENGINE_ATTR, value: engine });
    if (instructions.length > 1) notifyIdentified(api, engine, archivePath, destinationPath);
    return { instructions };
  };
}

// ---------------------------------------------------------------- pacotes de jogos salvos
// Os saves do TLJ no ScummVM se chamam <id do jogo>-001.tlj ... e ficam na pasta de saves do ScummVM;
// os do jogo original (game.exe) se chamam Save01.tlj (+ Save01.tga e Index.dat) e ficam em
// %APPDATA%\The Longest Journey\Save\01. Os dois formatos são diferentes: um não abre no outro.
// Nenhum vai na pasta do jogo: em vez de instalar lá (onde não serve), o Vortex explica onde vão.
const SAVE_FILE = /-\d{3}\.tlj$/i;                       // ScummVM
const ORIGINAL_SAVE_FILE = /(^|[\\/])save\d+\.tlj$/i;       // jogo original

function testSavePack(files, gameId) {
  const real = files.filter(f => !isDirEntry(f));
  const supported = (gameId === GAME_ID)
    && real.some(f => SAVE_FILE.test(f) || ORIGINAL_SAVE_FILE.test(f))
    && !real.some(f => /\.(xarc|tljpatch|bbb|sss|png|zip|dds|bik|smk|ttf|ini)$/i.test(f));
  return Promise.resolve({ supported, requiredFiles: [] });
}

const sampleOf = names => `${names.slice(0, 3).join(', ')}${names.length > 3 ? ', ...' : ''}`;

function makeInstallSavePack(api) {
  return async (files, destinationPath, gameId, progress, choices, unattended, archivePath) => {
    const real = files.filter(f => !isDirEntry(f));
    const saves = real.filter(f => SAVE_FILE.test(f)).map(f => path.basename(f)).sort();
    const originalFiles = real.filter(f => ORIGINAL_SAVE_FILE.test(f)).sort();
    const originals = originalFiles.map(f => path.basename(f)).sort();
    if (saves.length > 0 && typeof api.showDialog === 'function') {
      const ids = Array.from(new Set(saves.map(n => n.replace(/-\d+\.tlj$/i, ''))));
      const saveDir = await scummvmSavesDir(await findScummVM(await loadPrefs()));
      const OPEN = tr('openSavesFolder');
      const defaultId = ids.length === 1 && ids[0].toLowerCase() === 'tlj-win';
      const res = await api.showDialog('info', tr('savePackTitle'), {
        text: tr('savePackBody', { count: saves.length, sample: sampleOf(saves),
          target: defaultId ? tr('saveDefaultTarget') : tr('saveCustomTarget', { ids: ids.join('", "') }) }),
      }, [{ label: OPEN }, { label: tr('close'), default: true }]);
      if (res && res.action === OPEN) await openFolder(saveDir);
    }
    if (originals.length > 0 && typeof api.showDialog === 'function') {
      const dir = await originalSavesTarget();
      const OPEN = tr('openOriginalSavesFolder');
      const CONVERT = tr('convertOriginalSaves');
      const buttons = [{ label: OPEN }];
      if (destinationPath) buttons.push({ label: CONVERT });
      buttons.push({ label: tr('close'), default: true });
      const res = await api.showDialog('info', tr('originalSavesTitle'), {
        text: tr('originalSavePackBody', { count: originals.length, sample: sampleOf(originals), dir, convert: CONVERT }),
      }, buttons);
      if (res && res.action === OPEN) await openFolder(dir);
      if (res && res.action === CONVERT) {
        // os arquivos do pacote já estão extraídos em destinationPath; a origem fica registrada pelo nome do pacote
        const pack = archivePath ? path.basename(archivePath) : path.basename(destinationPath);
        await runConversion(api, originalFiles.map(rel => ({ file: path.join(destinationPath, rel), id: `${pack}|${rel}` })));
      }
    }
    throw new util.UserCanceled();
  };
}

/** pasta onde o jogo original guarda os saves: a que já existir (com a subpasta do perfil, 01) ou a padrão */
async function originalSavesTarget() {
  const found = await originalSavesDirs().catch(() => []);
  const base = found[0] || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'The Longest Journey', 'Save');
  try {
    if ((await fsp.stat(path.join(base, '01'))).isDirectory()) return path.join(base, '01');
  } catch (err) {
    // sem a subpasta do perfil
  }
  return base;
}

// ---------------------------------------------------------------- ScummVM automático
// Os mods em HD (TLJ HD, FMV Packs, HDCharacters) só funcionam no ScummVM. Quando eles estão na pasta
// mods (ou quando o jogador escolhe), o botão Jogar do Vortex abre o jogo no ScummVM:
//  1. acha o ScummVM instalado ou, com a permissão do jogador, baixa a versão oficial (com SHA-256);
//  2. o ScummVM reconhece o jogo pelo chapters.ini ORIGINAL. Se a tradução trocou o chapters.ini da
//     pasta do jogo (o game.exe precisa do traduzido), o ScummVM recebe uma "pasta-sombra": o
//     chapters.ini original + links para todo o resto do jogo (nada é copiado nem alterado no jogo);
//  3. cadastra o jogo no scummvm.ini e abre direto nele.
const SCUMMVM_RELEASE = {
  version: '2026.4.0',
  url: 'https://downloads.scummvm.org/frs/scummvm/2026.4.0/scummvm-2026.4.0-win32-x86_64.zip',
  sha256: 'fb60cfc0828ed86ef24a60c04b9390676493ab85892d81c56d1de90367d56736',
  sizeMB: 118,
};
const SCUMMVM_SITE = 'https://www.scummvm.org/downloads/';
const SCUMMVM_TARGET = 'tlj-win';            // nome padrão que o ScummVM dá ao jogo (os saves usam ele)
const PREFS_FILE = 'tlj_scummvm.json';
const SHADOW_DIR = 'scummvm_pasta_jogo';
const OWN_DIR = 'ScummVM';                  // pasta do ScummVM baixado pela extensão (dentro de dataDir())
const OWN_DESCRIPTION = 'The Longest Journey (Vortex)';   // marca o jogo que a extensão cadastra no scummvm.ini
const ENGINE_SCUMMVM = 'scummvm';
const ENGINE_GAME = 'game';
const IS_WIN = process.platform === 'win32';
const SCUMMVM_EXE = IS_WIN ? 'scummvm.exe' : 'scummvm';
const pipeline = nodeUtil.promisify(stream.pipeline);

/** pasta de dados da extensão: %APPDATA%\Vortex\thelongestjourney */
function dataDir() {
  let base;
  try { base = util.getVortexPath('userData'); } catch (err) { base = undefined; }
  if (!base) {
    base = (IS_WIN && process.env.APPDATA) ? path.join(process.env.APPDATA, 'Vortex')
                                           : path.join(os.homedir(), '.config', 'Vortex');
  }
  return path.join(base, GAME_ID);
}

async function statSafe(p) { try { return await fsp.stat(p); } catch (err) { return undefined; } }
async function lstatSafe(p) { try { return await fsp.lstat(p); } catch (err) { return undefined; } }

function samePath(a, b) {
  const norm = (p) => path.resolve(String(p)).replace(/[\\/]+$/, '');
  return IS_WIN ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

async function loadPrefs() {
  try {
    return JSON.parse(await fsp.readFile(path.join(dataDir(), PREFS_FILE), 'utf8')) || {};
  } catch (err) {
    return {};
  }
}

async function savePrefs(prefs) {
  await fsp.mkdir(dataDir(), { recursive: true });
  await fsp.writeFile(path.join(dataDir(), PREFS_FILE), JSON.stringify(prefs, null, 2));
}

/** procura um arquivo (sem diferenciar maiúsculas) em dir e até `depth` subpastas abaixo */
async function findFile(dir, name, depth) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (err) { return undefined; }
  const hit = entries.find(e => e.isFile() && e.name.toLowerCase() === name.toLowerCase());
  if (hit) return path.join(dir, hit.name);
  if (depth <= 0) return undefined;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const found = await findFile(path.join(dir, e.name), name, depth - 1);
    if (found) return found;
  }
  return undefined;
}

async function hasAnyFile(dir, depth) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (err) { return false; }
  if (entries.some(e => e.isFile())) return true;
  if (depth <= 0) return false;
  for (const e of entries) {
    if (e.isDirectory() && await hasAnyFile(path.join(dir, e.name), depth - 1)) return true;
  }
  return false;
}

function scummvmFromRegistry() {
  if (!IS_WIN) return [];
  let winapi;
  try { winapi = require('winapi-bindings'); } catch (err) { return []; }
  const key = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ScummVM_is1';
  const res = [];
  for (const [hive, k] of [['HKEY_LOCAL_MACHINE', key], ['HKEY_CURRENT_USER', key],
                           ['HKEY_LOCAL_MACHINE', key.replace('SOFTWARE\\', 'SOFTWARE\\WOW6432Node\\')]]) {
    try {
      const v = winapi.RegGetValue(hive, k, 'InstallLocation');
      if (v && v.value) res.push(path.join(String(v.value), 'scummvm.exe'));
    } catch (err) {
      // não instalado por esse caminho
    }
  }
  return res;
}

async function findScummVM(prefs) {
  const cands = [];
  if (prefs.scummvmExe) cands.push(prefs.scummvmExe);
  const own = await findFile(path.join(dataDir(), OWN_DIR), SCUMMVM_EXE, 3);
  if (own) cands.push(own);
  cands.push(...scummvmFromRegistry());
  if (IS_WIN) {
    for (const v of ['ProgramW6432', 'ProgramFiles', 'ProgramFiles(x86)']) {
      if (process.env[v]) cands.push(path.join(process.env[v], 'ScummVM', 'scummvm.exe'));
    }
    if (process.env.LOCALAPPDATA) cands.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'ScummVM', 'scummvm.exe'));
  } else {
    cands.push('/usr/bin/scummvm', '/usr/games/scummvm', '/usr/local/bin/scummvm',
               '/Applications/ScummVM.app/Contents/MacOS/scummvm');
  }
  for (const c of cands) {
    const st = await statSafe(c);
    if (st && st.isFile()) return c;
  }
  return undefined;
}

// ---- download do ScummVM oficial
function request(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'Vortex-TheLongestJourney' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects <= 0) { reject(new Error(tr('tooManyRedirects'))); return; }
        resolve(request(new URL(res.headers.location, url).toString(), redirects - 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(tr('serverStatus', { status: res.statusCode })));
        return;
      }
      resolve(res);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error(tr('timeout'))));
  });
}

async function fetchText(url) {
  const res = await request(url);
  const chunks = [];
  for await (const c of res) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function downloadTo(url, dest, onProgress) {
  const res = await request(url);
  const total = parseInt(res.headers['content-length'] || '0', 10);
  const hash = crypto.createHash('sha256');
  let got = 0;
  res.on('data', (chunk) => {
    got += chunk.length;
    hash.update(chunk);
    if (onProgress) onProgress(got, total);
  });
  await pipeline(res, fs.createWriteStream(dest));
  return hash.digest('hex');
}

/** extrator de .zip simples (armazenado/deflate), com proteção contra caminhos "../" */
async function unzipFile(zipPath, destDir) {
  const buf = await fsp.readFile(zipPath);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(tr('zipInvalid'));
  const count = buf.readUInt16LE(eocd + 10);
  let o = buf.readUInt32LE(eocd + 16);
  if (count === 0xFFFF || o === 0xFFFFFFFF) throw new Error(tr('zip64'));
  const root = path.resolve(destDir);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(o) !== 0x02014b50) throw new Error(tr('zipDirectory'));
    const method = buf.readUInt16LE(o + 10);
    const csize = buf.readUInt32LE(o + 20);
    const nlen = buf.readUInt16LE(o + 28);
    const elen = buf.readUInt16LE(o + 30);
    const clen = buf.readUInt16LE(o + 32);
    const loc = buf.readUInt32LE(o + 42);
    const name = buf.subarray(o + 46, o + 46 + nlen).toString('utf8');
    o += 46 + nlen + elen + clen;
    const parts = name.split(/[\\/]/).filter(p => p.length > 0 && p !== '.');
    if (parts.length === 0 || parts.includes('..') || /^[a-z]:/i.test(name) || name.startsWith('/')) continue;
    const out = path.join(root, ...parts);
    if (!out.startsWith(root + path.sep)) continue;
    if (/[\\/]$/.test(name)) { await fsp.mkdir(out, { recursive: true }); continue; }
    if (buf.readUInt32LE(loc) !== 0x04034b50) throw new Error(tr('zipHeader'));
    const start = loc + 30 + buf.readUInt16LE(loc + 26) + buf.readUInt16LE(loc + 28);
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(tr('compressionUnsupported', { method }));
    await fsp.mkdir(path.dirname(out), { recursive: true });
    await fsp.writeFile(out, data);
  }
}

async function extractArchive(archive, dest) {
  if (typeof util.SevenZip === 'function') {
    try {
      const sz = new util.SevenZip();
      await sz.extractFull(archive, dest, { ssc: false }, () => undefined, () => undefined);
      return;
    } catch (err) {
      log('warn', 'tlj: 7-Zip não extraiu o ScummVM, usando o extrator interno', err.message);
    }
  }
  await unzipFile(archive, dest);
}

let downloading = null;   // um download só por vez: clicar em Jogar de novo espera o que já está andando
function downloadScummVM(api) {
  if (!downloading) downloading = downloadScummVMNow(api).finally(() => { downloading = null; });
  return downloading;
}

async function downloadScummVMNow(api) {
  const dir = dataDir();
  const base = path.join(dir, OWN_DIR);
  const tmp = path.join(dir, 'scummvm_download.zip');
  await fsp.mkdir(dir, { recursive: true });
  const note = (progress, message) => {
    if (typeof api.sendNotification === 'function') {
      api.sendNotification({ id: 'tlj-scummvm-download', type: 'activity', message, progress, noDismiss: true });
    }
  };
  const msg = tr('downloadingScummvm', { version: SCUMMVM_RELEASE.version });
  note(0, msg);
  let last = -1;
  try {
    const digest = await downloadTo(SCUMMVM_RELEASE.url, tmp, (got, total) => {
      const pct = total > 0 ? Math.floor((got * 100) / total) : 0;
      if (pct !== last) { last = pct; note(pct, msg); }
    });
    let expected = SCUMMVM_RELEASE.sha256;
    try {
      const m = /[0-9a-f]{64}/i.exec(await fetchText(SCUMMVM_RELEASE.url + '.sha256'));
      if (m) expected = m[0].toLowerCase();
    } catch (err) {
      // sem o .sha256 do site, confere com o valor conhecido
    }
    if (digest !== expected) {
      throw new Error(tr('checksumMismatch'));
    }
    note(100, tr('extractingScummvm'));
    await fsp.rm(base, { recursive: true, force: true });   // pasta só nossa, sem links
    await fsp.mkdir(base, { recursive: true });
    await extractArchive(tmp, base);
    let exe = await findFile(base, SCUMMVM_EXE, 3);
    if (!exe) {
      // o 7-Zip do Vortex às vezes termina sem erro mas sem extrair tudo: extrai de novo com o extrator interno
      log('warn', 'tlj: scummvm.exe não apareceu depois do 7-Zip, usando o extrator interno');
      await fsp.rm(base, { recursive: true, force: true });
      await fsp.mkdir(base, { recursive: true });
      await unzipFile(tmp, base);
      exe = await findFile(base, SCUMMVM_EXE, 3);
    }
    if (!exe) throw new Error(tr('missingScummvm'));
    return exe;
  } finally {
    if (typeof api.dismissNotification === 'function') api.dismissNotification('tlj-scummvm-download');
    await fsp.rm(tmp, { force: true }).catch(() => null);
  }
}

async function pickScummVM(api, prefs) {
  const exe = await api.selectExecutable({
    title: tr('selectScummvm'),
    filters: IS_WIN ? [{ name: 'ScummVM', extensions: ['exe'] }] : [],
  });
  if (!exe) throw new util.UserCanceled();
  prefs.scummvmExe = exe;
  await savePrefs(prefs);
  return exe;
}

async function obtainScummVM(api, prefs) {
  const DOWNLOAD = tr('downloadSetup');
  const PICK = tr('selectScummvmAction');
  const SITE = tr('openWebsite');
  const actions = [{ label: tr('cancel') }, { label: SITE }, { label: PICK }];
  if (IS_WIN) actions.push({ label: DOWNLOAD, default: true });
  const res = await api.showDialog('question', tr('scummvmNotFound'), {
    text: tr('scummvmRequired', { download: IS_WIN ? tr('scummvmDownloadOffer', { version: SCUMMVM_RELEASE.version, size: SCUMMVM_RELEASE.sizeMB }) : '' }),
  }, actions);
  const act = res ? res.action : undefined;
  if (act === DOWNLOAD) {
    const exe = await downloadScummVM(api);
    prefs.scummvmExe = exe;
    await savePrefs(prefs);
    if (typeof api.sendNotification === 'function') {
      // fica até o jogador fechar: diz onde o ScummVM foi parar e como tirar
      api.sendNotification({
        id: 'tlj-scummvm-downloaded', type: 'info',
        message: tr('scummvmDownloaded', { version: SCUMMVM_RELEASE.version, dir: path.join(dataDir(), OWN_DIR) }),
      });
    }
    return exe;
  }
  if (act === PICK) return pickScummVM(api, prefs);
  if (act === SITE) Promise.resolve(util.opn(SCUMMVM_SITE)).catch(() => null);
  throw new util.UserCanceled();
}

// ---- pasta-sombra
async function removeLink(p) {
  try { await fsp.unlink(p); } catch (err) { await fsp.rmdir(p); }   // junção do Windows sai com rmdir; nunca recursivo
}

/** espelha a pasta do jogo em `shadow` com links, trocando só o chapters.ini pelo original */
async function syncShadow(game, shadow, chaptersOrig) {
  await fsp.mkdir(shadow, { recursive: true });
  const keyOf = (n) => (IS_WIN ? n.toLowerCase() : n);
  const keep = new Set([keyOf('chapters.ini')]);
  for (const e of await fsp.readdir(game, { withFileTypes: true })) {
    const low = e.name.toLowerCase();
    if (low === 'chapters.ini' || low.endsWith(BACKUP_TAG) || low === '_backup_traducao_ptbr') continue;
    const from = path.join(game, e.name);
    const to = path.join(shadow, e.name);
    const st = await statSafe(from);
    if (!st) continue;
    keep.add(keyOf(e.name));
    const cur = await lstatSafe(to);
    if (st.isDirectory()) {
      if (cur && cur.isSymbolicLink()) {
        let target = '';
        try { target = await fsp.readlink(to); } catch (err) { target = ''; }
        if (target && samePath(path.resolve(path.dirname(to), target.replace(/^\\\\\?\\/, '')), from)) continue;
        await removeLink(to);
      } else if (cur) {
        continue;   // pasta de verdade com esse nome: não mexe
      }
      await fsp.symlink(from, to, 'junction');
    } else if (st.isFile()) {
      if (cur && cur.isFile()) {
        const cst = await statSafe(to);
        if (cst && cst.size === st.size && Math.abs(cst.mtimeMs - st.mtimeMs) < 1000) continue;
        await fsp.unlink(to);
      } else if (cur && cur.isSymbolicLink()) {
        await removeLink(to);
      } else if (cur) {
        continue;
      }
      try {
        await fsp.link(from, to);
      } catch (err) {
        if (st.size > 64 * 1024 * 1024) continue;   // outro disco: copia só os arquivos pequenos da raiz
        await fsp.copyFile(from, to);
        await fsp.utimes(to, st.atime, st.mtime).catch(() => null);
      }
    }
  }
  const ch = path.join(shadow, 'chapters.ini');
  const cur = await readIfExists(ch);
  if (cur === null || !cur.equals(chaptersOrig)) {
    await fsp.rm(ch, { force: true });
    await fsp.writeFile(ch, chaptersOrig);
  }
  for (const e of await fsp.readdir(shadow, { withFileTypes: true })) {
    if (keep.has(keyOf(e.name))) continue;
    const p = path.join(shadow, e.name);
    const l = await lstatSafe(p);
    if (l && (l.isSymbolicLink() || l.isFile())) await removeLink(p);
  }
}

/** pasta que o ScummVM deve usar: a do jogo, ou a pasta-sombra se o chapters.ini foi trocado */
async function scummvmGamePath(game) {
  const ch = await resolveCi(game, 'chapters.ini', new Map());
  const original = await readIfExists(ch.abs + BACKUP_TAG);
  if (original === null) return game;
  const shadow = path.join(dataDir(), SHADOW_DIR);
  await syncShadow(game, shadow, original);
  return shadow;
}

// ---- scummvm.ini
async function scummvmConfig(exe) {
  if (IS_WIN) {
    // modo portátil do ScummVM: scummvm.ini ao lado do exe (ignorado dentro de Arquivos de Programas)
    const portable = path.join(path.dirname(exe), 'scummvm.ini');
    const pf = [process.env.ProgramW6432, process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
      .filter(x => x).map(x => path.resolve(x).toLowerCase() + path.sep);
    const inPF = pf.some(x => path.resolve(exe).toLowerCase().startsWith(x));
    if (!inPF && await statSafe(portable)) return { file: portable, portable: true };
    return { file: path.join(process.env.APPDATA || os.homedir(), 'ScummVM', 'scummvm.ini'), portable: false };
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return { file: path.join(xdg, 'scummvm', 'scummvm.ini'), portable: false };
}

function parseIni(text) {
  const lines = text.split(/\r?\n/);
  const sections = [];
  let cur = null;
  lines.forEach((ln, i) => {
    const m = /^\s*\[([^\]]+)\]\s*$/.exec(ln);
    if (m) {
      cur = { name: m[1].trim(), keys: {} };
      sections.push(cur);
      return;
    }
    const kv = cur ? /^\s*([^=#;]+?)\s*=(.*)$/.exec(ln) : null;
    if (kv) cur.keys[kv[1].toLowerCase()] = { value: kv[2].trim(), line: i };
  });
  return { lines, sections };
}

/** garante um jogo do TLJ no scummvm.ini apontando para `scvPath`; devolve o nome dele */
async function ensureScummVMTarget(cfgFile, scvPath, game) {
  let text;
  try { text = await fsp.readFile(cfgFile, 'utf8'); } catch (err) { text = ''; }
  const eol = text.includes('\r\n') || (IS_WIN && text === '') ? '\r\n' : '\n';
  const ini = parseIni(text);
  const shadow = path.join(dataDir(), SHADOW_DIR);
  const ours = ini.sections.find(s => s.keys.gameid && s.keys.gameid.value === 'tlj' && s.keys.path
    && [scvPath, game, shadow].some(p => samePath(s.keys.path.value, p)));
  if (ours) {
    if (!samePath(ours.keys.path.value, scvPath)) {
      ini.lines[ours.keys.path.line] = `path=${scvPath}`;
      await fsp.writeFile(cfgFile, ini.lines.join(eol));
    }
    return ours.name;
  }
  const names = new Set(ini.sections.map(s => s.name.toLowerCase()));
  const name = newTargetName(ini);
  const block = [`[${name}]`, `description=${OWN_DESCRIPTION}`, 'gameid=tlj', 'engineid=stark',
                 `path=${scvPath}`];
  if (!names.has('scummvm')) block.unshift('[scummvm]', '');
  const body = text.replace(/\s+$/, '');
  await fsp.mkdir(path.dirname(cfgFile), { recursive: true });
  await fsp.writeFile(cfgFile, (body ? body + eol + eol : '') + block.join(eol) + eol);
  return name;
}

// ---- escolha automática: ScummVM ou game.exe, conforme os mods ativos
const scanCache = new Map();

/** classifica um mod sem o atributo (instalado por outro instalador) olhando os arquivos dele */
async function scanEngine(dir) {
  let exe = false;
  const walk = async (d, rel, depth) => {
    if (depth > 12) return false;
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch (err) { return false; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (depth === 0 && e.name.toLowerCase() === 'mods') {
          let subs;
          try { subs = await fsp.readdir(path.join(d, e.name)); } catch (err) { subs = []; }
          if (subs.some(n => n.toLowerCase() !== SCUMMVM_MOD_DIR.toLowerCase())) return true;
          continue;
        }
        if (await walk(path.join(d, e.name), r, depth + 1)) return true;
      } else if (isExeOnly(r)) {
        exe = true;
      }
    }
    return false;
  };
  if (await walk(dir, '', 0)) return 'scummvm';
  return exe ? 'exe' : 'both';
}

function modDisplayName(mod) {
  try {
    if (typeof util.renderModName === 'function') return util.renderModName(mod, { version: false });
  } catch (err) {
    // usa os atributos abaixo
  }
  const a = mod.attributes || {};
  return a.customFileName || a.logicalFileName || a.name || mod.id;
}

/** mods ativos do perfil do jogo, separados por onde funcionam */
async function enabledModsByEngine(api) {
  const state = api.getState();
  let profile = selectors.activeProfile(state);
  if (!profile || profile.gameId !== GAME_ID) {
    const pid = selectors.lastActiveProfileForGame(state, GAME_ID);
    profile = pid ? selectors.profileById(state, pid) : undefined;
  }
  const groups = { scummvm: [], exe: [], both: [], profileId: profile ? profile.id : undefined };
  if (!profile) return groups;
  const mods = util.getSafe(state, ['persistent', 'mods', GAME_ID], {});
  let staging;
  try { staging = selectors.installPathForGame(state, GAME_ID); } catch (err) { staging = undefined; }
  for (const id of Object.keys(mods)) {
    const mod = mods[id];
    if (!util.getSafe(profile, ['modState', id, 'enabled'], false)) continue;
    if (mod.state !== undefined && mod.state !== 'installed') continue;
    let engine = util.getSafe(mod, ['attributes', ENGINE_ATTR], undefined);
    if (!['scummvm', 'exe', 'both'].includes(engine)) {
      const key = `${id}:${util.getSafe(mod, ['attributes', 'installTime'], '')}`;
      engine = scanCache.get(key);
      if (engine === undefined) {
        engine = (staging && mod.installationPath) ? await scanEngine(path.join(staging, mod.installationPath)) : 'both';
        scanCache.set(key, engine);
      }
    }
    groups[engine].push({ id, name: modDisplayName(mod) });
  }
  return groups;
}

async function disableMods(api, profileId, mods) {
  const ids = mods.map(m => m.id).filter(id => id !== undefined);
  if (!profileId || ids.length === 0) return;
  for (const id of ids) api.store.dispatch(actions.setModEnabled(profileId, id, false));
  await new Promise((resolve) => {
    const timer = setTimeout(() => { log('warn', 'tlj: o deploy demorou; seguindo'); resolve(); }, 120000);
    api.events.emit('deploy-mods', (err) => {
      clearTimeout(timer);
      if (err) log('warn', 'tlj: deploy depois de desativar mods', err.message);
      resolve();
    }, profileId);
  });
}

/** mods que só funcionam no ScummVM junto com mods que só funcionam no game.exe: o jogador escolhe */
async function resolveConflict(api, groups) {
  const list = (arr) => arr.map(m => `- ${m.name}`).join('\n');
  const scummvmMods = groups.scummvm;
  const choices = [{
    id: 'scummvm_compat',
    text: groups.both.length > 0
      ? tr('conflictRecommendedBoth')
      : tr('conflictRecommended'),
    value: true,
  }];
  if (groups.both.length > 0) {
    choices.push({ id: 'scummvm_only', text: tr('conflictOnlyScummvm'), value: false });
  }
  choices.push({ id: 'exe', value: false,
    text: tr('conflictOriginal') });
  const CONTINUE = tr('continue');
  const res = await api.showDialog('question', tr('conflictTitle'), {
    text: tr('conflictBody', { scummvm: list(scummvmMods), original: list(groups.exe),
      compatible: groups.both.length > 0 ? tr('conflictBoth', { mods: list(groups.both) }) : '' }),
    choices,
  }, [{ label: tr('cancel') }, { label: CONTINUE, default: true }]);
  if (!res || res.action !== CONTINUE) throw new util.UserCanceled();
  const sel = Object.keys(res.input || {}).find(k => res.input[k] === true) || 'scummvm_compat';
  if (sel === 'exe') {
    await disableMods(api, groups.profileId, groups.scummvm);
    return ENGINE_GAME;
  }
  await disableMods(api, groups.profileId, sel === 'scummvm_only' ? groups.exe.concat(groups.both) : groups.exe);
  return ENGINE_SCUMMVM;
}

function notifyAuto(api, mods) {
  if (typeof api.sendNotification !== 'function') return;
  const names = mods.map(m => m.name);
  const shown = names.slice(0, 3).join(', ');
  const more = names.length - 3;
  api.sendNotification({
    id: 'tlj-scummvm-auto',
    type: 'info',
    displayMS: 8000,
    message: tr('autoScummvm', { mods: shown, more: more > 0 ? tr('autoMore', { count: more }) : '' }),
  });
}

/** decide onde abrir. No "Automático" (padrão) valem só os mods ATIVOS no Vortex (arquivos que sobram na
 *  pasta do jogo, de mods desativados ou extraídos à mão, não contam):
 *   - nenhum mod do ScummVM ativo                      -> jogo original, direto
 *   - mods do ScummVM + só mods compatíveis            -> ScummVM, direto
 *   - mods do ScummVM + mods que só funcionam no exe   -> pergunta qual combinação usar */
async function decideEngine(api, game, prefs) {
  const mode = prefs.mode || 'auto';
  if (mode === ENGINE_GAME || mode === ENGINE_SCUMMVM) return mode;
  const groups = await enabledModsByEngine(api);
  log('info', 'tlj: escolha do motor', {
    scummvm: groups.scummvm.map(m => m.name), exe: groups.exe.map(m => m.name), both: groups.both.map(m => m.name),
  });
  if (groups.scummvm.length === 0) return ENGINE_GAME;
  if (groups.exe.length === 0) {
    notifyAuto(api, groups.scummvm);
    return ENGINE_SCUMMVM;
  }
  return resolveConflict(api, groups);
}

function isTljLaunch(call, game) {
  const exe = String(call.executable || '');
  if (samePath(exe, path.join(game, 'game.exe'))) return true;
  if (/(^|[\\/])steam(\.exe)?$/i.test(exe)) {          // versão Steam: steam.exe -applaunch 6310
    const args = (call.args || []).map(String);
    return args.includes('-applaunch') && args.includes(STEAM_ID);
  }
  return false;
}

async function prepareScummVM(api, game, prefs) {
  let exe = await findScummVM(prefs);
  if (!exe) exe = await obtainScummVM(api, prefs);
  const scvPath = await scummvmGamePath(game);
  const cfg = await scummvmConfig(exe);
  const target = await ensureScummVMTarget(cfg.file, scvPath, game);
  // -c fixa o arquivo de configuração (no modo portátil o próprio ScummVM acha o dele)
  return { exe, args: cfg.portable ? [target] : ['-c', cfg.file, target], cwd: path.dirname(exe) };
}

function makeStartHook(api) {
  return async (call) => {
    const game = gamePath(api);
    if (!game || !isTljLaunch(call, game)) return call;
    const prefs = await loadPrefs();
    const engine = await decideEngine(api, game, prefs);
    if (engine !== ENGINE_SCUMMVM) return call;
    try {
      await warnOriginalSaves(api, prefs);
      const s = await prepareScummVM(api, game, prefs);
      log('info', 'tlj: abrindo no ScummVM', { exe: s.exe, args: s.args });
      return { executable: s.exe, args: s.args, options: { ...call.options, cwd: s.cwd, shell: false, detach: true } };
    } catch (err) {
      if (err instanceof util.UserCanceled || err instanceof util.ProcessCanceled) throw err;
      if (typeof api.showErrorNotification === 'function') {
        api.showErrorNotification(tr('scummvmStartFailed'), err,
                                  { allowReport: false });
      }
      throw new util.ProcessCanceled(err.message);
    }
  };
}

/** botão "ScummVM" na aba Mods: automático, sempre ScummVM ou sempre o jogo original; mostra a pasta
 *  de saves e, se foi a extensão que baixou o ScummVM, oferece removê-lo */
async function configureEngine(api) {
  const prefs = await loadPrefs();
  const exe = await findScummVM(prefs);
  const ownExe = await ownScummVM();
  const saves = await scummvmSavesDir(exe);
  const mode = prefs.mode || 'auto';
  const PICK = tr('selectAnotherScummvm');
  const SAVE = tr('save');
  const OPEN = tr('openSavesFolder');
  const REMOVE = tr('removeDownloadedScummvm');
  const CONVERT = tr('convertOriginalSaves');
  const originalDirs = await originalSavesDirs().catch(() => []);
  const shown = !exe ? tr('scummvmNotFoundHint')
    : (ownExe && samePath(exe, ownExe)) ? tr('scummvmDownloadedPath', { exe }) : exe;
  const buttons = [{ label: tr('cancel') }, { label: OPEN }];
  if (originalDirs.length) buttons.push({ label: CONVERT });
  if (ownExe) buttons.push({ label: REMOVE });
  buttons.push({ label: PICK }, { label: SAVE, default: true });
  const res = await api.showDialog('question', 'The Longest Journey: ScummVM', {
    text: `ScummVM: ${shown}\n${tr('savesFolderLine', { dir: saves })}\n\n`
      + tr('playPrompt'),
    choices: [
      { id: 'auto', value: mode === 'auto',
        text: tr('autoMode') },
      { id: ENGINE_SCUMMVM, text: tr('alwaysScummvm'), value: mode === ENGINE_SCUMMVM },
      { id: ENGINE_GAME, text: tr('alwaysOriginal'),
        value: mode === ENGINE_GAME },
    ],
  }, buttons);
  if (!res) return;
  if (res.action === OPEN) {
    await openFolder(saves);
    return;
  }
  if (res.action === REMOVE) {
    await removeDownloadedScummVM(api);
    return;
  }
  if (res.action === CONVERT) {
    await runConversion(api, (await originalSaveFiles()).map(file => ({ file })), prefs, originalDirs);
    return;
  }
  if (res.action === PICK) {
    await pickScummVM(api, prefs).catch(() => null);
    return;
  }
  if (res.action !== SAVE) return;
  const sel = Object.keys(res.input || {}).find(k => res.input[k] === true);
  prefs.mode = (sel === ENGINE_SCUMMVM || sel === ENGINE_GAME) ? sel : 'auto';
  delete prefs.engine;   // chave antiga (0.2.0)
  delete prefs.manual;   // chave antiga (0.2.3)
  delete prefs.toldAuto;
  await savePrefs(prefs);
}

// ---- saves do jogo original (game.exe): o ScummVM não lê esse formato
/** pastas com saves do jogo original: a da versão Steam/GOG (%APPDATA%\The Longest Journey\Save) e as
 *  antigas da Funcom (%APPDATA%\Funcom\TLJ <pasta do jogo>\Save); só as que têm algum arquivo */
async function originalSavesDirs() {
  const appData = process.env.APPDATA;
  if (!appData) return [];
  const dirs = [path.join(appData, 'The Longest Journey', 'Save')];
  try {
    for (const e of await fsp.readdir(path.join(appData, 'Funcom'), { withFileTypes: true })) {
      if (e.isDirectory() && /^tlj\b/i.test(e.name)) dirs.push(path.join(appData, 'Funcom', e.name, 'Save'));
    }
  } catch (err) {
    // sem a pasta antiga da Funcom
  }
  const found = [];
  for (const d of dirs) {
    if (await hasAnyFile(d, 1)) found.push(d);
  }
  return found;
}

/** na primeira vez que o jogo abre no ScummVM, se houver saves do jogo original: avisa que eles não
 *  aparecem no ScummVM (e vice-versa) e onde continuam. Só uma vez. */
async function warnOriginalSaves(api, prefs) {
  if (prefs.toldOriginalSaves || typeof api.showDialog !== 'function') return;
  const dirs = await originalSavesDirs().catch(() => []);
  if (dirs.length === 0) return;
  const OPEN = tr('openOriginalSavesFolder');
  const CONTINUE = tr('continue');
  const CONVERT = tr('convertOriginalSaves');
  const buttons = [{ label: OPEN }, { label: tr('cancel') }, { label: CONVERT }, { label: CONTINUE, default: true }];
  const res = await api.showDialog('info', tr('originalSavesTitle'), {
    text: tr('originalSavesBody', { dir: dirs.join('\n'), option: tr('alwaysOriginal'), convert: CONVERT }),
  }, buttons);
  prefs.toldOriginalSaves = true;
  await savePrefs(prefs);
  const act = res ? res.action : undefined;
  if (act === CONTINUE) return;
  if (act === CONVERT) {
    // converte e segue abrindo o jogo no ScummVM, já com os saves convertidos
    await runConversion(api, (await originalSaveFiles()).map(file => ({ file })), prefs, dirs);
    return;
  }
  if (act === OPEN) await openFolder(dirs[0]);
  throw new util.UserCanceled();
}

// ---- conversão dos saves do jogo original para o ScummVM (cópias; os originais não mudam)
const SLOTS_PER_PAGE = 9;   // a tela de saves do ScummVM mostra 9 por página
/** primeiro slot para os convertidos: o começo da página seguinte à do último save do jogador, deixando
 *  uma página vazia entre eles (como um TAB: a distância é sempre a mesma). Sem saves: slot 0. */
function convertBaseSlot(usedSlots) {
  if (!usedSlots.length) return 0;
  const last = Math.max(...usedSlots);
  return (Math.floor(last / SLOTS_PER_PAGE) + 2) * SLOTS_PER_PAGE;
}
const CONVERT_NOTIFICATION = 'tlj-convert-saves';
const CONVERT_MARKS = 'tlj_saves_convertidos.json';   // quais saves do ScummVM a extensão gerou, e de onde

async function loadMarks() {
  try {
    const m = JSON.parse(await fsp.readFile(path.join(dataDir(), CONVERT_MARKS), 'utf8'));
    return (m && typeof m === 'object' && !Array.isArray(m)) ? m : {};
  } catch (err) {
    return {};
  }
}

async function saveMarks(marks) {
  await fsp.mkdir(dataDir(), { recursive: true });
  await fsp.writeFile(path.join(dataDir(), CONVERT_MARKS), JSON.stringify(marks, null, 2));
}

/** SaveNN.tlj do jogo original nas pastas conhecidas (a pasta Save e as subpastas de perfil, como 01) */
async function originalSaveFiles() {
  const out = [];
  const list = async d => { try { return await fsp.readdir(d, { withFileTypes: true }); } catch (err) { return []; } };
  for (const dir of await originalSavesDirs().catch(() => [])) {
    for (const e of await list(dir)) {
      if (e.isFile() && saveconv.NATIVE_SAVE.test(e.name)) out.push(path.join(dir, e.name));
      else if (e.isDirectory()) {
        for (const f of await list(path.join(dir, e.name))) {
          if (f.isFile() && saveconv.NATIVE_SAVE.test(f.name)) out.push(path.join(dir, e.name, f.name));
        }
      }
    }
  }
  return out.sort();
}

/** nome que o ScummVM daria a um jogo novo, sem repetir um que já existe no scummvm.ini */
function newTargetName(ini) {
  const names = new Set(ini.sections.map(s => s.name.toLowerCase()));
  let name = SCUMMVM_TARGET;
  for (let n = 1; names.has(name.toLowerCase()); n++) name = `${SCUMMVM_TARGET}-vortex${n > 1 ? n : ''}`;
  return name;
}

/** nome do jogo no scummvm.ini que o Vortex abre (sem alterar nada): o que já aponta para a pasta do jogo
 *  ou o nome que ensureScummVMTarget vai dar. Os saves do ScummVM se chamam <nome>-NNN.tlj. */
async function scummvmTargetName(exe, game) {
  const cfg = exe ? await scummvmConfig(exe) : { file: IS_WIN
    ? path.join(process.env.APPDATA || os.homedir(), 'ScummVM', 'scummvm.ini')
    : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'scummvm', 'scummvm.ini') };
  let text;
  try { text = await fsp.readFile(cfg.file, 'utf8'); } catch (err) { text = ''; }
  const ini = parseIni(text);
  const shadow = path.join(dataDir(), SHADOW_DIR);
  const ours = ini.sections.find(s => s.keys.gameid && s.keys.gameid.value === 'tlj' && s.keys.path
    && [game, shadow].some(p => samePath(s.keys.path.value, p)));
  return ours ? ours.name : newTargetName(ini);
}

/**
 * Converte saves do jogo original para a pasta de saves do ScummVM. Nunca sobrescreve um save do
 * jogador: só regrava a cópia que a própria extensão fez (se o original mudou desde então).
 * items: [{ file, id? }] (id identifica a origem; padrão: o caminho do arquivo)
 */
async function convertSaves(api, items, prefs) {
  const game = gamePath(api);
  if (!game) throw new Error(tr('gameNotFound'));
  prefs = prefs || await loadPrefs();
  const exe = await findScummVM(prefs);
  const dir = await scummvmSavesDir(exe);
  const target = await scummvmTargetName(exe, game);
  const G = new saveconv.Game(game);
  const done = await loadMarks();
  const res = { dir, target, converted: [], unchanged: [], failed: [] };
  await fsp.mkdir(dir, { recursive: true });
  const fileName = slot => `${target}-${String(slot).padStart(3, '0')}.tlj`;
  const reserved = new Set(Object.keys(done).map(k => done[k].name));
  const indexes = new Map();
  const mine = new RegExp(`^${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d{3})\\.tlj$`, 'i');
  let names = [];
  try { names = await fsp.readdir(dir); } catch (err) { names = []; }
  const playerSlots = names.filter(n => mine.test(n) && !reserved.has(n)).map(n => parseInt(mine.exec(n)[1], 10));
  let cursor = convertBaseSlot(playerSlots);
  for (const { file, id: given } of items) {
    const id = given || file;
    const shown = path.basename(file);
    try {
      const raw = await fsp.readFile(file);
      const stamp = crypto.createHash('sha1').update(raw).digest('hex');
      const mark = done[id];
      let name = null;
      if (mark && mark.name.startsWith(`${target}-`)) {
        const old = await statSafe(path.join(dir, mark.name));
        // a cópia continua lá e ainda é a que a extensão gravou: fica no mesmo slot (ou nem regrava)
        const ours = old && old.size === mark.size && Math.round(old.mtimeMs) === mark.mtime;
        if (ours && mark.stamp === stamp) { res.unchanged.push(mark.name); continue; }
        if (ours) name = mark.name;
        else reserved.delete(mark.name);   // apagada ou substituída: ganha um slot novo pela regra da página
      }
      if (!name) {
        const free = async slot => !reserved.has(fileName(slot)) && !await statSafe(path.join(dir, fileName(slot)));
        for (let slot = cursor; !name && slot <= 999; slot++) if (await free(slot)) { name = fileName(slot); cursor = slot + 1; }
        if (!name) throw new Error('no free ScummVM slot');
      }
      const d = path.dirname(file);
      if (!indexes.has(d)) indexes.set(d, saveconv.readIndex(d));
      const r = saveconv.convertSave(G, file, indexes.get(d));
      const dest = path.join(dir, name);
      await fsp.writeFile(`${dest}.vortex_tmp`, r.data);
      await fsp.rename(`${dest}.vortex_tmp`, dest);
      const st = await fsp.stat(dest);
      done[id] = { name, stamp, size: st.size, mtime: Math.round(st.mtimeMs) };
      reserved.add(name);
      res.converted.push(name);
      log('info', 'tlj: save do jogo original convertido para o ScummVM',
          { from: file, to: dest, description: r.description, location: r.location, notes: r.notes });
    } catch (err) {
      res.failed.push(`${shown}: ${err.message}`);
      log('warn', 'tlj: save do jogo original não convertido', { file, error: err.message });
    }
    await new Promise(resolve => setTimeout(resolve, 0));   // deixa o Vortex respirar entre um save e outro
  }
  await saveMarks(done);
  return res;
}

/** converte com aviso de progresso e mostra o resultado (searched: pastas procuradas, para a mensagem
 *  de "nenhum save encontrado") */
async function runConversion(api, items, prefs, searched) {
  if (!items.length) {
    if (typeof api.showDialog === 'function') {
      await api.showDialog('info', tr('convertSavesTitle'), {
        text: tr('convertSavesNone', { dir: (searched || []).join('\n') }),
      }, [{ label: tr('close'), default: true }]);
    }
    return { converted: [], unchanged: [], failed: [] };
  }
  if (typeof api.sendNotification === 'function') {
    api.sendNotification({ id: CONVERT_NOTIFICATION, type: 'activity', message: tr('convertingSaves'), noDismiss: true });
  }
  let res;
  try {
    res = await convertSaves(api, items, prefs);
  } catch (err) {
    res = { failed: [err.message], converted: [], unchanged: [] };
  } finally {
    if (typeof api.dismissNotification === 'function') api.dismissNotification(CONVERT_NOTIFICATION);
  }
  if (typeof api.showDialog !== 'function') return res;
  const parts = [];
  if (res.converted.length) parts.push(tr('convertSavesDone', { count: res.converted.length, dir: res.dir,
                                                         first: res.converted[0].replace(/\.tlj$/i, '') }));
  if (res.unchanged.length) parts.push(tr('convertSavesUnchanged', { count: res.unchanged.length }));
  if (res.failed.length) parts.push(tr('convertSavesFailed', { list: res.failed.join('\n') }));
  const buttons = res.dir ? [{ label: tr('openSavesFolder') }] : [];
  buttons.push({ label: tr('close'), default: true });
  const r = await api.showDialog(res.converted.length || res.unchanged.length ? 'info' : 'error', tr('convertSavesTitle'),
                                 { text: parts.join('\n\n') }, buttons);
  if (res.dir && r && r.action === tr('openSavesFolder')) await openFolder(res.dir);
  return res;
}

// ---- pasta de saves e remoção do ScummVM baixado
/** scummvm.exe da cópia que a extensão baixou, se ela existir */
function ownScummVM() {
  return findFile(path.join(dataDir(), OWN_DIR), SCUMMVM_EXE, 3);
}

/** pasta de saves padrão do ScummVM (sem scummvm.ini que diga outra) */
function defaultSavesDir() {
  if (IS_WIN) {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ScummVM', 'Saved games');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Documents', 'ScummVM Savegames');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'scummvm', 'saves');
}

/** pasta onde o ScummVM guarda os saves: a do scummvm.ini (do jogo ou geral), a do modo portátil
 *  (ao lado do scummvm.exe) ou a padrão */
async function scummvmSavesDir(exe) {
  if (!exe) return defaultSavesDir();
  const cfg = await scummvmConfig(exe);
  let text;
  try { text = await fsp.readFile(cfg.file, 'utf8'); } catch (err) { text = ''; }
  const ini = parseIni(text);
  const shadow = path.join(dataDir(), SHADOW_DIR);
  const ours = ini.sections.find(s => s.keys.gameid && s.keys.gameid.value === 'tlj'
    && ((s.keys.description && s.keys.description.value === OWN_DESCRIPTION)
        || (s.keys.path && samePath(s.keys.path.value, shadow))));
  const general = ini.sections.find(s => s.name.toLowerCase() === 'scummvm');
  const custom = (ours && ours.keys.savepath && ours.keys.savepath.value)
    || (general && general.keys.savepath && general.keys.savepath.value);
  if (custom) return path.resolve(path.dirname(cfg.file), custom);
  if (cfg.portable) return path.dirname(exe);
  return defaultSavesDir();
}

async function openFolder(dir) {
  try {
    await fsp.mkdir(dir, { recursive: true });
    Promise.resolve(util.opn(dir)).catch(() => null);
  } catch (err) {
    log('warn', 'tlj: não foi possível abrir a pasta', err.message);
  }
}

/** apaga uma pasta nossa (a pasta-sombra, o ScummVM baixado) sem nunca entrar em links: junções e links
 *  simbólicos saem só eles (as pastas do jogo continuam intactas) e apagar um hardlink não apaga o
 *  arquivo do jogo. Por garantia, uma subpasta cujo caminho real fica fora da pasta também é tratada
 *  como link (rmdir sem recursão: se ela tiver arquivos, falha em vez de apagar). */
async function removeShadowDir(dir) {
  const st = await lstatSafe(dir);
  if (!st) return;
  if (st.isSymbolicLink()) { await removeLink(dir); return; }
  if (!st.isDirectory()) { await fsp.unlink(dir); return; }
  const realDir = await fsp.realpath(dir);
  const norm = (p) => (IS_WIN ? p.toLowerCase() : p);
  for (const name of await fsp.readdir(dir)) {
    const p = path.join(dir, name);
    const l = await lstatSafe(p);
    if (!l) continue;
    if (l.isSymbolicLink()) {
      await removeLink(p);
    } else if (l.isDirectory()) {
      const real = await fsp.realpath(p).catch(() => '');
      if (real && norm(real).startsWith(norm(realDir + path.sep))) await removeShadowDir(p);
      else await removeLink(p);
    } else {
      await fsp.unlink(p);
    }
  }
  await fsp.rmdir(dir);
}

/** tira do scummvm.ini o jogo que a extensão cadastrou; um jogo do próprio jogador que apontava para a
 *  pasta-sombra volta a apontar para a pasta do jogo. Devolve quantos jogos mudaram. */
async function removeOwnTargets(cfgFile, game) {
  let text;
  try { text = await fsp.readFile(cfgFile, 'utf8'); } catch (err) { return 0; }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const ini = parseIni(text);
  const lines = ini.lines.slice();
  const heads = [];
  lines.forEach((ln, i) => { if (/^\s*\[([^\]]+)\]\s*$/.test(ln)) heads.push(i); });
  const shadow = path.join(dataDir(), SHADOW_DIR);
  const drop = new Set();
  let changed = 0;
  ini.sections.forEach((sec, n) => {
    if (!sec.keys.gameid || sec.keys.gameid.value !== 'tlj') return;
    const end = n + 1 < heads.length ? heads[n + 1] : lines.length;
    const mine = sec.keys.description && sec.keys.description.value === OWN_DESCRIPTION;
    const inShadow = sec.keys.path && samePath(sec.keys.path.value, shadow);
    if (!mine && !inShadow) return;
    if (!mine) {
      // jogo cadastrado pelo próprio jogador: só volta a apontar para a pasta do jogo
      if (!game) return;
      lines[sec.keys.path.line] = `path=${game}`;
      changed++;
      return;
    }
    changed++;
    for (let i = heads[n]; i < end; i++) drop.add(i);
  });
  if (!changed) return 0;
  const out = lines.filter((_, i) => !drop.has(i)).join(eol).replace(/(\r?\n){3,}/g, eol + eol);
  await fsp.writeFile(cfgFile, out);
  return changed;
}

/** "Remover o ScummVM baixado": apaga a cópia baixada, a pasta-sombra e o jogo que a extensão cadastrou
 *  no scummvm.ini. Os saves ficam (fora do modo portátil eles estão em outra pasta). */
async function removeDownloadedScummVM(api) {
  const base = path.join(dataDir(), OWN_DIR);
  const exe = await ownScummVM();
  if (!exe) return false;
  const cfg = await scummvmConfig(exe);
  const saves = await scummvmSavesDir(exe);
  const OPEN = tr('openSavesFolder');
  if (cfg.portable) {
    // modo portátil: configurações e saves estão dentro da pasta; nada é apagado
    const res = await api.showDialog('info', tr('removeDownloadedScummvm'), {
      text: tr('portableRemoveBody', { dir: base }),
    }, [{ label: OPEN }, { label: tr('close'), default: true }]);
    if (res && res.action === OPEN) await openFolder(base);
    return false;
  }
  const shadow = path.join(dataDir(), SHADOW_DIR);
  const REMOVE = tr('removeDownloadedScummvm');
  const res = await api.showDialog('question', REMOVE, {
    text: tr('removeScummvmBody', { dir: base, shadow, saves }),
  }, [{ label: tr('cancel') }, { label: REMOVE, default: true }]);
  if (!res || res.action !== REMOVE) return false;
  const trash = path.join(dataDir(), 'ScummVM_remover');
  try {
    await removeShadowDir(trash);   // sobra de uma tentativa anterior (pasta só nossa)
    await fsp.rename(base, trash);   // no Windows falha se o ScummVM estiver aberto, e aí nada é apagado
  } catch (err) {
    if (typeof api.showErrorNotification === 'function') {
      api.showErrorNotification(tr('scummvmRemoveFailed'), err, { allowReport: false });
    }
    return false;
  }
  await removeOwnTargets(cfg.file, gamePath(api)).catch(err => log('warn', 'tlj: limpar o scummvm.ini', err.message));
  await removeShadowDir(shadow).catch(err => log('warn', 'tlj: apagar a pasta-sombra', err.message));
  await removeShadowDir(trash).catch(err => log('warn', 'tlj: apagar o ScummVM', err.message));
  const prefs = await loadPrefs();
  const rel = prefs.scummvmExe ? path.relative(base, prefs.scummvmExe) : '';
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    delete prefs.scummvmExe;
    await savePrefs(prefs);
  }
  if (typeof api.sendNotification === 'function') {
    api.sendNotification({
      id: 'tlj-scummvm-removed', type: 'success',
      message: tr('scummvmRemoved', { saves }),
      actions: [{ title: OPEN, action: (dismiss) => { dismiss(); openFolder(saves); } }],
    });
  }
  return true;
}

/** depois de cada deploy (se o jogador já usa o ScummVM pelo Vortex): atualiza a pasta-sombra e o
 *  scummvm.ini, para o jogo também abrir certo direto pelo ScummVM */
async function refreshShadow(api, profileId) {
  const profile = util.getSafe(api.getState(), ['persistent', 'profiles', profileId], undefined);
  if (profile !== undefined && profile.gameId !== GAME_ID) return;
  const game = gamePath(api);
  const shadow = path.join(dataDir(), SHADOW_DIR);
  if (!game || !(await statSafe(shadow))) return;
  const scvPath = await scummvmGamePath(game);
  const exe = await findScummVM(await loadPrefs());
  if (exe) await ensureScummVMTarget((await scummvmConfig(exe)).file, scvPath, game);
}

// ---------------------------------------------------------------- cópias antigas desta extensão
// Até a 0.2.4 o info.json não tinha "id": cada "Install From File" com um zip de nome diferente criava
// outra pasta em plugins e o Vortex carregava TODAS as versões ao mesmo tempo (as antigas também decidiam
// onde abrir o jogo). Agora o "id" fixo faz cada versão nova substituir a anterior, e esta versão acha as
// cópias antigas que já existem e oferece removê-las.
const EXT_NAME = 'The Longest Journey';
const EXT_AUTHOR = 'mateusmoa';
const EXT_LEGACY_AUTHOR = 'Nateus009';
const EXT_SIGNATURE = "const GAME_ID = 'thelongestjourney';";

function versionCmp(a, b) {
  const pa = String(a).split(/[.-]/).map(n => parseInt(n, 10) || 0);
  const pb = String(b).split(/[.-]/).map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** outras pastas em plugins com esta mesma extensão (mesmo nome, autor e código do jogo) */
async function findOtherCopies(pluginsDir, myDir) {
  let entries;
  try { entries = await fsp.readdir(pluginsDir, { withFileTypes: true }); } catch (err) { return []; }
  const res = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(pluginsDir, e.name);
    if (samePath(dir, myDir)) continue;
    let info;
    try { info = JSON.parse(await fsp.readFile(path.join(dir, 'info.json'), 'utf8')); } catch (err) { continue; }
    if (!info || info.name !== EXT_NAME || ![EXT_AUTHOR, EXT_LEGACY_AUTHOR].includes(info.author)) continue;
    let code = '';
    try { code = await fsp.readFile(path.join(dir, 'index.js'), 'utf8'); } catch (err) { continue; }
    if (!code.includes(EXT_SIGNATURE)) continue;
    res.push({ dir, folder: e.name, version: String(info.version || '0.0.0') });
  }
  return res;
}

async function removeCopies(api, copies) {
  const failed = [];
  for (const c of copies) {
    try {
      await fsp.rm(c.dir, { recursive: true, force: true });
    } catch (err) {
      failed.push(`${c.folder} (${err.message})`);
    }
  }
  if (typeof api.sendNotification !== 'function') return failed;
  api.sendNotification(failed.length === 0
    ? { id: 'tlj-copias-removidas', type: 'success',
        message: tr('oldCopiesRemoved') }
    : { id: 'tlj-copias-removidas', type: 'error',
        message: tr('oldCopiesRemoveFailed', { files: failed.join(', ') }) });
  return failed;
}

async function checkOtherCopies(api, myDir = __dirname) {
  let myVersion = '0.0.0';
  try { myVersion = JSON.parse(await fsp.readFile(path.join(myDir, 'info.json'), 'utf8')).version; } catch (err) { /* sem info.json */ }
  const others = await findOtherCopies(path.dirname(myDir), myDir);   // plugins é a pasta-mãe desta extensão
  if (others.length === 0 || others.some(o => versionCmp(o.version, myVersion) > 0)) return others;   // a mais nova avisa
  if (typeof api.sendNotification === 'function') {
    const n = others.length;
    const versions = others.map(o => o.version).join(', ');
    api.sendNotification({
      id: 'tlj-copias-antigas',
      type: 'warning',
      message: tr('oldCopiesDetected', { count: n, versions }),
      actions: [{
        title: tr('removeOldCopies'),
        action: (dismiss) => { dismiss(); removeCopies(api, others).catch(err => log('warn', 'tlj: remover cópias', err.message)); },
      }],
    });
  }
  return others;
}

/** tira chaves de preferência de versões antigas (a 0.2.0 guardava "engine", que forçava o ScummVM) */
async function cleanLegacyPrefs() {
  const prefs = await loadPrefs();
  let changed = false;
  for (const k of ['engine', 'manual', 'toldAuto']) {
    if (prefs[k] !== undefined) { delete prefs[k]; changed = true; }
  }
  if (changed) await savePrefs(prefs);
}

// ---------------------------------------------------------------- registro
function main(context) {
  apiRef = context.api;
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
        name: tr('settingsTool'),
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
  context.registerInstaller('tlj-scummvm-saves', 26, testSavePack, makeInstallSavePack(context.api));
  context.registerInstaller('tlj-scummvm-assets', 27, testAssetMod, makeInstallAssetMod(context.api));
  context.registerInstaller('tlj-root-files', 30, testRootMod, makeInstallRootMod(context.api));

  // ScummVM automático (mods em HD)
  if (typeof context.registerStartHook === 'function') {
    // depois do "check-deployment" do Vortex (prioridade 100): a pasta do jogo já está atualizada
    context.registerStartHook(150, 'tlj-scummvm', makeStartHook(context.api));
  }
  if (typeof context.registerAction === 'function') {
    context.registerAction('mod-icons', 300, 'launch-simple', {}, 'ScummVM',
      () => { configureEngine(context.api).catch(err => log('warn', 'tlj: configurar ScummVM', err.message)); },
      () => selectors !== undefined && selectors.activeGameId(context.api.getState()) === GAME_ID);
  }
  if (typeof context.once === 'function') {
    context.once(() => {
      context.api.onAsync('did-deploy', (profileId) => refreshShadow(context.api, profileId)
        .catch(err => log('warn', 'tlj: pasta-sombra do ScummVM', err.message)));
      cleanLegacyPrefs().catch(err => log('warn', 'tlj: preferências antigas', err.message));
      checkOtherCopies(context.api).catch(err => log('warn', 'tlj: cópias antigas da extensão', err.message));
    });
  }
  return true;
}

module.exports = {
  default: main,
  // exportado só para testes automatizados
  _internals: { readPatch, applyEntry, applyXarc, crc32, rootIndex, resolveCi, modsIndex, assetLevelIndex, modNameFrom,
                GAME_ID, SCUMMVM_RELEASE, dataDir, findScummVM, unzipFile, downloadTo, syncShadow, scummvmGamePath,
                ensureScummVMTarget, isTljLaunch, makeStartHook, loadPrefs, savePrefs, parseIni,
                downloadScummVM, configureEngine, refreshShadow, SHADOW_DIR, decideEngine, enabledModsByEngine,
                scanEngine, engineOfFiles, findOtherCopies, checkOtherCopies, removeCopies, versionCmp, cleanLegacyPrefs,
                pickLanguage, systemLocale, tr, ownScummVM, defaultSavesDir, scummvmSavesDir, openFolder,
                removeShadowDir, removeOwnTargets, removeDownloadedScummVM, obtainScummVM, OWN_DIR, OWN_DESCRIPTION,
                originalSavesDirs, warnOriginalSaves, originalSavesTarget, originalSaveFiles, convertSaves,
                runConversion, scummvmTargetName, convertBaseSlot,
                setSaveConverter: impl => { saveconv = impl; } },
};
