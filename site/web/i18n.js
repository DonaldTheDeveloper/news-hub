import { BUNDLED } from '/web/ui_bundled.js';
// Interface strings (English) + on-demand translation of the whole interface into any supported language.
export const EN = {
  search: 'Search the news…', globe: 'Globe', wall: 'Wall', preferences: 'Preferences', language: 'Language',
  refresh: 'Refresh', stories: 'stories', updated: 'Updated', loading: 'Loading the news…',
  no_results: 'Nothing matches your preferences right now. Try widening them.', read_original: 'Read the original',
  show_original: 'Show original', show_translated: 'Show translation', translated_from: 'Translated from',
  also_covered: 'Also covered by', on_globe: 'Show on globe', clear_filters: 'Clear filters', topics: 'Topics',
  topic_hide: 'Hide', topic_less: 'Less', topic_normal: 'Normal', topic_more: 'More',
  regions: 'Regions and countries', continents: 'Continents', countries_pick: 'Add a country…', scope: 'Match countries by',
  scope_both: 'Mentioned or from', scope_mentioned: 'Mentioned in the story', scope_origin: 'Published there',
  sources: 'Sources', source_langs: 'Languages of the sources', all: 'All', none: 'None', keywords: 'Keywords',
  boost_kw: 'Show more of (press Enter)', mute_kw: 'Hide stories containing', time_window: 'How recent',
  sort: 'Sort by', sort_top: 'Top stories', sort_new: 'Newest first', count: 'Stories to show',
  public_only: 'Only publicly funded broadcasters', no_public: 'Hide publicly funded broadcasters',
  translation: 'Translation', auto_translate: 'Translate headlines automatically', use_chrome: 'Use Chrome on-device translator when possible',
  email_hint: 'E-mail for a bigger free daily translation quota (optional)', display: 'Display', auto_rotate: 'Auto-rotate',
  pin_labels: 'Country labels on the globe', reset: 'Reset', export: 'Export', import: 'Import', close: 'Close',
  hours_6: 'Last 6 hours', hours_24: 'Last 24 hours', hours_48: 'Last 2 days', hours_168: 'Last week',
  topic_world: 'World', topic_politics: 'Politics', topic_business: 'Business', topic_tech: 'Technology',
  topic_science: 'Science', topic_health: 'Health', topic_sports: 'Sports', topic_entertainment: 'Entertainment',
  topic_environment: 'Environment', topic_culture: 'Culture', continent_Africa: 'Africa', continent_Asia: 'Asia',
  continent_Europe: 'Europe', 'continent_North America': 'North America', 'continent_South America': 'South America',
  continent_Oceania: 'Oceania', quota_msg: 'The free translation service reached its daily limit. Set an e-mail in Preferences, or use Chrome for unlimited on-device translation.',
  enable_chrome: 'Enable on-device translation', chrome_hint: 'Chrome can translate privately on your computer. It downloads a small language model once.',
  hint_globe: 'Drag to spin · scroll to zoom · click a country', hint_wall: 'Drag to look around · scroll to zoom · click a story',
  public_funded: 'Publicly funded', save_note: 'Preferences are saved automatically.', story_count: 'stories match',
  translating: 'Translating…', interface_lang: 'Interface language', minutes_ago: 'min', all_sources: 'all sources',
};

const KEY = 'newshub.ui.';
let dict = EN;

export function t(k) { return dict[k] || EN[k] || k; }

export function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
  root.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); });
}

/** Switch the interface language. translateBatch(items,{source,target}) -> {id: text}. */
export async function setUiLang(code, translateBatch, rtl) {
  document.documentElement.lang = code;
  document.documentElement.dir = rtl ? 'rtl' : 'ltr';
  if (code === 'en') { dict = EN; applyI18n(); return true; }
  if (BUNDLED[code]) { dict = { ...EN, ...BUNDLED[code] }; applyI18n(); return true; }     // hand-written: no service needed
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(KEY + code) || 'null'); } catch (e) { /* ignore */ }
  if (cached && Object.keys(cached).length >= Object.keys(EN).length - 3) { dict = { ...EN, ...cached }; applyI18n(); return true; }
  const items = Object.entries(EN).map(([id, text]) => ({ id, text }));
  const res = await translateBatch(items, { source: 'en', target: code });
  if (res && Object.keys(res).length > 10) {
    dict = { ...EN, ...res };
    try { localStorage.setItem(KEY + code, JSON.stringify(res)); } catch (e) { /* storage full */ }
    applyI18n();
    return true;
  }
  dict = EN; applyI18n();
  return false;
}
