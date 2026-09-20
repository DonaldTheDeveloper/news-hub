"""The aggregator: fetches all feeds, tags/groups stories, and answers queries from your preferences."""
import os
import re
import json
import math
import time
import hashlib
import threading
import urllib.parse
from concurrent.futures import ThreadPoolExecutor

import sources
import feeds
import geo
import nlp

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(HERE, "cache")
NEWS_FILE = os.path.join(CACHE_DIR, "news.json")
MAX_AGE_H = 24 * 7          # keep a week of stories
PER_FEED = 40


def _canon(url):
    p = urllib.parse.urlsplit(url)
    return (p.netloc.lower().removeprefix("www.") + p.path.rstrip("/")).lower()


def _id(link):
    return hashlib.sha1(_canon(link).encode()).hexdigest()[:12]


class Aggregator:
    def __init__(self):
        self.catalog = {s["id"]: s for s in sources.catalog()}
        self.items = []
        self.status = {sid: dict(ok=None, count=0, error="", checked=0, fails=0) for sid in self.catalog}
        self.updated = 0
        self.lock = threading.RLock()
        self.refreshing = False
        os.makedirs(CACHE_DIR, exist_ok=True)
        self._load_disk()

    # ---- persistence ----
    def _load_disk(self):
        try:
            with open(NEWS_FILE, "r", encoding="utf-8") as f:
                d = json.load(f)
            self.items = d.get("items", [])
            self.updated = d.get("updated", 0)
            for sid, st in d.get("status", {}).items():
                if sid in self.status:
                    self.status[sid].update(st)
        except Exception:
            pass

    def _save_disk(self):
        try:
            with open(NEWS_FILE, "w", encoding="utf-8") as f:
                json.dump(dict(items=self.items, updated=self.updated, status=self.status), f, ensure_ascii=False)
        except OSError:
            pass

    # ---- fetching ----
    def _fetch_source(self, src):
        st = self.status[src["id"]]
        if st["fails"] >= 4 and time.time() - st["checked"] < 6 * 3600:      # a feed that keeps failing: retry every 6 h
            return src["id"], None, "skipped after repeated failures"
        try:
            raw, _ = feeds.load(src["url"], timeout=15)
            return src["id"], raw[:PER_FEED], ""
        except Exception as e:
            return src["id"], None, str(e)[:100]

    def refresh(self):
        if self.refreshing:
            return
        self.refreshing = True
        try:
            now = time.time()
            with ThreadPoolExecutor(max_workers=16) as pool:
                results = list(pool.map(self._fetch_source, self.catalog.values()))
            fresh = []
            for sid, raw, err in results:
                st = self.status[sid]
                if raw is None:
                    if not err.startswith("skipped"):
                        st.update(ok=False, error=err, checked=now, fails=st["fails"] + 1)
                    continue
                st.update(ok=True, count=len(raw), error="", checked=now, fails=0)
                src = self.catalog[sid]
                for it in raw:
                    pub = it["published"]
                    if pub is None or pub > now + 3600 or pub < now - MAX_AGE_H * 3600:
                        if pub is None:
                            pub = now
                        else:
                            continue
                    text = it["title"] + " " + (it["summary"] or "")
                    origin = src["country"]
                    mentioned = geo.tag_countries(text)
                    fresh.append(dict(
                        id=_id(it["link"]), title=it["title"], summary=it["summary"], link=it["link"], image=it["image"],
                        published=pub, source=sid, lang=src["lang"], origin=origin, countries=mentioned,
                        topics=nlp.classify(it["title"], it["summary"], src["topics"], src["lang"])))
            # merge with what we already had (a feed that failed keeps its older stories)
            merged = {i["id"]: i for i in self.items if i["published"] > now - MAX_AGE_H * 3600}
            for it in fresh:
                merged[it["id"]] = it
            items = sorted(merged.values(), key=lambda i: -i["published"])
            seen, uniq = set(), []
            for it in items:                                     # same story republished on two URLs
                key = (it["source"], re.sub(r"\W+", "", it["title"].lower())[:60])
                if key not in seen:
                    seen.add(key)
                    uniq.append(it)
            nlp.group_duplicates(uniq)
            with self.lock:
                self.items = uniq
                self.updated = now
            self._save_disk()
        finally:
            self.refreshing = False

    def start(self, interval=600):
        def loop():
            first = True
            while True:
                try:
                    self.refresh()
                except Exception as e:
                    print("refresh error:", e)
                time.sleep(interval if not first or self.items else 30)
                first = False
        threading.Thread(target=loop, daemon=True).start()

    # ---- querying ----
    def meta_sources(self):
        out = []
        for s in self.catalog.values():
            st = self.status[s["id"]]
            out.append(dict(s, ok=st["ok"], count=st["count"]))
        return out

    def query(self, p):
        """p: dict of preferences (see server.py for the URL parameters)."""
        now = time.time()
        hours = float(p.get("hours", 48))
        topics_w = p.get("topic_weights", {})
        allowed_topics = set(p.get("topics", []))
        countries = set(p.get("countries", []))
        continents = set(p.get("continents", []))
        src_off = set(p.get("sources_off", []))
        langs = set(p.get("langs", []))
        boost = [b.lower() for b in p.get("boost", []) if b]
        mute = [m.lower() for m in p.get("mute", []) if m]
        q = (p.get("q") or "").strip().lower()
        scope = p.get("scope", "both")
        only_public = p.get("only_public")
        no_public = p.get("no_public")
        cinfo = geo.load_countries()
        with self.lock:
            pool = list(self.items)
        results, heat = [], {}
        for it in pool:
            age_h = (now - it["published"]) / 3600
            if age_h > hours or it["source"] in src_off:
                continue
            src = self.catalog.get(it["source"])
            if not src:
                continue
            if langs and it["lang"] not in langs:
                continue
            if only_public and src["note"] != "public":
                continue
            if no_public and src["note"] == "public":
                continue
            topics = it["topics"]
            weights = [topics_w.get(t, 1.0) for t in topics]
            if allowed_topics and not (set(topics) & allowed_topics):
                continue
            if weights and max(weights) <= 0:
                continue
            hay = (it["title"] + " " + it["summary"]).lower()
            if mute and any(m in hay for m in mute):
                continue
            if q and q not in hay:
                continue
            geo_set = set(it["countries"]) if scope in ("both", "mentioned") else set()
            if scope in ("both", "origin") and it["origin"]:
                geo_set.add(it["origin"])
            for c in it["countries"] or [it["origin"]]:           # the globe's heat map uses mentions, else origin
                if c:
                    heat[c] = heat.get(c, 0) + 1
            if countries and not (geo_set & countries):
                continue
            if continents and not any(cinfo.get(c, {}).get("continent") in continents for c in geo_set):
                continue
            score = math.exp(-age_h / 20.0)
            score *= 1 + 0.35 * min(it.get("group_size", 1) - 1, 4)
            score *= max(weights) if weights else 1.0
            score *= 1 + 0.5 * min(sum(1 for b in boost if b in hay), 2)
            results.append((score, it))
        results.sort(key=lambda r: -r[0])
        if p.get("sort") == "new":
            results.sort(key=lambda r: -r[1]["published"])
        # one card per story: keep the best-ranked member of each duplicate group ('also covered by' lists the rest)
        shown_groups, collapsed = set(), []
        for score, it in results:
            g = it.get("group")
            if g is not None and it.get("group_size", 1) > 1:
                if g in shown_groups:
                    continue
                shown_groups.add(g)
            collapsed.append((score, it))
        # diversity: one source shouldn't fill the whole page
        limit = int(p.get("limit", 120))
        per_src, out, rest = {}, [], []
        cap = max(6, limit // 6)
        for score, it in collapsed:
            n = per_src.get(it["source"], 0)
            if n < cap:
                per_src[it["source"]] = n + 1
                out.append((score, it))
            else:
                rest.append((score, it))
        final = (out + rest)[:limit]
        payload = []
        for score, it in final:
            src = self.catalog[it["source"]]
            also = [self.catalog[s]["name"] for s in it.get("group_sources", []) if s != it["source"] and s in self.catalog]
            payload.append(dict(id=it["id"], title=it["title"], summary=it["summary"], link=it["link"], image=it["image"],
                                published=it["published"], lang=it["lang"], topics=it["topics"], countries=it["countries"],
                                origin=it["origin"], source=dict(id=src["id"], name=src["name"], lang=src["lang"],
                                                                 country=src["country"], note=src["note"]),
                                also=also[:5], score=round(score, 3)))
        return dict(items=payload, heat=heat, total=len(results), updated=self.updated, refreshing=self.refreshing)
