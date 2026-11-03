'use strict';

// node --test tests/localization.test.js (Node.js 18+). No Vortex installation required.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { pickLanguage, translate } = require('../i18n');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const languages = ['pt', 'en', 'pl', 'it', 'fr', 'es', 'de', 'nl', 'hu', 'nb', 'ru', 'sv', 'cs', 'zh', 'ko'];
const en = require('../locales/en.json');
const markers = text => [...text.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]).sort();

test('language priority, regional codes, system fallback and unsupported languages', () => {
  for (const lang of languages) {
    for (const locale of [lang, `${lang}-XX`, ` ${lang.toUpperCase()}_XX.UTF-8 `, `${lang}_XX@variant`]) {
      assert.equal(pickLanguage(locale, 'en-US'), lang);
      for (const selected of [undefined, null, '', ' ', 'en', 'en-US']) {
        assert.equal(pickLanguage(selected, locale), lang);
      }
    }
    if (lang !== 'en') assert.equal(pickLanguage(lang, 'pt-BR'), lang);
  }
  for (const unsupported of ['tr-TR', 'ja', 'english', '__proto__', 'constructor']) {
    assert.equal(pickLanguage(unsupported, 'pt-BR'), 'en');
    assert.equal(pickLanguage('en', unsupported), 'en');
  }
  assert.equal(pickLanguage(undefined, undefined), 'en');
  assert.equal(pickLanguage(42, {}), 'en');
  for (const nor of ['no', 'nb-NO', 'nn_NO.UTF-8']) assert.equal(pickLanguage(nor, 'en-US'), 'nb');
  for (const zh of ['zh', 'zh-CN', 'zh-Hans-CN', 'zh_SG.UTF-8']) assert.equal(pickLanguage(zh, 'en-US'), 'zh');
  assert.equal(pickLanguage('en', 'ko-KR'), 'ko');
});

