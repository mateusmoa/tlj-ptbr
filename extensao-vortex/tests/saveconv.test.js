'use strict';

// node --test tests/saveconv.test.js
// Conversor de saves do jogo original para o ScummVM. Precisa dos arquivos do jogo e de saves de verdade,
// que não vêm junto: indique as pastas nas variáveis TLJ_GAME_DIR (pasta do jogo, com o x.xarc) e
// TLJ_SAVES_DIR (pasta com SaveNN.tlj). Sem elas, o teste é pulado.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const S = require('../saveconv');

const GAME = process.env.TLJ_GAME_DIR;
const SAVES = process.env.TLJ_SAVES_DIR;

test('converts every original save into a ScummVM save that matches the game files', { skip: !GAME || !SAVES }, () => {
  const game = new S.Game(GAME);
  const index = S.readIndex(SAVES);
  const files = fs.readdirSync(SAVES).filter(n => S.NATIVE_SAVE.test(n)).sort();
  assert.ok(files.length > 0);
  for (const f of files) {
    const r = S.convertSave(game, path.join(SAVES, f), index);   // convertSave já relê e confere o resultado
    const raw = zlib.gunzipSync(r.data);
    assert.deepEqual(raw, r.raw, f);
    assert.equal(raw.readUInt32LE(0), Buffer.byteLength(r.description, 'latin1') || raw.readUInt32LE(0), f);
    assert.match(raw.toString('latin1'), /Version:\t12/, f);
    assert.equal(r.slot, S.nativeSlot(f));
    // de novo: o resultado é sempre o mesmo
    assert.deepEqual(zlib.gunzipSync(S.convertSave(game, path.join(SAVES, f), index).data), raw, f);
  }
});

test('rejects files that are not saves from the original game', () => {
  const { readNative } = S._internals;
  const s32 = t => { const b = Buffer.from(t, 'latin1'); const n = Buffer.alloc(4); n.writeUInt32LE(b.length); return Buffer.concat([n, b]); };
  assert.throws(() => readNative(Buffer.concat([s32('x'), s32('08'), s32('01'), s32('Version:\t13')])), /game\.exe/);
  assert.throws(() => readNative(Buffer.concat([s32('x'), s32('08'), s32('01'), s32('outra coisa')])), /Longest Journey/);
  assert.throws(() => readNative(Buffer.alloc(3)), RangeError);
  assert.equal(S.nativeSlot('C:\\x\\Save07.tlj'), 7);
  assert.equal(S.nativeSlot('tlj-win-007.tlj'), null);
  assert.equal(S._internals.directionAngle(1, 0), 0);
  assert.equal(Math.round(S._internals.directionAngle(0, -1)), 90);
});
