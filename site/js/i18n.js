/*
 * Translations.
 *
 * To add a language (say German):
 *   1. add {"code": "de", "label": "Deutsch", "dir": "ltr"} to i18n/languages.json
 *   2. copy i18n/en.json to i18n/de.json and translate the values (keep the keys)
 *   3. copy data/content/en.json to data/content/de.json and translate names,
 *      descriptions, category and family labels
 * Missing keys fall back to English, so a partial translation still works.
 * Use "dir": "rtl" for Hebrew or Arabic; the layout mirrors itself.
 */
const I18N = (() => {
  const FALLBACK = 'en';
  let langs = [], lang = FALLBACK, ui = {}, uiFb = {}, content = {}, contentFb = {};

  const getJSON = async (url) => {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error(url + ' ' + r.status);
    return r.json();
  };
  const dig = (obj, key) => key.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);

  async function init(wanted) {
    langs = await getJSON('i18n/languages.json');
    const codes = langs.map((l) => l.code);
    const browser = (navigator.language || '').slice(0, 2);
    lang = codes.includes(wanted) ? wanted : codes.includes(browser) ? browser : FALLBACK;
    [uiFb, contentFb] = await Promise.all([getJSON(`i18n/${FALLBACK}.json`), getJSON(`data/content/${FALLBACK}.json`)]);
    if (lang === FALLBACK) { ui = uiFb; content = contentFb; }
    else {
      [ui, content] = await Promise.all([
        getJSON(`i18n/${lang}.json`).catch(() => ({})),
        getJSON(`data/content/${lang}.json`).catch(() => ({}))
      ]);
    }
    const info = langs.find((l) => l.code === lang) || {};
    document.documentElement.lang = lang;
    document.documentElement.dir = info.dir || 'ltr';
    return lang;
  }

  /** UI string; {name} placeholders are filled from vars. */
  function t(key, vars) {
    let s = dig(ui, key);
    if (s === undefined) s = dig(uiFb, key);
    if (s === undefined) return key;
    if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? vars[k] : ''));
    return s;
  }

  /** Plural helper: uses key.one / key.other. */
  function tn(key, n, vars) {
    const form = new Intl.PluralRules(lang).select(n);
    const k = dig(ui, `${key}.${form}`) !== undefined || dig(uiFb, `${key}.${form}`) !== undefined ? form : 'other';
    return t(`${key}.${k}`, Object.assign({ n: n.toLocaleString(lang) }, vars));
  }

  const item = (id) => {
    const a = (content.items || {})[id] || {}, b = (contentFb.items || {})[id] || {};
    return { name: a.name || b.name || '', description: a.description || b.description || '' };
  };
  const category = (code) => (content.categories || {})[code] || (contentFb.categories || {})[code] || '';
  const family = (code) => (content.families || {})[code] || (contentFb.families || {})[code] || '';

  /** Fill every element marked with data-i18n, data-i18n-placeholder, -title or -aria. */
  function apply(root = document) {
    root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
    root.querySelectorAll('[data-i18n-title]').forEach((el) => {
      el.title = t(el.dataset.i18nTitle); el.setAttribute('aria-label', el.title);
    });
    root.querySelectorAll('[data-i18n-aria]').forEach((el) => el.setAttribute('aria-label', t(el.dataset.i18nAria)));
    document.title = t('page.title');
  }

  /** Extra names and labels that arrive later (pinned places from the server). */
  function addContent(extra) {
    for (const k of ['items', 'categories', 'families']) {
      if (extra[k]) content[k] = Object.assign({}, content[k], extra[k]);
    }
  }

  return { init, t, tn, item, category, family, apply, addContent, get lang() { return lang; }, get languages() { return langs; } };
})();
