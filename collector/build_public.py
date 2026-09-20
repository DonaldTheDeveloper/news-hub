"""Builds the news.json file the PUBLIC News Hub site reads (run by a GitHub Action every ~30 minutes).

  python build_public.py --out path/to/news.json

If --out already exists (the previous run's file) it is loaded first, so stories that have dropped off a
feed's front page stay for a few days instead of vanishing. Standard library only.
"""
import os
import sys
import json
import time
import argparse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import store
import geo
import nlp
import translate


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(HERE, "news.json"))
    ap.add_argument("--hours", type=int, default=96, help="keep stories this many hours")
    ap.add_argument("--max-items", type=int, default=2600)
    args = ap.parse_args()
    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)

    store.NEWS_FILE = out                      # previous data is read from here and refreshed in place
    store.CACHE_DIR = os.path.dirname(out)
    store.MAX_AGE_H = args.hours
    agg = store.Aggregator()
    t = time.time()
    agg.refresh()
    ok = sum(1 for s in agg.status.values() if s["ok"])
    print(f"fetched {len(agg.catalog)} feeds ({ok} ok) in {time.time() - t:.0f}s -> {len(agg.items)} stories")

    items = [dict(i) for i in agg.items[:args.max_items]]
    for n, it in enumerate(items):                 # keep the file light for phones
        s = it.get("summary") or ""
        if len(s) > 220:
            it["summary"] = s[:220].rsplit(" ", 1)[0].rstrip(",;:- ") + "..."
        if n > 700:
            it["image"] = ""
    meta = dict(
        sources=agg.meta_sources(), topics=nlp.TOPICS,
        countries={k: dict(name=v["name"], lat=v["lat"], lon=v["lon"], continent=v["continent"], polygon=v["polygon"])
                   for k, v in geo.load_countries().items()},
        languages=[dict(code=c, name=n, native=nat, rtl=bool(r)) for c, n, nat, r in translate.LANGS])
    payload = dict(generated=time.time(), updated=agg.updated, items=items, meta=meta)
    tmp = out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, out)
    print(f"wrote {out} ({os.path.getsize(out) / 1e6:.2f} MB, {len(items)} stories)")
    if len(items) < 200:
        print("WARNING: very few stories - refusing to call this a success", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
