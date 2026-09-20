"""Topic detection and duplicate-story grouping (English keywords; other languages rely on the
topics declared by the feed)."""
import re

TOPICS = ["world", "politics", "business", "tech", "science", "health", "sports", "entertainment", "environment", "culture"]

_KW = {
    "politics": r"election|elections|vote|voters|parliament|senate|congress|minister|president|prime minister|government|cabinet|"
                r"sanction|sanctions|treaty|coalition|opposition|campaign|referendum|lawmakers|diplomat|summit|policy|supreme court|ballot",
    "business": r"market|markets|stocks|shares|economy|economic|inflation|bank|banks|trade|tariff|tariffs|earnings|oil prices|"
                r"investors|company|ceo|merger|profit|revenue|jobs report|interest rate|recession|gdp|billion|startup|ipo",
    "tech": r"\bai\b|artificial intelligence|software|apple|google|microsoft|meta|openai|nvidia|chip|chips|cyber|hack|hackers|"
            r"smartphone|iphone|android|robot|app|internet|data breach|quantum|semiconductor|tesla|spacex|algorithm",
    "science": r"study|researchers|scientists|scientist|space|nasa|planet|telescope|physics|astronomy|fossil|species|discovery|"
               r"experiment|genome|particle|mars|moon|asteroid|comet|universe|laboratory",
    "health": r"health|hospital|disease|virus|vaccine|cancer|doctors|patients|medical|outbreak|epidemic|pandemic|who says|"
              r"drug|treatment|surgery|mental health|diet|obesity|dementia|covid|flu",
    "sports": r"football|soccer|cup|league|match|olympic|olympics|tennis|cricket|nba|nfl|goal|coach|champion|championship|"
              r"tournament|formula 1|f1|premier league|world cup|marathon|athlete|medal|rugby|baseball|golf",
    "entertainment": r"film|movie|movies|music|celebrity|album|netflix|actor|actress|festival|oscar|oscars|grammy|tv series|"
                     r"concert|singer|box office|hollywood|streaming|trailer|premiere",
    "environment": r"climate|wildfire|wildfires|flood|floods|emissions|biodiversity|pollution|drought|carbon|renewable|"
                   r"deforestation|heatwave|glacier|sea level|conservation|extinct|hurricane|earthquake|storm|plastic",
    "culture": r"art|museum|exhibition|book|novel|author|theatre|theater|literature|heritage|architecture|fashion|"
               r"cultural|painting|poet|opera|gallery|history",
}
_KW_RX = {t: re.compile(r"\b(?:" + p + r")\b" if not p.startswith(r"\b") else p, re.I) for t, p in _KW.items()}

_STOP = set("""a an the and or of to in on for with at by from is are was were be been it its this that these those as after over
into about new says say said will would could may not no more than up down out off amid what who how why when where
un une le la les de des du et en pour sur dans par el los las del y por con para que es der die das und von mit auf ist""".split())


def classify(title, summary, feed_topics, lang="en"):
    """Feed-declared topics first, then English keyword hits (title counts double)."""
    scores = {t: 2.0 for t in feed_topics if t in TOPICS and t != "world"}
    if lang == "en":
        for t, rx in _KW_RX.items():
            in_title = len(rx.findall(title))
            in_text = len(rx.findall(summary or ""))
            if in_title or in_text >= 3:              # a lone weak hit in the summary isn't enough
                scores[t] = scores.get(t, 0) + min(2 * in_title + in_text, 4)
    ranked = [t for t, s in sorted(scores.items(), key=lambda kv: -kv[1]) if s >= 2][:3]
    if not ranked:
        ranked = list(feed_topics[:1]) or ["world"]
    if "world" in feed_topics and "world" not in ranked and len(ranked) < 3:
        ranked.append("world")
    return ranked


def tokens(title):
    words = re.findall(r"[^\W\d_]{3,}|\d{2,}", title.lower())
    return {w for w in words if w not in _STOP}


def group_duplicates(items, threshold=0.5):
    """Marks near-identical stories (same language) with a shared group so they can be shown once
    with 'also reported by N sources'. Mutates items: adds group (int) and group_size."""
    index, groups = {}, []
    for it in sorted(items, key=lambda x: -(x.get("published") or 0)):
        toks = tokens(it["title"]) if it["lang"] != "zh" and it["lang"] != "ja" else set(it["title"])
        it["_toks"] = toks
        best, best_score = None, 0.0
        cand = set()
        for w in toks:
            cand.update(index.get((it["lang"], w), ()))
        for gi in cand:
            g = groups[gi]
            inter = len(toks & g["toks"])
            score = inter / max(1, min(len(toks), len(g["toks"])))
            if inter >= 3 and score > best_score:
                best, best_score = gi, score
        if best is not None and best_score >= threshold and it["source"] not in groups[best]["sources"]:
            groups[best]["members"].append(it)
            groups[best]["sources"].add(it["source"])
            it["group"] = best
        else:
            gi = len(groups)
            groups.append({"toks": toks, "members": [it], "sources": {it["source"]}})
            it["group"] = gi
            for w in toks:
                index.setdefault((it["lang"], w), []).append(gi)
    for g in groups:
        for m in g["members"]:
            m["group_size"] = len(g["members"])
            m["group_sources"] = [x["source"] for x in g["members"]]
    for it in items:
        it.pop("_toks", None)
    return items