test('all user-facing keys and parameters are present in all catalogs', () => {
  const used = [...new Set([...source.matchAll(/\btr\('([^']+)'/g)].map(m => m[1]))].sort();
  assert.deepEqual(used, Object.keys(en).sort());
  assert.equal(used.length, 98);
  for (const lang of languages) {
    const catalog = require(`../locales/${lang}.json`);
    assert.deepEqual(Object.keys(catalog).sort(), used, lang);
    for (const key of used) {
      assert.equal(typeof catalog[key], 'string', `${lang}:${key}`);
      assert.ok(catalog[key].trim(), `${lang}:${key}`);
      assert.deepEqual(markers(catalog[key]), markers(en[key]), `${lang}:${key}`);
      const values = Object.fromEntries(markers(en[key]).map(name => [name, `${name}:42`]));
      assert.doesNotMatch(translate(lang, key, values), /\{\{\w+\}\}/, `${lang}:${key}`);
    }
  }
});

test('English fallback and literal interpolation preserve filenames and error text', () => {
  const pl = require('../locales/pl.json');
  const saved = pl.close;
  try {
    delete pl.close;
    assert.equal(translate('pl', 'close'), 'Close');
  } finally { pl.close = saved; }
  assert.equal(translate('tr', 'close'), 'Close');
  assert.equal(translate('pt-BR', 'close'), 'Fechar');
  assert.equal(translate('en', 'unknownKey'), 'unknownKey');
  assert.equal(translate('en', 'constructor'), 'constructor');
  const file = 'C:\\Żółć\\ação $& {{error}}.tljpatch';
  const error = '$1 $` $\' {{file}}';
  assert.equal(translate('en', 'patchReadFailed', { file, error }), `Could not read ${file}: ${error}`);
});

function harness(lang, temp) {
  class UserCanceled extends Error {}
  class ProcessCanceled extends Error {}
  const game = path.join(temp, 'game');
  fs.mkdirSync(game, { recursive: true });
  const state = {
    settings: { interface: { language: lang }, gameMode: { discovered: { thelongestjourney: { path: game } } } },
    persistent: { mods: { thelongestjourney: {} } },
    profile: { id: 'profile', gameId: 'thelongestjourney', modState: {} },
  };
  const notifications = [], dialogs = [], dispatched = [], opened = [], installers = {};
  let answer = () => undefined;
  const getSafe = (obj, keys, fallback) => {
    for (const key of keys) obj = obj == null ? undefined : obj[key];
    return obj === undefined ? fallback : obj;
  };
  const api = {
    getState: () => state,
    sendNotification: notification => notifications.push(notification),
    showDialog: async (type, title, content, buttons) => {
      const dialog = { type, title, content, buttons };
      dialogs.push(dialog);
      return answer(dialog);
    },
    selectExecutable: async options => {
      assert.equal(options.title, translate(lang, 'selectScummvm'));
      return path.join(temp, 'selected-scummvm.exe');
    },
    store: { dispatch: action => dispatched.push(action) },
    events: { emit: (event, callback) => { assert.equal(event, 'deploy-mods'); callback(); } },
  };
  const vortex = {
    util: { getSafe, getVortexPath: () => temp, UserCanceled, ProcessCanceled, opn: p => opened.push(p) },
    log: () => {},
    selectors: { activeProfile: s => s.profile, activeGameId: () => 'thelongestjourney', installPathForGame: () => temp },
    actions: { setModEnabled: (profile, id, enabled) => ({ profile, id, enabled }) },
  };
  const nativeRequire = createRequire(path.join(root, 'index.js'));
  const sandbox = {
    module: { exports: {} }, __dirname: root, Buffer, URL, setTimeout, clearTimeout,
    process: { platform: 'win32', env: { APPDATA: temp } }, navigator: { language: 'en-US' },
    require: name => {
      if (name === 'vortex-api') return vortex;
      if (name === 'http' || name === 'https') return { get: () => { throw new Error('Unexpected network request'); } };
      return nativeRequire(name);
    },
  };
  vm.runInNewContext(source, sandbox, { filename: path.join(root, 'index.js') });
  const extension = sandbox.module.exports;
  let registration;
  assert.equal(extension.default({
    api,
    registerGame: g => { registration = g; },
    registerInstaller: (id, priority, supported, install) => { installers[id] = { supported, install }; },
    registerStartHook: () => {}, registerAction: () => {},
  }), true);
  return { api, state, game, registration, installers, notifications, dialogs, dispatched, opened,
    internals: extension._internals, UserCanceled, ProcessCanceled, answer: fn => { answer = fn; } };
}

test('removing the helper (shadow) folder never touches the game files', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tlj-shadow-'));
  try {
    const { internals: i, game } = harness('en', temp);
    fs.mkdirSync(path.join(game, '08', '01'), { recursive: true });
    fs.writeFileSync(path.join(game, '08', '01', 'scene.xarc'), 'scene');
    fs.writeFileSync(path.join(game, 'x.xarc'), 'root');
    fs.writeFileSync(path.join(game, 'chapters.ini'), 'translated');
    const shadow = path.join(temp, 'thelongestjourney', i.SHADOW_DIR);
    await i.syncShadow(game, shadow, Buffer.from('original'));
    assert.ok(fs.lstatSync(path.join(shadow, '08')).isSymbolicLink());
    assert.equal(fs.statSync(path.join(shadow, 'x.xarc')).ino, fs.statSync(path.join(game, 'x.xarc')).ino);
    assert.equal(fs.readFileSync(path.join(shadow, 'chapters.ini'), 'utf8'), 'original');
    fs.mkdirSync(path.join(shadow, 'real-folder'));
    fs.writeFileSync(path.join(shadow, 'real-folder', 'note.txt'), 'x');
    await i.removeShadowDir(shadow);
    assert.ok(!fs.existsSync(shadow));
    assert.equal(fs.readFileSync(path.join(game, '08', '01', 'scene.xarc'), 'utf8'), 'scene');
    assert.equal(fs.readFileSync(path.join(game, 'x.xarc'), 'utf8'), 'root');
    assert.equal(fs.readFileSync(path.join(game, 'chapters.ini'), 'utf8'), 'translated');
    await i.removeShadowDir(shadow);   // já não existe: não é erro
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('scummvm.ini cleanup and saved-games folder', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tlj-ini-'));
  try {
    const { internals: i, game } = harness('en', temp);
    const shadow = path.join(temp, 'thelongestjourney', i.SHADOW_DIR);
    const cfg = path.join(temp, 'ScummVM', 'scummvm.ini');
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.writeFileSync(cfg, ['[scummvm]', 'versioninfo=2026.4.0', '', '[tlj-win]', 'description=The Longest Journey',
      'gameid=tlj', `path=${shadow}`, 'savepath=D:\\TLJ saves', '', '[tlj-win-vortex]', `description=${i.OWN_DESCRIPTION}`,
      'gameid=tlj', `path=${game}`, '', '', '', '[monkey]', 'gameid=monkey', ''].join('\r\n'));
    assert.equal(await i.removeOwnTargets(cfg, game), 2);
    const out = fs.readFileSync(cfg, 'utf8');
    assert.ok(!out.includes('[tlj-win-vortex]'));
    assert.ok(out.includes(`[tlj-win]\r\ndescription=The Longest Journey\r\ngameid=tlj\r\npath=${game}\r\nsavepath=D:\\TLJ saves`));
    assert.ok(out.includes('[monkey]') && !/(\r\n){3,}/.test(out));
    assert.equal(await i.removeOwnTargets(cfg, game), 0);
    assert.equal(await i.removeOwnTargets(path.join(temp, 'missing.ini'), game), 0);
    // jogo do próprio jogador na pasta-sombra, sem a pasta do jogo conhecida: fica como está
    fs.writeFileSync(cfg, `[tlj-win]\ngameid=tlj\npath=${shadow}\n`);
    assert.equal(await i.removeOwnTargets(cfg, undefined), 0);

    const exe = path.join(temp, 'thelongestjourney', 'ScummVM', 'scummvm.exe');
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, 'exe');
    assert.equal(await i.scummvmSavesDir(undefined), path.join(temp, 'ScummVM', 'Saved games'));
    assert.equal(await i.scummvmSavesDir(exe), path.join(temp, 'ScummVM', 'Saved games'));
    fs.writeFileSync(cfg, `[scummvm]\nsavepath=${path.join(temp, 'all')}\n\n[tlj-win]\ndescription=${i.OWN_DESCRIPTION}\ngameid=tlj\npath=${shadow}\n`);
    assert.equal(await i.scummvmSavesDir(exe), path.join(temp, 'all'));
    fs.appendFileSync(cfg, `savepath=${path.join(temp, 'tlj')}\n`);
    assert.equal(await i.scummvmSavesDir(exe), path.join(temp, 'tlj'));
    fs.writeFileSync(path.join(path.dirname(exe), 'scummvm.ini'), '');
    assert.equal(await i.scummvmSavesDir(exe), path.dirname(exe));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const str = s => { const b = Buffer.from(s); return Buffer.concat([u16(b.length), b]); };
const sha1 = b => crypto.createHash('sha1').update(b).digest();
const patch = entries => Buffer.concat([Buffer.from('TLJPTBR\x01', 'latin1'), str('test'), str('Test'), u32(entries.length), ...entries]);

for (const lang of languages) {
  test(`${lang}: registered tools, dialogs, button actions, installers and notifications`, async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tlj-i18n-'));
    try {
      const h = harness(lang, temp);
      const t = (key, values) => translate(lang, key, values);
      const { internals: i, api, state } = h;
      assert.equal(h.registration.id, 'thelongestjourney');
      assert.equal(h.registration.logo, 'gameart.png');
      assert.equal(h.registration.supportedTools[0].name, t('settingsTool'));
      state.settings.interface.language = 'de';
      assert.equal(i.tr('close'), 'Schließen');
      state.settings.interface.language = lang;
      assert.throws(() => i.readPatch(Buffer.alloc(0)), { message: t('patchTruncated') });
      assert.throws(() => i.readPatch(Buffer.alloc(8)), { message: t('patchUnknown') });
      assert.throws(() => i.readPatch(Buffer.from([0x1f, 0x8b])), { message: t('patchCorrupted') });

      const savesDir = path.join(temp, 'ScummVM', 'Saved games');
      h.answer(d => ({ action: d.buttons[0].label }));
      await i.configureEngine(api);
      assert.equal(Object.keys(await i.loadPrefs()).length, 0);
      h.answer(d => {
        assert.deepEqual(Array.from(d.buttons, b => b.label), [t('cancel'), t('openSavesFolder'), t('selectAnotherScummvm'), t('save')]);
        assert.equal(d.content.choices[0].text, t('autoMode'));
        assert.ok(d.content.text.includes(t('playPrompt')));
        assert.ok(d.content.text.includes(`ScummVM: ${t('scummvmNotFoundHint')}`));
        assert.ok(d.content.text.includes(t('savesFolderLine', { dir: savesDir })));
        return { action: t('save'), input: { game: true } };
      });
      await i.configureEngine(api);
      assert.equal((await i.loadPrefs()).mode, 'game');
      h.answer(() => ({ action: t('openSavesFolder') }));
      await i.configureEngine(api);
      assert.equal(h.opened.at(-1), savesDir);
      assert.ok(fs.existsSync(savesDir));
      h.answer(() => ({ action: t('selectAnotherScummvm') }));
      await i.configureEngine(api);
      assert.equal((await i.loadPrefs()).scummvmExe, path.join(temp, 'selected-scummvm.exe'));

      // ScummVM baixado pela extensão: o botão mostra "Remover", que apaga só o que é da extensão
      const ownDir = path.join(temp, 'thelongestjourney', 'ScummVM');
      const ownExe = path.join(ownDir, 'scummvm-2026.4.0', 'scummvm.exe');
      const shadow = path.join(temp, 'thelongestjourney', 'scummvm_pasta_jogo');
      const cfgFile = path.join(temp, 'ScummVM', 'scummvm.ini');
      const writeOwn = () => {
        fs.mkdirSync(path.dirname(ownExe), { recursive: true });
        fs.writeFileSync(ownExe, 'exe');
        fs.mkdirSync(shadow, { recursive: true });
        fs.writeFileSync(path.join(shadow, 'chapters.ini'), 'original');
        fs.writeFileSync(cfgFile, ['[scummvm]', 'lastselectedgame=tlj-win', '', '[tlj-win]', `description=${i.OWN_DESCRIPTION}`,
          'gameid=tlj', 'engineid=stark', `path=${shadow}`, '', '[monkey]', 'gameid=monkey', 'path=C:\\Games\\Monkey', ''].join('\r\n'));
      };
      writeOwn();
      await i.savePrefs({ mode: 'scummvm', scummvmExe: ownExe });
      h.answer(d => {
        if (d.title === 'The Longest Journey: ScummVM') {
          assert.deepEqual(Array.from(d.buttons, b => b.label),
            [t('cancel'), t('openSavesFolder'), t('removeDownloadedScummvm'), t('selectAnotherScummvm'), t('save')]);
          assert.ok(d.content.text.includes(`ScummVM: ${t('scummvmDownloadedPath', { exe: ownExe })}`));
          return { action: t('removeDownloadedScummvm') };
        }
        assert.equal(d.title, t('removeDownloadedScummvm'));
        assert.equal(d.content.text, t('removeScummvmBody', { dir: ownDir, shadow, saves: savesDir }));
        return { action: t('cancel') };
      });
      await i.configureEngine(api);
      assert.ok(fs.existsSync(ownExe), 'cancelar não apaga nada');
      h.answer(d => ({ action: t('removeDownloadedScummvm') }));
      await i.configureEngine(api);
      assert.ok(!fs.existsSync(ownDir));
      assert.ok(!fs.existsSync(shadow));
      assert.ok(!fs.existsSync(path.join(temp, 'thelongestjourney', 'ScummVM_remover')));
      const ini = fs.readFileSync(cfgFile, 'utf8');
      assert.ok(!ini.includes('[tlj-win]') && ini.includes('[monkey]') && ini.includes('lastselectedgame=tlj-win'));
      assert.deepEqual({ ...(await i.loadPrefs()) }, { mode: 'scummvm' });
      assert.equal(h.notifications.at(-1).message, t('scummvmRemoved', { saves: savesDir }));
      assert.equal(h.notifications.at(-1).actions[0].title, t('openSavesFolder'));
      h.notifications.at(-1).actions[0].action(() => {});
      h.answer(d => {
        assert.deepEqual(Array.from(d.buttons, b => b.label), [t('cancel'), t('openSavesFolder'), t('selectAnotherScummvm'), t('save')]);
        return { action: t('cancel') };
      });
      await i.configureEngine(api);

      // modo portátil (scummvm.ini ao lado do exe): os saves estão dentro da pasta, então nada é apagado
      writeOwn();
      fs.writeFileSync(path.join(path.dirname(ownExe), 'scummvm.ini'), '');
      h.answer(d => {
        if (d.title === 'The Longest Journey: ScummVM') {
          assert.ok(d.content.text.includes(t('savesFolderLine', { dir: path.dirname(ownExe) })));
          return { action: t('removeDownloadedScummvm') };
        }
        assert.equal(d.content.text, t('portableRemoveBody', { dir: ownDir }));
        assert.deepEqual(Array.from(d.buttons, b => b.label), [t('openSavesFolder'), t('close')]);
        return { action: t('openSavesFolder') };
      });
      await i.configureEngine(api);
      assert.equal(h.opened.at(-1), ownDir);
      assert.ok(fs.existsSync(ownExe) && fs.existsSync(shadow));
      fs.rmSync(ownDir, { recursive: true, force: true });
      fs.rmSync(shadow, { recursive: true, force: true });

      // primeira vez no ScummVM com saves do jogo original: aviso que aparece uma vez só
      h.dialogs.length = 0;
      await i.warnOriginalSaves(api, {});   // sem saves do jogo original: nada
      assert.equal(h.dialogs.length, 0);
      const origSaves = path.join(temp, 'The Longest Journey', 'Save');
      fs.mkdirSync(origSaves, { recursive: true });
      fs.writeFileSync(path.join(origSaves, 'save01'), 'x');
      h.answer(d => {
        assert.equal(d.title, t('originalSavesTitle'));
        assert.equal(d.content.text, t('originalSavesBody', { dir: origSaves, option: t('alwaysOriginal'), convert: t('convertOriginalSaves') }));
        assert.deepEqual(Array.from(d.buttons, b => b.label),
                         [t('openOriginalSavesFolder'), t('cancel'), t('convertOriginalSaves'), t('continue')]);
        return { action: t('openOriginalSavesFolder') };
      });
      await i.savePrefs({});
      await assert.rejects(i.warnOriginalSaves(api, await i.loadPrefs()), h.UserCanceled);
      assert.equal(h.opened.at(-1), origSaves);
      assert.equal((await i.loadPrefs()).toldOriginalSaves, true);
      h.dialogs.length = 0;
      await i.warnOriginalSaves(api, await i.loadPrefs());   // já avisou: não repete
      assert.equal(h.dialogs.length, 0);
      h.answer(() => ({ action: t('continue') }));
      await i.warnOriginalSaves(api, {});
      h.answer(() => ({ action: t('cancel') }));
      await assert.rejects(i.warnOriginalSaves(api, {}), h.UserCanceled);
      fs.rmSync(path.join(temp, 'The Longest Journey'), { recursive: true });
      const funcom = path.join(temp, 'Funcom', 'TLJ C--Games-TLJ', 'Save');
      fs.mkdirSync(funcom, { recursive: true });
      fs.writeFileSync(path.join(funcom, 'save01'), 'x');
      assert.deepEqual(Array.from(await i.originalSavesDirs()), [funcom]);
      fs.rmSync(path.join(temp, 'Funcom'), { recursive: true });
      await i.savePrefs({});

      const assets = h.installers['tlj-scummvm-assets'];
      const files = ['mods/TLJHD/08/01/xarc/scene.png', 'fonts/font.ttf', 'readme.txt'];
      assert.equal((await assets.supported(files, 'thelongestjourney')).supported, true);
      const assetResult = await assets.install(files, temp, 'thelongestjourney', null, null, false, 'Żółć $&.zip');
      assert.equal(assetResult.instructions.length, 3);
      assert.equal(assetResult.instructions[0].destination, files[0]);
      assert.equal(h.notifications.at(-1).message, t('detectedScummvmMod', { name: 'Żółć $&.zip' }));
      await h.installers['tlj-root-files'].install(['08/01/01.xarc', 'ddraw.dll'], temp, 'thelongestjourney', null, null, false, 'Wrapper.zip');
      assert.equal(h.notifications.at(-1).message, t('detectedOriginalMod', { name: 'Wrapper.zip' }));

      for (const saves of [['tlj-win-001.tlj'], ['custom-001.tlj', 'custom-002.tlj', 'custom-003.tlj', 'custom-004.tlj']]) {
        h.answer(d => {
          assert.equal(d.title, t('savePackTitle'));
          assert.ok(d.content.text.includes('%APPDATA%\\ScummVM\\Saved games'));
          assert.ok(d.content.text.includes(saves.length === 1 ? t('saveDefaultTarget') : t('saveCustomTarget', { ids: 'custom' })));
          return { action: t('openSavesFolder') };
        });
        await assert.rejects(h.installers['tlj-scummvm-saves'].install(saves), h.UserCanceled);
        assert.equal(h.opened.at(-1), path.join(temp, 'ScummVM', 'Saved games'));
      }

      // saves do jogo original (SaveNN.tlj + .tga + Index.dat): não são do ScummVM, o Vortex explica onde vão
      const savePack = h.installers['tlj-scummvm-saves'];
      const native = ['Save/', 'Save/01/', 'Save/01/Save00.tlj', 'Save/01/Save00.tga', 'Save/01/Save97.tlj', 'Save/01/Save97.tga', 'Save/01/Index.dat'];
      assert.equal((await savePack.supported(native, 'thelongestjourney')).supported, true);
      assert.equal((await savePack.supported(native, 'outrojogo')).supported, false);
      assert.equal((await savePack.supported([...native, 'game.xarc'], 'thelongestjourney')).supported, false);
      assert.equal((await savePack.supported(['Save00.tga', 'Index.dat'], 'thelongestjourney')).supported, false);
      const nativeDir = path.join(temp, 'The Longest Journey', 'Save');
      for (const withProfile of [false, true]) {
        fs.rmSync(path.join(temp, 'The Longest Journey'), { recursive: true, force: true });
        if (withProfile) fs.mkdirSync(path.join(nativeDir, '01'), { recursive: true });
        const target = withProfile ? path.join(nativeDir, '01') : nativeDir;
        h.answer(d => {
          assert.equal(d.title, t('originalSavesTitle'));
          assert.equal(d.content.text, t('originalSavePackBody', { count: 2, sample: 'Save00.tlj, Save97.tlj', dir: target, convert: t('convertOriginalSaves') }));
          assert.deepEqual(Array.from(d.buttons, b => b.label), [t('openOriginalSavesFolder'), t('close')]);
          return { action: t('openOriginalSavesFolder') };
        });
        await assert.rejects(savePack.install(native), h.UserCanceled);
        assert.equal(h.opened.at(-1), target);
      }
      // os dois tipos no mesmo pacote: uma explicação para cada
      const titles = [];
      h.answer(d => { titles.push(d.title); return { action: t('close') }; });
      const openedBefore = h.opened.length;
      await assert.rejects(savePack.install(['tlj-win-005.tlj', 'Save05.tlj', 'Save05.tga']), h.UserCanceled);
      assert.deepEqual(titles, [t('savePackTitle'), t('originalSavesTitle')]);
      assert.equal(h.opened.length, openedBefore);
      fs.rmSync(path.join(temp, 'The Longest Journey'), { recursive: true, force: true });

      // conversão dos saves do jogo original para o ScummVM (com um conversor de mentira: o de verdade
      // precisa dos arquivos do jogo e é testado em saveconv.test.js)
      const converted = [];
      i.setSaveConverter({
        NATIVE_SAVE: /^save(\d+)\.tlj$/i,
        nativeSlot: f => { const m = /save(\d+)\.tlj$/i.exec(f); return m ? parseInt(m[1], 10) : null; },
        readIndex: () => new Map(),
        Game: class { constructor(dir) { assert.equal(dir, h.game); } },
        convertSave: (g, f) => {
          if (/Save13/.test(f)) throw new Error('save estragado');
          converted.push(path.basename(f));
          return { data: Buffer.from(`ScummVM ${fs.readFileSync(f, 'latin1')}`), description: 'Capítulo 2', location: 'x', notes: [] };
        },
      });
      const profile = path.join(temp, 'The Longest Journey', 'Save', '01');
      fs.mkdirSync(profile, { recursive: true });
      for (const n of ['Save07.tlj', 'Save12.tlj', 'Save13.tlj']) fs.writeFileSync(path.join(profile, n), n);
      fs.writeFileSync(path.join(profile, 'Save07.tga'), 'tga');
      const scvSaves = path.join(temp, 'ScummVM', 'Saved games');
      fs.mkdirSync(scvSaves, { recursive: true });
      fs.writeFileSync(path.join(scvSaves, 'tlj-win-512.tlj'), 'save do jogador');   // slot 512 já é do jogador
      assert.deepEqual(Array.from(await i.originalSaveFiles()), ['Save07.tlj', 'Save12.tlj', 'Save13.tlj'].map(n => path.join(profile, n)));
      let convResult = null;
      h.answer(d => {
        if (d.title === 'The Longest Journey: ScummVM') {
          assert.ok(Array.from(d.buttons, b => b.label).includes(t('convertOriginalSaves')));
          return { action: t('convertOriginalSaves') };
        }
        convResult = d;
        return { action: t('openSavesFolder') };
      });
      await i.configureEngine(api);
      assert.equal(convResult.title, t('convertSavesTitle'));
      assert.equal(convResult.content.text, [t('convertSavesDone', { count: 2, dir: scvSaves, first: 'tlj-win-522' }),
        t('convertSavesFailed', { list: 'Save13.tlj: save estragado' })].join('\n\n'));
      assert.deepEqual(Array.from(convResult.buttons, b => b.label), [t('openSavesFolder'), t('close')]);
      assert.equal(h.opened.at(-1), scvSaves);
      assert.equal(fs.readFileSync(path.join(scvSaves, 'tlj-win-522.tlj'), 'latin1'), 'ScummVM Save07.tlj');   // 512 é do jogador: pula para a página seguinte + 1
      assert.equal(fs.readFileSync(path.join(scvSaves, 'tlj-win-512.tlj'), 'latin1'), 'save do jogador');   // intacto
      assert.equal(fs.readFileSync(path.join(scvSaves, 'tlj-win-523.tlj'), 'latin1'), 'ScummVM Save12.tlj');
      assert.equal(fs.readFileSync(path.join(profile, 'Save07.tlj'), 'latin1'), 'Save07.tlj');   // original intacto
      assert.equal(h.notifications.find(n => n.id === 'tlj-convert-saves').message, t('convertingSaves'));
      // de novo, sem mudanças: nada é regravado
      converted.length = 0;
      fs.rmSync(path.join(profile, 'Save13.tlj'));
      h.answer(d => { convResult = d; return d.title === 'The Longest Journey: ScummVM' ? { action: t('convertOriginalSaves') } : { action: t('close') }; });
      await i.configureEngine(api);
      assert.deepEqual(converted, []);
      assert.equal(convResult.content.text, t('convertSavesUnchanged', { count: 2 }));
      // o original mudou: só a cópia feita pela extensão é regravada, no mesmo slot
      fs.writeFileSync(path.join(profile, 'Save07.tlj'), 'Save07.tlj v2');
      await i.configureEngine(api);
      assert.deepEqual(converted, ['Save07.tlj']);
      assert.equal(fs.readFileSync(path.join(scvSaves, 'tlj-win-522.tlj'), 'latin1'), 'ScummVM Save07.tlj v2');
      assert.equal(convResult.content.text, [t('convertSavesDone', { count: 1, dir: scvSaves, first: 'tlj-win-522' }),
        t('convertSavesUnchanged', { count: 1 })].join('\n\n'));
      // o jogador gravou por cima da cópia no ScummVM: ela não é mais da extensão e vai para outro slot
      fs.writeFileSync(path.join(scvSaves, 'tlj-win-522.tlj'), 'salvo no ScummVM por cima');
      fs.writeFileSync(path.join(profile, 'Save07.tlj'), 'Save07.tlj v3');
      converted.length = 0;
      await i.configureEngine(api);
      assert.equal(fs.readFileSync(path.join(scvSaves, 'tlj-win-522.tlj'), 'latin1'), 'salvo no ScummVM por cima');
      assert.equal(fs.readFileSync(path.join(scvSaves, 'tlj-win-524.tlj'), 'latin1'), 'ScummVM Save07.tlj v3');
      // aviso de primeira vez: converte e segue abrindo o jogo
      converted.length = 0;
      fs.writeFileSync(path.join(profile, 'Save20.tlj'), 'Save20.tlj');
      h.answer(d => (d.title === t('originalSavesTitle') ? { action: t('convertOriginalSaves') } : { action: t('close') }));
      await i.warnOriginalSaves(api, {});
      assert.deepEqual(converted, ['Save20.tlj']);
      assert.equal(fs.readFileSync(path.join(scvSaves, 'tlj-win-540.tlj'), 'latin1'), 'ScummVM Save20.tlj');   // 522 virou do jogador: uma página vazia depois dele
      // pacote baixado com saves do jogo original: converte direto da pasta extraída
      const extracted = path.join(temp, 'pacote.installing');
      fs.mkdirSync(path.join(extracted, 'Saves'), { recursive: true });
      fs.writeFileSync(path.join(extracted, 'Saves', 'Save03.tlj'), 'Save03.tlj do pacote');
      converted.length = 0;
      h.answer(d => {
        if (d.title === t('originalSavesTitle')) {
          assert.deepEqual(Array.from(d.buttons, b => b.label), [t('openOriginalSavesFolder'), t('convertOriginalSaves'), t('close')]);
          return { action: t('convertOriginalSaves') };
        }
        convResult = d;
        return { action: t('close') };
      });
      await assert.rejects(savePack.install(['Saves/', 'Saves/Save03.tlj'], extracted, 'thelongestjourney', null, null, false, 'C:\\dl\\Saves.7z'),
                           h.UserCanceled);
      assert.deepEqual(converted, ['Save03.tlj']);
      assert.equal(fs.readFileSync(path.join(scvSaves, 'tlj-win-541.tlj'), 'latin1'), 'ScummVM Save03.tlj do pacote');
      assert.equal(convResult.content.text, t('convertSavesDone', { count: 1, dir: scvSaves, first: 'tlj-win-541' }));
      // nenhum save encontrado
      fs.rmSync(path.join(temp, 'The Longest Journey'), { recursive: true, force: true });
      fs.mkdirSync(path.join(temp, 'The Longest Journey', 'Save'), { recursive: true });
      fs.writeFileSync(path.join(temp, 'The Longest Journey', 'Save', 'Index.dat'), 'x');
      h.answer(d => { convResult = d; return d.title === 'The Longest Journey: ScummVM' ? { action: t('convertOriginalSaves') } : { action: t('close') }; });
      await i.configureEngine(api);
      assert.equal(convResult.content.text, t('convertSavesNone', { dir: path.join(temp, 'The Longest Journey', 'Save') }));
      fs.rmSync(path.join(temp, 'The Longest Journey'), { recursive: true, force: true });
      fs.rmSync(scvSaves, { recursive: true, force: true });
      await i.savePrefs({});

      const mods = state.persistent.mods.thelongestjourney;
      for (const [id, engine] of [['hd1', 'scummvm'], ['hd2', 'scummvm'], ['hd3', 'scummvm'], ['hd4', 'scummvm'], ['wrapper', 'exe'], ['translation', 'both']]) {
        mods[id] = { id, state: 'installed', attributes: { tljEngine: engine, name: id } };
        state.profile.modState[id] = { enabled: true };
      }
      for (const [choice, engine, disabled] of [
        ['exe', 'game', ['hd1', 'hd2', 'hd3', 'hd4']],
        ['scummvm_only', 'scummvm', ['wrapper', 'translation']],
        ['scummvm_compat', 'scummvm', ['wrapper']],
      ]) {
        h.dispatched.length = 0;
        h.answer(d => {
          assert.equal(d.title, t('conflictTitle'));
          assert.equal(d.buttons[1].label, t('continue'));
          assert.ok(d.content.text.includes(t('conflictBoth', { mods: '- translation' })));
          return { action: d.buttons[1].label, input: { [choice]: true } };
        });
        assert.equal(await i.decideEngine(api, h.game, {}), engine);
        assert.deepEqual(h.dispatched.map(a => a.id), disabled);
      }
      h.dispatched.length = 0;
      h.answer(() => ({ action: t('cancel') }));
      await assert.rejects(i.decideEngine(api, h.game, {}), h.UserCanceled);
      assert.equal(h.dispatched.length, 0);
      state.profile.modState.wrapper.enabled = false;
      assert.equal(await i.decideEngine(api, h.game, {}), 'scummvm');
      assert.equal(h.notifications.at(-1).message, t('autoScummvm', { mods: 'hd1, hd2, hd3', more: t('autoMore', { count: 1 }) }));

      const original = Buffer.from('[chapters]\n0=Original\n');
      const translated = Buffer.from('[chapters]\n0=Tradução\n');
      fs.writeFileSync(path.join(h.game, 'chapters.ini'), original);
      fs.writeFileSync(path.join(temp, 'translation.tljpatch'), patch([
        Buffer.concat([Buffer.from([2]), str('chapters.ini'), sha1(original), sha1(translated), u32(translated.length), translated]),
      ]));
      const patchInstaller = h.installers['tlj-tljpatch'].install;
      const result = await patchInstaller(['translation.tljpatch'], temp, 'thelongestjourney');
      assert.equal(result.instructions.length, 3);
      assert.equal(result.instructions[0].destination, 'chapters.ini');
      assert.equal(result.instructions[1].destination, path.join('mods', 'TLJ_PTBR', 'chapters.ini'));
      assert.deepEqual(fs.readFileSync(path.join(temp, result.instructions[0].source)), translated);
      const missing = Array.from({ length: 13 }, (_, n) => Buffer.concat([
        Buffer.from([1]), str(`missing-${n}.xarc`), Buffer.alloc(20), u32(0), Buffer.alloc(20), u32(0), u32(0), u32(0),
      ]));
      fs.writeFileSync(path.join(temp, 'missing.tljpatch'), patch(missing));
      await assert.rejects(patchInstaller(['missing.tljpatch'], temp, 'thelongestjourney'), { message: t('gameMismatch') });
      assert.equal(h.dialogs.at(-1).title, t('translationNotInstalled'));
      assert.ok(h.dialogs.at(-1).content.text.includes(t('problemsMore', { count: 1 })));
      assert.ok(h.dialogs.at(-1).content.text.includes(t('pathMissing', { path: 'missing-0.xarc' })));
      for (const dialog of h.dialogs) assert.doesNotMatch(dialog.content.text, /\{\{\w+\}\}/);
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  });
}
