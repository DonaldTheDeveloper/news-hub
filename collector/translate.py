"""Translation service (server side).

Backend: the free MyMemory web service (no account needed; ~5,000 characters/day without an
e-mail address, ~50,000 with one). Every translation is cached on disk so the same headline is
never sent twice. In the browser the page first tries Chrome's built-in on-device translator, and
only asks this service for the pairs that Chrome can't do.
"""
import os
import re
import json
import time
import threading
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE_FILE = os.path.join(HERE, "cache", "translations.json")
ENDPOINT = "https://api.mymemory.translated.net/get"
USER_AGENT = "NewsHub/1.0 (personal news reader)"

# code, English name, native name, right-to-left
LANGS = [
    ("en", "English", "English", 0), ("es", "Spanish", "Español", 0), ("fr", "French", "Français", 0),
    ("de", "German", "Deutsch", 0), ("pt", "Portuguese", "Português", 0), ("it", "Italian", "Italiano", 0),
    ("nl", "Dutch", "Nederlands", 0), ("sv", "Swedish", "Svenska", 0), ("no", "Norwegian", "Norsk", 0),
    ("da", "Danish", "Dansk", 0), ("fi", "Finnish", "Suomi", 0), ("pl", "Polish", "Polski", 0),
    ("cs", "Czech", "Čeština", 0), ("sk", "Slovak", "Slovenčina", 0), ("hu", "Hungarian", "Magyar", 0),
    ("ro", "Romanian", "Română", 0), ("bg", "Bulgarian", "Български", 0), ("el", "Greek", "Ελληνικά", 0),
    ("ru", "Russian", "Русский", 0), ("uk", "Ukrainian", "Українська", 0), ("be", "Belarusian", "Беларуская", 0),
    ("sr", "Serbian", "Српски", 0), ("hr", "Croatian", "Hrvatski", 0), ("sl", "Slovenian", "Slovenščina", 0),
    ("lt", "Lithuanian", "Lietuvių", 0), ("lv", "Latvian", "Latviešu", 0), ("et", "Estonian", "Eesti", 0),
    ("is", "Icelandic", "Íslenska", 0), ("ga", "Irish", "Gaeilge", 0), ("cy", "Welsh", "Cymraeg", 0),
    ("mt", "Maltese", "Malti", 0), ("sq", "Albanian", "Shqip", 0), ("mk", "Macedonian", "Македонски", 0),
    ("bs", "Bosnian", "Bosanski", 0), ("ca", "Catalan", "Català", 0), ("gl", "Galician", "Galego", 0),
    ("eu", "Basque", "Euskara", 0), ("tr", "Turkish", "Türkçe", 0), ("az", "Azerbaijani", "Azərbaycanca", 0),
    ("ka", "Georgian", "ქართული", 0), ("hy", "Armenian", "Հայերեն", 0), ("kk", "Kazakh", "Қазақша", 0),
    ("uz", "Uzbek", "Oʻzbekcha", 0), ("ky", "Kyrgyz", "Кыргызча", 0), ("tg", "Tajik", "Тоҷикӣ", 0),
    ("mn", "Mongolian", "Монгол", 0), ("ar", "Arabic", "العربية", 1), ("he", "Hebrew", "עברית", 1),
    ("fa", "Persian", "فارسی", 1), ("ur", "Urdu", "اردو", 1), ("ps", "Pashto", "پښتو", 1),
    ("ku", "Kurdish", "Kurdî", 0), ("hi", "Hindi", "हिन्दी", 0), ("bn", "Bengali", "বাংলা", 0),
    ("ta", "Tamil", "தமிழ்", 0), ("te", "Telugu", "తెలుగు", 0), ("mr", "Marathi", "मराठी", 0),
    ("gu", "Gujarati", "ગુજરાતી", 0), ("kn", "Kannada", "ಕನ್ನಡ", 0), ("ml", "Malayalam", "മലയാളം", 0),
    ("pa", "Punjabi", "ਪੰਜਾਬੀ", 0), ("ne", "Nepali", "नेपाली", 0), ("si", "Sinhala", "සිංහල", 0),
    ("th", "Thai", "ไทย", 0), ("vi", "Vietnamese", "Tiếng Việt", 0), ("id", "Indonesian", "Bahasa Indonesia", 0),
    ("ms", "Malay", "Bahasa Melayu", 0), ("tl", "Filipino", "Filipino", 0), ("my", "Burmese", "မြန်မာ", 0),
    ("km", "Khmer", "ខ្មែរ", 0), ("lo", "Lao", "ລາວ", 0), ("zh", "Chinese (Simplified)", "中文 (简体)", 0),
    ("zh-TW", "Chinese (Traditional)", "中文 (繁體)", 0), ("ja", "Japanese", "日本語", 0), ("ko", "Korean", "한국어", 0),
    ("sw", "Swahili", "Kiswahili", 0), ("am", "Amharic", "አማርኛ", 0), ("ha", "Hausa", "Hausa", 0),
    ("yo", "Yoruba", "Yorùbá", 0), ("ig", "Igbo", "Igbo", 0), ("zu", "Zulu", "isiZulu", 0),
    ("xh", "Xhosa", "isiXhosa", 0), ("af", "Afrikaans", "Afrikaans", 0), ("so", "Somali", "Soomaali", 0),
    ("mg", "Malagasy", "Malagasy", 0), ("rw", "Kinyarwanda", "Kinyarwanda", 0), ("sn", "Shona", "chiShona", 0),
    ("la", "Latin", "Latina", 0), ("eo", "Esperanto", "Esperanto", 0), ("ht", "Haitian Creole", "Kreyòl ayisyen", 0),
    ("jv", "Javanese", "Basa Jawa", 0), ("su", "Sundanese", "Basa Sunda", 0), ("ceb", "Cebuano", "Cebuano", 0),
    ("hmn", "Hmong", "Hmoob", 0), ("ug", "Uyghur", "ئۇيغۇرچە", 1), ("sd", "Sindhi", "سنڌي", 1),
]
# MyMemory wants RFC 3066-style codes for a few languages
_MM = {"zh": "zh-CN", "zh-TW": "zh-TW", "no": "nb", "tl": "fil", "pt": "pt-PT"}

