import { STATIC } from '/web/api.js';
// Translation in the browser: Chrome's built-in on-device Translator first (free, private, unlimited),
// then the server's free online service for the pairs Chrome can't do.
const cache = new Map();            // "src>tgt|text" -> translation
const chromeTranslators = new Map(); // "src>tgt" -> Translator | 'no' | 'needs-download'
export const state = { chromeAvailable: 'Translator' in self, needsDownload: new Set(), quotaHit: false, useChrome: true, email: '' };

const zhMap = code => (code === 'zh-TW' ? 'zh-Hant' : code);
/** Never wait forever on the browser's translator: give up after `ms` and fall back to the server. */
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

async function chromeFor(src, tgt) {
  if (!state.chromeAvailable || !state.useChrome) return null;
  const key = `${src}>${tgt}`;
  if (chromeTranslators.has(key)) { const v = chromeTranslators.get(key); return typeof v === 'string' ? null : v; }
  try {
    const opts = { sourceLanguage: zhMap(src), targetLanguage: zhMap(tgt) };
    const avail = await withTimeout(self.Translator.availability(opts), 3000);
    if (avail === 'unavailable') { chromeTranslators.set(key, 'no'); return null; }
    if (avail === 'available') {
      const tr = await withTimeout(self.Translator.create(opts), 6000);
      chromeTranslators.set(key, tr);
      return tr;
    }
    // downloadable / downloading: needs a user click first
    chromeTranslators.set(key, 'needs-download');
    state.needsDownload.add(key);
    return null;
  } catch (e) {
    chromeTranslators.set(key, 'no');
    return null;
  }
}

/** Called from a click: downloads the on-device model for every pair that asked for it. */
export async function enableChrome(onProgress) {
  for (const key of [...state.needsDownload]) {
    const [src, tgt] = key.split('>');
    try {
      const tr = await self.Translator.create({
        sourceLanguage: zhMap(src), targetLanguage: zhMap(tgt),
        monitor(m) { m.addEventListener('downloadprogress', e => onProgress && onProgress(e.loaded)); },
      });
      chromeTranslators.set(key, tr);
      state.needsDownload.delete(key);
    } catch (e) { chromeTranslators.set(key, 'no'); state.needsDownload.delete(key); }
  }
}

// ---- the free MyMemory service, called straight from the visitor's browser (public site): every visitor
// gets their own daily allowance instead of sharing one server's.
const MM_CODES = { zh: 'zh-CN', 'zh-TW': 'zh-TW', no: 'nb', tl: 'fil', pt: 'pt-PT' };
let mmBlockedUntil = 0;

function mmChunks(text, limit = 440) {
  const enc = new TextEncoder();
  if (enc.encode(text).length <= limit) return [text];
  const parts = []; let cur = '';
  for (const s of text.split(/(?<=[.!?。！？])\s+/)) {
    if (cur && enc.encode(cur + ' ' + s).length > limit) { parts.push(cur); cur = s; } else cur = (cur + ' ' + s).trim();
  }
  if (cur) parts.push(cur);
  return parts.flatMap(p => { const o = []; while (enc.encode(p).length > limit) { o.push(p.slice(0, 140)); p = p.slice(140); } o.push(p); return o; });
}

async function mmOne(text, src, tgt) {
  if (Date.now() < mmBlockedUntil) throw new Error('quota');
  const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) +
    '&langpair=' + encodeURIComponent((MM_CODES[src] || src) + '|' + (MM_CODES[tgt] || tgt)) + (state.email ? '&de=' + encodeURIComponent(state.email) : '');
  const d = await (await fetch(url)).json();
  let out = (d.responseData && d.responseData.translatedText) || '';
  // prefer a match for the WHOLE text (or its machine translation) over stored fragments
  const want = text.trim().toLowerCase();
  const cands = (d.matches || []).filter(m => (m.translation || '').trim() && m.translation.trim().toLowerCase() !== want);
  const pick = cands.find(m => (m.segment || '').trim().toLowerCase() === want) ||
    cands.find(m => /machine/i.test(String(m.reference || '')) && (m.segment || '').length >= 0.8 * text.length);
  if (pick) out = pick.translation.trim();
  if (d.quotaFinished || /MYMEMORY WARNING/i.test(out) || String(d.responseStatus) === '429') { mmBlockedUntil = Date.now() + 3600e3; throw new Error('quota'); }
  if (String(d.responseStatus) !== '200' || !out) throw new Error('bad');
  return out;
}

async function viaMyMemory(items, source, target) {
  const out = {}; let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const it = items[i++];
      try { out[it.id] = (await Promise.all(mmChunks(it.text).map(c => mmOne(c, source, target)))).join(' '); }
      catch (e) { if (e.message === 'quota') { state.quotaHit = true; return; } }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return out;
}

async function viaServer(items, source, target) {
  if (STATIC) return viaMyMemory(items, source, target);
  const out = {};
  for (let i = 0; i < items.length; i += 30) {
    const batch = items.slice(i, i + 30);
    try {
      const r = await fetch('/api/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source, target, items: batch, email: state.email }) });
      const j = await r.json();
      Object.assign(out, j.results || {});
      if (j.error === 'quota') { state.quotaHit = true; break; }
    } catch (e) { break; }
  }
  return out;
}

/** items: [{id, text}] in `source`. Returns {id: translated} for those that could be translated. */
export async function translateBatch(items, { source, target }) {
  const out = {};
  if (!items.length || source === target) return out;
  const todo = [];
  for (const it of items) {
    const k = `${source}>${target}|${it.text}`;
    if (cache.has(k)) out[it.id] = cache.get(k); else todo.push(it);
  }
  if (!todo.length) return out;
  // 1) Chrome on-device (also try pivoting through English for pairs it doesn't offer directly)
  let rest = todo;
  const direct = await chromeFor(source, target);
  if (direct) {
    rest = [];
    for (const it of todo) {
      try { const r = await withTimeout(direct.translate(it.text), 8000); out[it.id] = r; cache.set(`${source}>${target}|${it.text}`, r); }
      catch (e) { rest.push(it); chromeTranslators.set(`${source}>${target}`, 'no'); }
    }
  } else if (source !== 'en' && target !== 'en' && state.chromeAvailable && state.useChrome) {
    const a = await chromeFor(source, 'en'), b = await chromeFor('en', target);
    if (a && b) {
      rest = [];
      for (const it of todo) {
        try { const r = await withTimeout(b.translate(await a.translate(it.text)), 10000); out[it.id] = r; cache.set(`${source}>${target}|${it.text}`, r); }
        catch (e) { rest.push(it); }
      }
    }
  }
  // 2) the free online service
  if (rest.length) {
    const got = await viaServer(rest, source, target);
    for (const it of rest) if (got[it.id]) { out[it.id] = got[it.id]; cache.set(`${source}>${target}|${it.text}`, got[it.id]); }
  }
  return out;
}
