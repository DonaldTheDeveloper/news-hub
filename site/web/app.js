import { NewsScene, TOPIC_COLORS } from '/web/globe.js';
import { t, setUiLang, applyI18n, EN } from '/web/i18n.js';
import * as TR from '/web/translator.js';
import { STATIC, loadStatic, runQuery } from '/web/api.js';

const $ = s => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  kids.flat().forEach(c => e.append(c && c.nodeType ? c : document.createTextNode(c ?? '')));
  return e;
};

const DEFAULTS = {
  lang: 'en', autoTranslate: true, useChrome: true, email: '', topicW: {}, countries: [], continents: [], scope: 'both',
  langs: [], off: [], boost: [], mute: [], hours: 48, limit: 120, sort: 'top', onlyPublic: false, noPublic: false,
  autoRotate: true, labels: true, mode: 'globe',
};
const WEIGHTS = [['topic_hide', 0], ['topic_less', 0.5], ['topic_normal', 1], ['topic_more', 2]];

const state = { meta: null, prefs: { ...DEFAULTS }, items: [], heat: {}, focus: [], q: '', tr: {}, showOrig: new Set(), total: 0, updated: 0, loading: false };
let scene = null, langInfo = {};

// ---------------------------------------------------------------- helpers
const flag = iso => (iso && iso.length === 2 && !'XC XK XS'.includes(iso)) ? String.fromCodePoint(...[...iso.toUpperCase()].map(c => 127397 + c.charCodeAt(0))) : '🌐';
const langName = c => (langInfo[c] ? langInfo[c].native : c);
const cname = iso => (state.meta.countries[iso] ? state.meta.countries[iso].name : iso);
function ago(ts) {
  const m = Math.max(1, Math.round((Date.now() / 1000 - ts) / 60));
  try {
    const rtf = new Intl.RelativeTimeFormat(state.prefs.lang, { numeric: 'auto', style: 'short' });
    return m < 60 ? rtf.format(-m, 'minute') : m < 1440 ? rtf.format(-Math.round(m / 60), 'hour') : rtf.format(-Math.round(m / 1440), 'day');
  } catch (e) { return m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`; }
}
let toastTimer;
function toast(msg, ms = 5000) { const t_ = $('#toast'); t_.textContent = msg; t_.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t_.classList.remove('show'), ms); }
const debounce = (fn, ms) => { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; };

// ---------------------------------------------------------------- preferences
async function loadPrefs() {
  let local = {}, remote = {};
  try { local = JSON.parse(localStorage.getItem('newshub.prefs') || '{}'); } catch (e) { /* ignore */ }
  if (!STATIC) { try { remote = await (await fetch('/api/prefs')).json(); } catch (e) { /* ignore */ } }
  const nav = (navigator.language || 'en').split('-')[0];
  const guess = state.meta.languages.find(l => l.code === nav) ? nav : 'en';
  state.prefs = { ...DEFAULTS, lang: guess, ...local, ...remote };
}
const persist = debounce(() => {
  try { localStorage.setItem('newshub.prefs', JSON.stringify(state.prefs)); } catch (e) { /* ignore */ }
  if (!STATIC) fetch('/api/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state.prefs) }).catch(() => {});
}, 500);
function changed(reload = true) {
  persist();
  TR.state.useChrome = state.prefs.useChrome;
  TR.state.email = state.prefs.email;
  if (scene) { scene.autoRotate = state.prefs.autoRotate; scene.showLabels = state.prefs.labels; $('#labels').style.display = state.prefs.mode === 'globe' && state.prefs.labels ? '' : 'none'; }
  if (reload) loadNewsSoon();
}

// ---------------------------------------------------------------- news
function buildQuery() {
  const p = state.prefs, q = new URLSearchParams();
  const tw = Object.entries(p.topicW).filter(([, w]) => w !== 1).map(([k, w]) => `${k}:${w}`).join(',');
  if (tw) q.set('tw', tw);
  const countries = state.focus.length ? state.focus : p.countries;
  if (countries.length) q.set('countries', countries.join(','));
  if (p.continents.length && !state.focus.length) q.set('continents', p.continents.map(c => c.replace(/ /g, '_')).join(','));
  if (p.langs.length) q.set('langs', p.langs.join(','));
  if (p.off.length) q.set('off', p.off.join(','));
  if (p.boost.length) q.set('boost', p.boost.join(','));
  if (p.mute.length) q.set('mute', p.mute.join(','));
  if (state.q) q.set('q', state.q);
  q.set('scope', p.scope); q.set('hours', p.hours); q.set('limit', p.limit); q.set('sort', p.sort);
  if (p.onlyPublic) q.set('only_public', '1');
  if (p.noPublic) q.set('no_public', '1');
  return q.toString();
}
/** The same preferences as an object (used by the in-browser query engine on the public site). */
function buildParams() {
  const p = state.prefs, topic_weights = {};
  for (const [k, w] of Object.entries(p.topicW)) if (w !== 1) topic_weights[k] = w;
  return { hours: p.hours, topics: [], topic_weights, countries: state.focus.length ? state.focus : p.countries,
    continents: state.focus.length ? [] : p.continents, sources_off: p.off, langs: p.langs, boost: p.boost, mute: p.mute,
    q: state.q, scope: p.scope, only_public: p.onlyPublic, no_public: p.noPublic, sort: p.sort, limit: p.limit };
}
const loadNewsSoon = debounce(() => loadNews(), 250);

async function loadNews() {
  state.loading = true;
  if (!state.items.length) $('#list').replaceChildren(...Array.from({ length: 6 }, () => el('div', { class: 'skeleton' })));
  let data;
  try { data = STATIC ? runQuery(await loadStatic(), buildParams()) : await (await fetch('/api/news?' + buildQuery())).json(); }
  catch (e) { toast('Could not reach the News Hub server.'); state.loading = false; return; }
  state.items = data.items; state.heat = data.heat; state.total = data.total; state.updated = data.updated;
  state.loading = false;
  // dominant topic per country for pin colours
  const counts = {};
  for (const it of state.items) for (const c of (it.countries.length ? it.countries : [it.origin])) {
    if (!c) continue;
    const m = (counts[c] = counts[c] || {}); const tp = it.topics.find(x => x !== 'world') || it.topics[0]; m[tp] = (m[tp] || 0) + 1;
  }
  const topicOf = {}; for (const [c, m] of Object.entries(counts)) topicOf[c] = Object.entries(m).sort((a, b) => b[1] - a[1])[0][0];
  if (scene) { scene.setHeat(state.heat, topicOf); scene.setItems(state.items, titleFor); }
  renderChips(); renderStat(); renderList();
  translateVisible();
}

const titleFor = it => (state.tr[it.id] && state.tr[it.id].title && !state.showOrig.has(it.id) ? state.tr[it.id].title : it.title);
const needsTr = it => state.prefs.autoTranslate && it.lang !== state.prefs.lang && !(it.lang === 'zh' && state.prefs.lang === 'zh-TW');

async function translateVisible() {
  if (!needsTr({ lang: '__' })) return;                    // auto-translate off
  const target = state.prefs.lang;
  const bySrc = {};
  for (const it of state.items.slice(0, 48)) {
    if (!needsTr(it) || (state.tr[it.id] && state.tr[it.id].title)) continue;
    (bySrc[it.lang] = bySrc[it.lang] || []).push(it);
  }
  const srcs = Object.keys(bySrc);
  if (!srcs.length) return;
  for (const src of srcs) {
    const res = await TR.translateBatch(bySrc[src].map(it => ({ id: it.id, text: it.title })), { source: src, target });
    for (const [id, text] of Object.entries(res)) (state.tr[id] = state.tr[id] || {}).title = text;
    if (target !== state.prefs.lang) return;               // language changed meanwhile
    renderList(true); if (scene) scene.refreshCards();
  }
  $('#chromeBanner').hidden = TR.state.needsDownload.size === 0;
  if (TR.state.quotaHit) { toast(t('quota_msg'), 9000); TR.state.quotaHit = false; }
}

// ---------------------------------------------------------------- rendering
function renderStat() {
  const d = state.updated ? new Date(state.updated * 1000).toLocaleTimeString(state.prefs.lang, { hour: '2-digit', minute: '2-digit' }) : '…';
  $('#statLine').textContent = `${state.total.toLocaleString(state.prefs.lang)} ${t('story_count')} · ${t('updated')} ${d}`;
}
function renderChips() {
  const chips = [];
  for (const c of state.focus) chips.push(chip(`${flag(c)} ${cname(c)}`, () => setFocus(state.focus.filter(x => x !== c))));
  if (state.q) chips.push(chip(`🔎 ${state.q}`, () => { $('#q').value = ''; state.q = ''; loadNews(); }));
  $('#chips').replaceChildren(...chips);
}
const chip = (text, onx) => el('span', { class: 'chip' }, text, el('button', { onclick: onx, title: t('clear_filters') }, '✕'));

function card(it) {
  const c = TOPIC_COLORS[it.topics.find(x => x !== 'world') || 'world'] || '#6ea2ff';
  const tr = state.tr[it.id], showing = tr && tr.title && !state.showOrig.has(it.id);
  const geo = (it.countries.length ? it.countries : [it.origin]).filter(Boolean).slice(0, 3);
  const head = el('h3', { text: titleFor(it), onclick: () => openStory(it) });
  if (['ar', 'he', 'fa', 'ur', 'ps'].includes(showing ? state.prefs.lang : it.lang)) head.dir = 'rtl';
  const thumb = it.image ? el('img', { class: 'thumb', src: it.image, loading: 'lazy', referrerpolicy: 'no-referrer', onerror: e => e.target.remove() }) : null;
  const acts = el('div', { class: 'actions' },
    el('a', { class: 'primary', href: it.link, target: '_blank', rel: 'noopener noreferrer' }, t('read_original') + ' ↗'),
    geo.length ? el('button', { onclick: () => { setMode('globe'); setFocus([geo[0]]); } }, `🌍 ${t('on_globe')}`) : null,
    tr && tr.title ? el('button', { onclick: () => { state.showOrig.has(it.id) ? state.showOrig.delete(it.id) : state.showOrig.add(it.id); renderList(true); if (scene) scene.refreshCards(); } },
      showing ? t('show_original') : t('show_translated')) : null);
  return el('div', { class: 'card', style: `--tc:${c}`, 'data-id': it.id },
    el('div', { class: 'row' }, el('div', { style: 'flex:1;min-width:0' }, head,
      el('div', { class: 'meta' },
        el('span', { class: 'src', text: `${flag(it.source.country)} ${it.source.name}` }),
        el('span', { text: ago(it.published) }),
        ...it.topics.slice(0, 2).map(tp => el('span', { class: 'tag', text: t('topic_' + tp) })),
        ...geo.map(g => el('span', { class: 'tag', title: cname(g), text: flag(g) })),
        it.source.note === 'public' ? el('span', { class: 'tag', title: t('public_funded'), text: '🏛' }) : null)), thumb),
    showing ? el('div', { class: 'tr', text: `🌐 ${t('translated_from')} ${langName(it.lang)}` }) : null,
    it.also.length ? el('div', { class: 'also', text: `${t('also_covered')}: ${it.also.slice(0, 3).join(', ')}${it.also.length > 3 ? ' +' + (it.also.length - 3) : ''}` }) : null,
    acts);
}

function renderList(keepScroll) {
  const list = $('#list'), top = list.scrollTop;
  if (!state.items.length) { list.replaceChildren(el('div', { class: 'empty', text: t('no_results') })); return; }
  list.replaceChildren(...state.items.map(card));
  if (keepScroll) list.scrollTop = top;
}

// ---------------------------------------------------------------- story viewer
async function openStory(it) {
  const m = $('#modal'), c = $('#modalCard');
  const tr = state.tr[it.id] || (state.tr[it.id] = {});
  const rtl = ['ar', 'he', 'fa', 'ur', 'ps'].includes(state.prefs.lang);
  const build = () => {
    const translated = it.lang !== state.prefs.lang;
    c.replaceChildren(
      el('div', { class: 'meta' }, el('span', { class: 'src', text: `${flag(it.source.country)} ${it.source.name}` }), el('span', { text: ago(it.published) }),
        ...it.topics.map(tp => el('span', { class: 'tag', text: t('topic_' + tp) }))),
      el('h2', { text: translated && tr.title ? tr.title : it.title, dir: rtl && translated && tr.title ? 'rtl' : null }),
      translated && tr.title ? el('div', { class: 'tr', text: `🌐 ${t('translated_from')} ${langName(it.lang)} — ${it.title}` }) : null,
      it.image ? el('img', { src: it.image, referrerpolicy: 'no-referrer', style: 'width:100%;border-radius:12px;margin:10px 0;max-height:280px;object-fit:cover', onerror: e => e.target.remove() }) : null,
      it.summary ? el('p', { class: 'sum', text: translated && tr.summary ? tr.summary : it.summary, dir: rtl && translated && tr.summary ? 'rtl' : null }) : null,
      it.also.length ? el('div', { class: 'also', text: `${t('also_covered')}: ${it.also.join(', ')}` }) : null,
      el('div', { class: 'actions', style: 'margin-top:14px' },
        el('a', { class: 'primary', href: it.link, target: '_blank', rel: 'noopener noreferrer', style: 'padding:8px 16px;font-size:14px' }, t('read_original') + ' ↗'),
        el('button', { onclick: closeStory, style: 'padding:8px 16px;font-size:14px' }, t('close'))));
  };
  build(); m.hidden = false;
  if (it.lang !== state.prefs.lang && (!tr.title || (it.summary && !tr.summary))) {
    const items = [];
    if (!tr.title) items.push({ id: 't', text: it.title });
    if (it.summary && !tr.summary) items.push({ id: 's', text: it.summary });
    const res = await TR.translateBatch(items, { source: it.lang, target: state.prefs.lang });
    if (res.t) tr.title = res.t; if (res.s) tr.summary = res.s;
    if (!m.hidden) build();
    renderList(true);
  }
}
function closeStory() { $('#modal').hidden = true; }

// ---------------------------------------------------------------- focus, mode, language
function setFocus(list) {
  state.focus = list;
  if (scene) scene.setSelected(list);
  $('#list').scrollTop = 0;
  loadNews();
}
function setMode(m) {
  state.prefs.mode = m;
  document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
  if (scene) scene.setMode(m);
  $('#hint').textContent = t(m === 'globe' ? 'hint_globe' : 'hint_wall');
  changed(false);
}

async function setLanguage(code) {
  const info = langInfo[code];
  state.prefs.lang = code; state.tr = {}; state.showOrig.clear();
  $('#langName').textContent = info.native;
  $('#langPop').hidden = true;
  toast(`${t('translating')} (${info.native})`, 2500);
  await setUiLang(code, (items, o) => TR.translateBatch(items, o), info.rtl);
  $('#hint').textContent = t(state.prefs.mode === 'globe' ? 'hint_globe' : 'hint_wall');
  buildPrefs(); renderChips(); renderStat(); renderList();
  changed(false);
  translateVisible();
  if (TR.state.quotaHit) { toast(t('quota_msg'), 9000); TR.state.quotaHit = false; }
}

function buildLangPop() {
  const list = $('#langList'), q = $('#langSearch').value.trim().toLowerCase();
  list.replaceChildren(...state.meta.languages.filter(l => !q || l.name.toLowerCase().includes(q) || l.native.toLowerCase().includes(q) || l.code === q)
    .map(l => el('button', { class: l.code === state.prefs.lang ? 'on' : '', onclick: () => setLanguage(l.code) }, l.native, el('small', { text: l.name }))));
}

// ---------------------------------------------------------------- preferences drawer
function tagInput(listKey, cls, placeholder) {
  const box = el('div'), tags = el('div', { class: 'tags' });
  const draw = () => tags.replaceChildren(...state.prefs[listKey].map(w => el('span', { class: 'tg ' + cls }, w, el('button', { onclick: () => { state.prefs[listKey] = state.prefs[listKey].filter(x => x !== w); draw(); changed(); } }, '✕'))));
  const input = el('input', { class: 'field', placeholder, onkeydown: e => {
    if (e.key === 'Enter' && input.value.trim()) { const v = input.value.trim().toLowerCase(); if (!state.prefs[listKey].includes(v)) state.prefs[listKey].push(v); input.value = ''; draw(); changed(); }
  } });
  draw(); box.append(input, tags); return box;
}

function buildPrefs() {
  const p = state.prefs, body = $('#prefBody'), M = state.meta;
  const sec = (title, ...kids) => el('div', { class: 'sec' }, el('h4', { text: title }), ...kids);
  const check = (label, key, extra) => { const c = el('input', { type: 'checkbox', checked: !!p[key], onchange: e => { p[key] = e.target.checked; extra && extra(); changed(key === 'autoRotate' || key === 'labels' || key === 'useChrome' ? false : true); } }); return el('label', { class: 'ck' }, c, label); };

  // topics
  const topics = sec(t('topics'), ...M.topics.map(tp => el('div', { class: 'trow' },
    el('span', { class: 'nm' }, el('span', { class: 'dot', style: `background:${TOPIC_COLORS[tp]}` }), t('topic_' + tp)),
    el('div', { class: 'w4' }, ...WEIGHTS.map(([lab, w]) => el('button', { class: `${(p.topicW[tp] ?? 1) === w ? 'on' : ''} ${w === 0 ? 'hide' : ''}`, onclick: () => { p.topicW[tp] = w; buildPrefs(); changed(); } }, t(lab)))))));

  // regions
  const conts = ['Africa', 'Asia', 'Europe', 'North America', 'South America', 'Oceania'];
  const contRow = el('div', { class: 'tags' }, ...conts.map(c => el('button', { class: 'pill' + (p.continents.includes(c) ? ' on' : ''), onclick: () => { p.continents = p.continents.includes(c) ? p.continents.filter(x => x !== c) : [...p.continents, c]; buildPrefs(); changed(); } }, t('continent_' + c))));
  const sug = el('div', { class: 'suggest', hidden: true });
  const cin = el('input', { class: 'field', placeholder: t('countries_pick'), oninput: () => {
    const q = cin.value.trim().toLowerCase();
    if (!q) { sug.hidden = true; return; }
    const hits = Object.entries(M.countries).filter(([iso, c]) => c.name.toLowerCase().includes(q)).slice(0, 8);
    sug.replaceChildren(...hits.map(([iso, c]) => el('div', { onclick: () => { if (!p.countries.includes(iso)) p.countries.push(iso); cin.value = ''; sug.hidden = true; buildPrefs(); changed(); } }, `${flag(iso)} ${c.name}`)));
    sug.hidden = !hits.length;
  } });
  const ctags = el('div', { class: 'tags' }, ...p.countries.map(iso => el('span', { class: 'tg' }, `${flag(iso)} ${cname(iso)}`, el('button', { onclick: () => { p.countries = p.countries.filter(x => x !== iso); buildPrefs(); changed(); } }, '✕'))));
  const scope = el('select', { class: 'field', onchange: e => { p.scope = e.target.value; changed(); } },
    ...['both', 'mentioned', 'origin'].map(v => el('option', { value: v, selected: p.scope === v }, t('scope_' + v))));
  const regions = sec(t('regions'), el('span', { class: 'lbl', text: t('continents') }), contRow, cin, sug, ctags, el('span', { class: 'lbl', text: t('scope') }), scope);

  // sources
  const byLang = {};
  for (const s of M.sources) (byLang[s.lang] = byLang[s.lang] || []).push(s);
  const langChips = el('div', { class: 'tags' }, ...Object.keys(byLang).sort((a, b) => byLang[b].length - byLang[a].length).map(l =>
    el('button', { class: 'pill' + (p.langs.includes(l) ? ' on' : ''), title: `${byLang[l].length}`, onclick: () => { p.langs = p.langs.includes(l) ? p.langs.filter(x => x !== l) : [...p.langs, l]; buildPrefs(); changed(); } }, langName(l))));
  const groups = Object.keys(byLang).sort((a, b) => byLang[b].length - byLang[a].length).map(l =>
    el('details', { class: 'srcgrp' }, el('summary', { text: `${langName(l)} · ${byLang[l].length}` }),
      ...byLang[l].map(s => el('label', { class: s.ok === false ? 'bad' : '' },
        el('input', { type: 'checkbox', checked: !p.off.includes(s.id), onchange: e => { p.off = e.target.checked ? p.off.filter(x => x !== s.id) : [...p.off, s.id]; changed(); } }),
        `${flag(s.country)} ${s.name}${s.note === 'public' ? ' 🏛' : ''}${s.ok === false ? ' ⚠' : ''}`))));
  const srcs = sec(t('sources'), el('span', { class: 'lbl', text: t('source_langs') }), langChips,
    el('div', { class: 'tags' }, el('button', { class: 'pill', onclick: () => { p.off = []; buildPrefs(); changed(); } }, t('all')), el('button', { class: 'pill', onclick: () => { p.off = M.sources.map(s => s.id); buildPrefs(); changed(); } }, t('none'))),
    ...groups, check(t('public_only'), 'onlyPublic', buildPrefs), check(t('no_public'), 'noPublic', buildPrefs));

  // keywords, time, sort
  const kw = sec(t('keywords'), el('span', { class: 'lbl', text: t('boost_kw') }), tagInput('boost', 'boost', '+ keyword'), el('span', { class: 'lbl', text: t('mute_kw') }), tagInput('mute', 'mute', '− keyword'));
  const sel = (key, opts, num) => el('select', { class: 'field', onchange: e => { p[key] = num ? Number(e.target.value) : e.target.value; changed(); } }, ...opts.map(([v, lab]) => el('option', { value: v, selected: String(p[key]) === String(v) }, lab)));
  const view = sec(t('time_window'), el('div', { class: 'two' },
    el('div', {}, sel('hours', [[6, t('hours_6')], [24, t('hours_24')], [48, t('hours_48')], [168, t('hours_168')]], true)),
    el('div', {}, sel('sort', [['top', t('sort_top')], ['new', t('sort_new')]]))),
    el('span', { class: 'lbl', text: t('count') }), sel('limit', [[60, '60'], [120, '120'], [200, '200']], true));

  // translation + display
  const email = el('input', { class: 'field', type: 'email', placeholder: t('email_hint'), value: p.email, onchange: e => { p.email = e.target.value.trim(); changed(false); } });
  const trn = sec(t('translation'), el('button', { class: 'pill', onclick: () => { $('#langPop').hidden = false; $('#langSearch').focus(); } }, `🌐 ${langName(p.lang)}`),
    check(t('auto_translate'), 'autoTranslate', () => { state.tr = {}; translateVisible(); }),
    TR.state.chromeAvailable ? check(t('use_chrome'), 'useChrome') : null, email);
  const disp = sec(t('display'), check(t('auto_rotate'), 'autoRotate'), check(t('pin_labels'), 'labels'));
  body.replaceChildren(topics, regions, srcs, kw, view, trn, disp);
}

// ---------------------------------------------------------------- boot
async function boot() {
  state.meta = STATIC ? (await loadStatic()).meta : await (await fetch('/api/meta')).json();
  langInfo = Object.fromEntries(state.meta.languages.map(l => [l.code, l]));
  await loadPrefs();
  TR.state.useChrome = state.prefs.useChrome; TR.state.email = state.prefs.email;
  const world = await (await fetch('/vendor/world.geojson')).json();
  try {
    scene = new NewsScene($('#stage'), world, state.meta.countries);
  } catch (e) {
    $('#stage').replaceChildren(el('div', { class: 'empty', style: 'padding-top:30vh', text: '3D graphics (WebGL) are not available in this browser: ' + e.message }));
  }
  if (scene) {
    scene.autoRotate = state.prefs.autoRotate; scene.showLabels = state.prefs.labels;
    const fit = () => {
      const phone = window.innerWidth <= 900;
      scene.setInset(phone ? 0 : $('#feed').offsetWidth + 12, phone ? $('#feed').offsetHeight + 8 : 0);
    };
    window.__fitScene = fit;
    fit(); window.addEventListener('resize', fit);
    // on phones the news list is a bottom sheet: tap its header to fold / unfold it
    $('#feedHead').addEventListener('click', e => {
      if (window.innerWidth > 900 || e.target.closest('button')) return;
      $('#feed').classList.toggle('folded'); setTimeout(fit, 260);
    });
    scene.on('country-click', iso => setFocus(state.focus.length === 1 && state.focus[0] === iso ? [] : [iso]));
    scene.on('card-click', it => openStory(it));
    const tip = $('#tooltip');
    scene.on('hover', (iso, name) => {
      if (!iso) { tip.style.display = 'none'; return; }
      const n = state.heat[iso] || 0;
      tip.textContent = `${flag(iso)} ${cname(iso) || name} — ${n} ${t('stories')}`; tip.style.display = 'block';
    });
    scene.on('card-hover', it => {
      const tip2 = $('#tooltip');
      if (!it) { tip2.style.display = 'none'; return; }
      tip2.textContent = titleFor(it); tip2.style.display = 'block';
    });
    document.addEventListener('pointermove', e => { const tip3 = $('#tooltip'); tip3.style.left = e.clientX + 14 + 'px'; tip3.style.top = e.clientY + 14 + 'px'; });
  }
  // language + ui strings
  const info = langInfo[state.prefs.lang] || langInfo.en;
  $('#langName').textContent = info.native;
  applyI18n();
  if (state.prefs.lang !== 'en') setUiLang(state.prefs.lang, (items, o) => TR.translateBatch(items, o), info.rtl).then(() => { buildPrefs(); renderList(true); renderStat(); });
  else document.documentElement.dir = 'ltr';
  document.querySelectorAll('#modeSeg button').forEach(b => b.onclick = () => setMode(b.dataset.mode));
  setMode(state.prefs.mode);
  buildPrefs();
  $('#prefBtn').onclick = () => { $('#prefs').classList.toggle('open'); };
  $('#prefClose').onclick = () => $('#prefs').classList.remove('open');
  $('#langBtn').onclick = () => { const p = $('#langPop'); p.hidden = !p.hidden; if (!p.hidden) { buildLangPop(); $('#langSearch').focus(); } };
  $('#langSearch').oninput = buildLangPop;
  $('#q').oninput = debounce(e => { state.q = e.target.value.trim(); loadNews(); }, 350);
  $('#refreshBtn').onclick = async () => {
    if (STATIC) { try { await loadStatic(true); } catch (e) { toast(e.message); } loadNews(); return; }
    await fetch('/api/refresh', { method: 'POST', body: '{}' }); toast('Refreshing…', 3000); setTimeout(loadNews, 7000);
  };
  $('#chromeBtn').onclick = async () => { $('#chromeBtn').textContent = '…'; await TR.enableChrome(); $('#chromeBanner').hidden = true; state.tr = {}; translateVisible(); };
  $('#prefReset').onclick = () => { const keep = state.prefs.lang; state.prefs = { ...DEFAULTS, lang: keep }; buildPrefs(); changed(); };
  $('#prefExport').onclick = () => { const a = el('a', { href: URL.createObjectURL(new Blob([JSON.stringify(state.prefs, null, 2)], { type: 'application/json' })), download: 'newshub-preferences.json' }); a.click(); };
  $('#prefImport').onclick = () => { const f = el('input', { type: 'file', accept: '.json', onchange: async e => { try { state.prefs = { ...DEFAULTS, ...JSON.parse(await e.target.files[0].text()) }; buildPrefs(); changed(); } catch (err) { toast('That file is not a valid preferences file.'); } } }); f.click(); };
  $('#modal').onclick = e => { if (e.target.id === 'modal') closeStory(); };
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeStory(); $('#prefs').classList.remove('open'); $('#langPop').hidden = true; } });
  document.addEventListener('click', e => { if (!$('#langPop').hidden && !e.target.closest('#langPop') && !e.target.closest('#langBtn') && !e.target.closest('#prefs')) $('#langPop').hidden = true; });
  await loadNews();
  setInterval(async () => { if (STATIC) { try { await loadStatic(true); } catch (e) { /* keep showing what we have */ } } loadNews(); }, 5 * 60 * 1000);
  window.__newshub = { state, scene, translateVisible, renderList, TR };
}

boot().catch(e => { console.error(e); toast('Something went wrong: ' + e.message, 12000); });