_lock = threading.Lock()
_cache = None
_quota_blocked_until = 0.0
_stats = {"sent_chars": 0, "cache_hits": 0, "errors": 0}


def _load():
    global _cache
    if _cache is None:
        try:
            with open(CACHE_FILE, "r", encoding="utf-8") as f:
                _cache = json.load(f)
        except Exception:
            _cache = {}
    return _cache


def _save():
    try:
        os.makedirs(os.path.dirname(CACHE_FILE), exist_ok=True)
        c = _cache
        if len(c) > 30000:                         # keep the newest entries
            for k in list(c)[:len(c) - 24000]:
                del c[k]
        with open(CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(c, f, ensure_ascii=False)
    except OSError:
        pass


def _key(src, tgt, text):
    return f"{src}>{tgt}|{text}"


def _chunks(text, limit=440):
    """MyMemory takes at most ~500 bytes per request: split long text at sentence ends."""
    if len(text.encode("utf-8")) <= limit:
        return [text]
    parts, cur = [], ""
    for sent in re.split(r"(?<=[.!?。！？])\s+", text):
        if cur and len((cur + " " + sent).encode("utf-8")) > limit:
            parts.append(cur)
            cur = sent
        else:
            cur = (cur + " " + sent).strip()
    if cur:
        parts.append(cur)
    out = []
    for p in parts:                                # a single huge sentence: hard cut
        while len(p.encode("utf-8")) > limit:
            out.append(p[:limit // 3])
            p = p[limit // 3:]
        out.append(p)
    return out


class QuotaExceeded(Exception):
    pass


def _call(text, src, tgt, email):
    global _quota_blocked_until
    if time.time() < _quota_blocked_until:
        raise QuotaExceeded("daily free limit reached")
    params = {"q": text, "langpair": f"{_MM.get(src, src)}|{_MM.get(tgt, tgt)}"}
    if email:
        params["de"] = email
    req = urllib.request.Request(ENDPOINT + "?" + urllib.parse.urlencode(params), headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=15) as r:
        data = json.loads(r.read().decode("utf-8", "replace"))
    out = (data.get("responseData") or {}).get("translatedText") or ""
    # MyMemory's top hit is often a stored *fragment* ("Search the " -> "Buscar en el"). Prefer a candidate
    # for the whole text, then its machine translation, and never one that just echoes the input.
    try:
        want = text.strip().lower()
        cands = [m for m in data.get("matches", []) if (m.get("translation") or "").strip()
                 and m["translation"].strip().lower() != want]
        whole = [m for m in cands if (m.get("segment") or "").strip().lower() == want]
        mt = [m for m in cands if "machine" in str(m.get("reference") or "").lower()
              and len((m.get("segment") or "")) >= 0.8 * len(text)]
        pick = (whole or mt or [None])[0]
        if pick:
            out = pick["translation"].strip()
    except Exception:
        pass
    status = data.get("responseStatus")
    if data.get("quotaFinished") or "MYMEMORY WARNING" in out.upper() or str(status) == "429":
        _quota_blocked_until = time.time() + 3600         # try again in an hour
        raise QuotaExceeded("daily free limit reached")
    if str(status) != "200" or not out:
        raise RuntimeError(f"translator said {status}")
    _stats["sent_chars"] += len(text)
    return out


def translate_one(text, src, tgt, email=None):
    text = (text or "").strip()
    if not text or src == tgt:
        return text
    cache = _load()
    k = _key(src, tgt, text)
    if k in cache:
        _stats["cache_hits"] += 1
        return cache[k]
    pieces = [_call(p, src, tgt, email) for p in _chunks(text)]
    out = " ".join(pieces).strip()
    with _lock:
        cache[k] = out
    return out


def translate_batch(items, src, tgt, email=None):
    """items: [{id, text}] -> ({id: translated}, error_or_None)"""
    results, error = {}, None
    cache = _load()
    todo = []
    for it in items:
        t = (it.get("text") or "").strip()
        if not t or src == tgt:
            results[it["id"]] = t
        elif _key(src, tgt, t) in cache:
            results[it["id"]] = cache[_key(src, tgt, t)]
            _stats["cache_hits"] += 1
        else:
            todo.append(it)

    def work(it):
        try:
            return it["id"], translate_one(it["text"], src, tgt, email), None
        except QuotaExceeded as e:
            return it["id"], None, "quota"
        except Exception as e:
            _stats["errors"] += 1
            return it["id"], None, str(e)[:80]

    if todo:
        with ThreadPoolExecutor(max_workers=4) as pool:
            for iid, out, err in pool.map(work, todo):
                if out is not None:
                    results[iid] = out
                elif err and not error:
                    error = err
        _save()
    return results, error


def stats():
    return dict(_stats, quota_blocked=time.time() < _quota_blocked_until, cached=len(_load()))
