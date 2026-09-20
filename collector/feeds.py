"""Fetch and parse RSS 2.0 / Atom / RSS 1.0 (RDF) feeds with the standard library only.

We keep just what a headline reader needs: title, link, a short plain-text summary,
publication time and a thumbnail URL. Full article text is never copied - each item
links back to the publisher.
"""
import re
import gzip
import html
import time
import zlib
import email.utils
import datetime
import urllib.request
import xml.etree.ElementTree as ET
from html.parser import HTMLParser

USER_AGENT = "Mozilla/5.0 (compatible; NewsHub/1.0; personal news reader)"
SUMMARY_MAX = 320

NS = {"atom": "http://www.w3.org/2005/Atom", "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
      "rss1": "http://purl.org/rss/1.0/", "dc": "http://purl.org/dc/elements/1.1/",
      "media": "http://search.yahoo.com/mrss/", "content": "http://purl.org/rss/1.0/modules/content/"}


class _Strip(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.skip = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.skip += 1
        elif tag in ("br", "p", "div", "li"):
            self.parts.append(" ")

    def handle_endtag(self, tag):
        if tag in ("script", "style") and self.skip:
            self.skip -= 1

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def clean_text(raw, limit=None):
    if not raw:
        return ""
    p = _Strip()
    try:
        p.feed(raw)
        text = "".join(p.parts)
    except Exception:
        text = re.sub(r"<[^>]+>", " ", raw)
    text = html.unescape(text)
    text = re.sub(r"\s+", " ", text).strip()
    if limit and len(text) > limit:
        cut = text[:limit].rsplit(" ", 1)[0].rstrip(",;:- ")
        text = cut + "..."
    return text


def _first_img(raw):
    m = re.search(r"<img[^>]+src=[\"']([^\"']+)[\"']", raw or "", re.I)
    return m.group(1) if m else ""


def _parse_time(text):
    if not text:
        return None
    text = text.strip()
    try:
        return email.utils.parsedate_to_datetime(text).timestamp()
    except Exception:
        pass
    try:
        t = text.replace("Z", "+00:00")
        d = datetime.datetime.fromisoformat(t)
        if d.tzinfo is None:
            d = d.replace(tzinfo=datetime.timezone.utc)
        return d.timestamp()
    except Exception:
        return None


def _txt(el, *paths):
    for p in paths:
        found = el.find(p, NS)
        if found is not None and (found.text or "").strip():
            return found.text.strip()
    return ""


def fetch(url, timeout=15):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
                                               "Accept-Encoding": "gzip, deflate"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read(4_000_000)
        enc = (r.headers.get("Content-Encoding") or "").lower()
    if enc == "gzip" or data[:2] == b"\x1f\x8b":
        data = gzip.decompress(data)
    elif enc == "deflate":
        data = zlib.decompress(data)
    return data


def parse(data):
    """bytes -> list of item dicts (newest info only, unsorted)."""
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        cleaned = re.sub(rb"[\x00-\x08\x0b\x0c\x0e-\x1f]", b"", data)
        root = ET.fromstring(cleaned)
    items = []
    tag = root.tag.split("}")[-1].lower()
    if tag == "feed":                                   # Atom
        nodes = root.findall("atom:entry", NS)
    elif tag == "rdf":                                   # RSS 1.0
        nodes = root.findall("rss1:item", NS)
    else:                                                # RSS 2.0
        nodes = root.findall("./channel/item") or root.findall(".//item")
    for n in nodes:
        title = clean_text(_txt(n, "title", "atom:title", "rss1:title"))
        link = ""
        if tag == "feed":
            for l in n.findall("atom:link", NS):
                if l.get("rel", "alternate") == "alternate" and l.get("href"):
                    link = l.get("href")
                    break
        link = link or _txt(n, "link", "rss1:link", "guid")
        raw_desc = _txt(n, "description", "atom:summary", "atom:content", "rss1:description", "content:encoded")
        raw_full = _txt(n, "content:encoded") or raw_desc
        summary = clean_text(raw_desc, SUMMARY_MAX)
        if summary == title:
            summary = ""
        when = _parse_time(_txt(n, "pubDate", "atom:published", "atom:updated", "dc:date", "published", "updated"))
        image = ""
        for path in ("media:thumbnail", "media:content"):
            e = n.find(path, NS)
            if e is not None and e.get("url") and (path.endswith("thumbnail") or (e.get("medium") in (None, "image") and "video" not in (e.get("type") or ""))):
                image = e.get("url")
                break
        if not image:
            enc = n.find("enclosure")
            if enc is not None and (enc.get("type") or "").startswith("image") and enc.get("url"):
                image = enc.get("url")
        if not image:
            image = _first_img(raw_full)
        if title and link and link.startswith("http"):
            items.append(dict(title=title, link=link.strip(), summary=summary, published=when, image=image))
    return items


def load(url, timeout=15):
    t = time.time()
    items = parse(fetch(url, timeout))
    return items, time.time() - t
