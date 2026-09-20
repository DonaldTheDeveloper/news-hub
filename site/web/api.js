// Data access for News Hub. Two modes:
//  * local  - the Python server answers /api/... (config.js sets nothing)
//  * static - a public site (Netlify): everything is loaded from one news.json file and filtered here in
//             the browser. config.js sets NEWSHUB.dataUrl (and optionally fallbackUrl).
const CFG = window.NEWSHUB || {};
export const STATIC = !!CFG.dataUrl;

let cache = null, loadedAt = 0;

export async function loadStatic(force = false) {
  if (cache && !force && Date.now() - loadedAt < 4 * 60 * 1000) return cache;
  const urls = [CFG.dataUrl, CFG.fallbackUrl].filter(Boolean);
  for (const u of urls) {
    try {
      const bust = Math.floor(Date.now() / 300000);               // new URL every 5 minutes -> never a stale CDN copy
      const r = await fetch(u + (u.includes('?') ? '&' : '?') + 't=' + bust);
      if (!r.ok) continue;
      const j = await r.json();
      if (j.items && j.meta) {
        j.catalog = Object.fromEntries(j.meta.sources.map(s => [s.id, s]));
        cache = j; loadedAt = Date.now();
        return j;
      }
    } catch (e) { /* try the next URL */ }
  }
  if (cache) return cache;
  throw new Error('The news data is not available right now.');
}

/** Same filtering / scoring as the Python server (store.py), so both modes behave identically. */
export function runQuery(data, p) {
  const now = Date.now() / 1000;
  const hours = Number(p.hours || 48);
  const tw = p.topic_weights || {};
  const allowedTopics = new Set(p.topics || []);
  const countries = new Set(p.countries || []);
  const continents = new Set(p.continents || []);
  const srcOff = new Set(p.sources_off || []);
  const langs = new Set(p.langs || []);
  const boost = (p.boost || []).filter(Boolean).map(s => s.toLowerCase());
  const mute = (p.mute || []).filter(Boolean).map(s => s.toLowerCase());
  const q = (p.q || '').trim().toLowerCase();
  const scope = p.scope || 'both';
  const cinfo = data.meta.countries;
  const heat = {}, results = [];

  for (const it of data.items) {
    const ageH = (now - it.published) / 3600;
    if (ageH > hours || srcOff.has(it.source)) continue;
    const src = data.catalog[it.source];
    if (!src) continue;
    if (langs.size && !langs.has(it.lang)) continue;
    if (p.only_public && src.note !== 'public') continue;
    if (p.no_public && src.note === 'public') continue;
    const topics = it.topics;
    const weights = topics.map(t => (t in tw ? tw[t] : 1));
    if (allowedTopics.size && !topics.some(t => allowedTopics.has(t))) continue;
    if (weights.length && Math.max(...weights) <= 0) continue;
    const hay = (it.title + ' ' + it.summary).toLowerCase();
    if (mute.length && mute.some(m => hay.includes(m))) continue;
    if (q && !hay.includes(q)) continue;
    const geo = new Set(scope === 'both' || scope === 'mentioned' ? it.countries : []);
    if ((scope === 'both' || scope === 'origin') && it.origin) geo.add(it.origin);
    for (const c of (it.countries.length ? it.countries : [it.origin])) if (c) heat[c] = (heat[c] || 0) + 1;
    if (countries.size && ![...geo].some(c => countries.has(c))) continue;
    if (continents.size && ![...geo].some(c => cinfo[c] && continents.has(cinfo[c].continent))) continue;
    let score = Math.exp(-ageH / 20);
    score *= 1 + 0.35 * Math.min((it.group_size || 1) - 1, 4);
    score *= weights.length ? Math.max(...weights) : 1;
    score *= 1 + 0.5 * Math.min(boost.filter(b => hay.includes(b)).length, 2);
    results.push([score, it]);
  }
  results.sort((a, b) => b[0] - a[0]);
  if (p.sort === 'new') results.sort((a, b) => b[1].published - a[1].published);

  // one card per story
  const shown = new Set(), collapsed = [];
  for (const [score, it] of results) {
    if (it.group != null && (it.group_size || 1) > 1) { if (shown.has(it.group)) continue; shown.add(it.group); }
    collapsed.push([score, it]);
  }
  // diversity: one source shouldn't fill the page
  const limit = Number(p.limit || 120), cap = Math.max(6, Math.floor(limit / 6)), perSrc = {}, out = [], rest = [];
  for (const [score, it] of collapsed) {
    const n = perSrc[it.source] || 0;
    if (n < cap) { perSrc[it.source] = n + 1; out.push([score, it]); } else rest.push([score, it]);
  }
  const final = out.concat(rest).slice(0, limit);
  const items = final.map(([score, it]) => {
    const src = data.catalog[it.source];
    const also = (it.group_sources || []).filter(s => s !== it.source && data.catalog[s]).map(s => data.catalog[s].name);
    return { id: it.id, title: it.title, summary: it.summary, link: it.link, image: it.image, published: it.published, lang: it.lang,
      topics: it.topics, countries: it.countries, origin: it.origin,
      source: { id: src.id, name: src.name, lang: src.lang, country: src.country, note: src.note },
      also: also.slice(0, 5), score: Math.round(score * 1000) / 1000 };
  });
  return { items, heat, total: results.length, updated: data.updated, refreshing: false };
}
