"""Release gates for Ambrose's product files (build-spec.md, Gates G1-G6). Any failure exits non-zero and blocks the build.
  merge  <manuscript.md> <values.json> <out.md>   G1: fill {{tokens}}; fail on any token left unfilled or filled with an empty value
  lint   <manuscript.md> [...]                     G2: layout markers, Pocket Card width, page count, lore-as-authority phrases
  glyphs <manuscript.md> <font.ttf> [...]          G3: every non-ASCII character in the text exists in at least one font (no tofu)
  links  <manuscript.md> [...]                     G4: every URL and bare domain path answers 200 (after redirects)
  pdf    <file.pdf> <expected_pages>               G5: page count, no "{{", no "☐" left as text, no ":::footer" printed (needs pdftotext)"""
import json, re, subprocess, sys, unicodedata, urllib.request

TOKEN = re.compile(r"\{\{\s*([a-zA-Z0-9_|]+)\s*\}\}")
def fail(msg): print("FAIL:", msg); sys.exit(1)

def merge(src, values, dst):
    text = open(src, encoding="utf-8").read()
    vals = json.load(open(values, encoding="utf-8"))
    body = text.split("\n---\n", 1)[1] if text.startswith("---") else text   # front matter is notes, not print
    missing = sorted({m.group(1) for m in TOKEN.finditer(body) if not str(vals.get(m.group(1), "")).strip()})
    if missing: fail(f"{src}: unfilled tokens {missing}")
    out = TOKEN.sub(lambda m: str(vals[m.group(1)]), body)
    if "{{" in out or "}}" in out: fail(f"{src}: stray braces after merge")
    open(dst, "w", encoding="utf-8").write(out); print("ok merge", dst)

LORE = [r"\bgreat house\b", r"\bthe staff always knew\b", r"\bevery house I served\b"]
def lint(paths):
    bad = []
    for p in paths:
        t = open(p, encoding="utf-8").read()
        body = t.split("\n---\n", 1)[1] if t.startswith("---") else t
        if re.search(r"^Small print", body, re.M): bad.append(f"{p}: layout direction printed as body text ('Small print')")
        if body.count(":::footer") != len(re.findall(r"^:::$", body, re.M)): bad.append(f"{p}: unbalanced :::footer blocks")
        for pat in LORE:
            for m in re.finditer(pat, body, re.I): bad.append(f"{p}: lore used as authority: '{m.group(0)}'")
        if "studio_legal_name" in body: bad.append(f"{p}: studio_legal_name token (no legal name exists; PRD D1)")
        for blk in re.findall(r"```\n(┌.*?┘)\n", body, re.S):
            widths = {len(l) for l in blk.splitlines()}
            if len(widths) != 1: bad.append(f"{p}: box drawing has ragged widths {sorted(widths)}")
        if p.endswith("product-1.md"):
            n = len(re.findall(r"^---PAGE--- \d+", body.split("\n---FILE--- ")[0], re.M))
            if n != 46: bad.append(f"{p}: {n} pages, expected 46")
    if bad: fail("\n  " + "\n  ".join(bad))
    print("ok lint", len(paths), "files")

def glyphs(src, fonts):
    from fontTools.ttLib import TTFont
    cmap = set()
    for f in fonts: cmap |= set(TTFont(f).getBestCmap().keys())
    text = open(src, encoding="utf-8").read()
    need = sorted({ch for ch in text if ord(ch) > 127 and ch not in "☐"})  # ☐ is drawn as a vector box, never set in a font
    miss = [f"U+{ord(c):04X} {unicodedata.name(c, '?')}" for c in need if ord(c) not in cmap]
    if miss: fail(f"{src}: glyphs missing from {fonts}: {miss}")
    print("ok glyphs", src, len(need), "characters")

URL = re.compile(r"\b((?:https?://)?(?:[a-z0-9-]+\.)+(?:com|gov|org|uk|co\.uk)(?:/[^\s)|*,;]*)?)", re.I)
def links(paths):
    bad, blocked = [], []
    seen = set()
    for p in paths:
        for m in URL.finditer(open(p, encoding="utf-8").read()):
            u = m.group(1).rstrip(".")
            if u in seen or "lemonsqueezy" in u or u.endswith(".md") or "@" in u: continue
            seen.add(u)
            full = u if u.startswith("http") else "https://" + u
            tries = [full] if u.startswith("http") or u.startswith("www.") else [full, "https://www." + u]
            codes = []
            for t in tries:
                r = subprocess.run(["curl", "-sL", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "20",
                                    "-A", "Mozilla/5.0 (link check)", t], capture_output=True, text=True)
                codes.append(r.stdout.strip() or "000")
                if codes[-1] == "200": break
            if codes[-1] in ("403", "429"): blocked.append(f"{full} -> {codes}")
            elif codes[-1] != "200": bad.append(f"{full} -> {codes}")
    if blocked:
        print("RECHECK (blocked to scripts; Job J6 re-fetches these through the Knowledge Builder's browser and fails the release on anything but 200):\n  " + "\n  ".join(blocked))
        open("links-recheck.txt", "w").write("\n".join(b.split(" -> ")[0] for b in blocked))
    if bad: fail("dead links:\n  " + "\n  ".join(bad))
    print("ok links", len(seen), "checked,", len(blocked), "queued for browser re-check")

def pdf(path, pages):
    info = subprocess.run(["pdfinfo", path], capture_output=True, text=True).stdout
    n = int(re.search(r"Pages:\s+(\d+)", info).group(1))
    if n != int(pages): fail(f"{path}: {n} pages, expected {pages}")
    txt = subprocess.run(["pdftotext", path, "-"], capture_output=True, text=True).stdout
    for bad in ("{{", "}}", ":::footer", "☐", "Small print, foot"):
        if bad in txt: fail(f"{path}: '{bad}' printed in the PDF")
    if "�" in txt: fail(f"{path}: replacement character (tofu) in extracted text")
    print("ok pdf", path, n, "pages")

if __name__ == "__main__":
    cmd, *a = sys.argv[1:]
    {"merge": lambda: merge(*a), "lint": lambda: lint(a), "glyphs": lambda: glyphs(a[0], a[1:]),
     "links": lambda: links(a), "pdf": lambda: pdf(*a)}[cmd]()
