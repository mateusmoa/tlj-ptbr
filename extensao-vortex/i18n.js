'use strict';

// Catálogos locais, sem rede nem dependências adicionais.
const catalogs = {
  en: require('./locales/en.json'),
  pt: require('./locales/pt.json'),
  pl: require('./locales/pl.json'),
  it: require('./locales/it.json'),
  fr: require('./locales/fr.json'),
  es: require('./locales/es.json'),
  de: require('./locales/de.json'),
  nl: require('./locales/nl.json'),
  hu: require('./locales/hu.json'),
  nb: require('./locales/nb.json'),
  ru: require('./locales/ru.json'),
  sv: require('./locales/sv.json'),
  cs: require('./locales/cs.json'),
  zh: require('./locales/zh.json'),
  ko: require('./locales/ko.json'),
};
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// Códigos que usam outro catálogo: norueguês (no, nb, nn) usa o bokmål (nb). Todas as variantes
// do chinês (zh-CN, zh-Hans, zh-TW...) caem em "zh", o chinês simplificado.
const ALIASES = { no: 'nb', nn: 'nb' };

// Aceita códigos regionais e de ambiente: pt-BR, pl_PL.UTF-8, de_DE@euro, zh-Hans-CN etc.
function languageCode(locale) {
  if (typeof locale !== 'string') return '';
  const code = locale.trim().toLowerCase().split(/[-_.@]/)[0];
  return has(ALIASES, code) ? ALIASES[code] : code;
}

function pickLanguage(vortexLang, sysLocale) {
  const selected = languageCode(vortexLang);
  if (typeof vortexLang === 'string' && vortexLang.trim() !== '' && selected !== 'en') {
    return has(catalogs, selected) ? selected : 'en';
  }
  // Preserva a regra da 0.2.6: inglês/padrão do Vortex usa o idioma do sistema,
  // agora para todos os idiomas disponíveis. Idiomas não disponíveis usam inglês.
  const system = languageCode(sysLocale);
  return has(catalogs, system) ? system : 'en';
}

function translate(language, key, values = {}) {
  const code = languageCode(language);
  const catalog = has(catalogs, code) ? catalogs[code] : catalogs.en;
  const template = has(catalog, key) ? catalog[key] : (has(catalogs.en, key) ? catalogs.en[key] : key);
  // Uma única passagem mantém nomes, caminhos e mensagens de erro intactos,
  // inclusive quando contêm "$&" ou texto parecido com um marcador.
  return template.replace(/\{\{(\w+)\}\}/g, (placeholder, name) =>
    has(values, name) ? String(values[name]) : placeholder);
}

module.exports = { pickLanguage, translate };
