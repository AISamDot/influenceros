"""Exports every script in the Plan (blockquotes on pages 1-42) to script-file.txt.
Briefing transcripts (pages 43-45) are excluded; they ship as audio + transcript.
Run: python3 make_script_file.py ../product-1.md script-file.txt"""
import re, sys
src, out = sys.argv[1], sys.argv[2]
text = open(src, encoding="utf-8").read().split("\n---FILE--- ")[0]
pages = re.split(r"^---PAGE--- (\d+) · (.+)$", text, flags=re.M)
lines = ["THE BUTLER'S HOLIDAY PLAN · THE SCRIPT FILE",
         "Every script in the Plan, as plain text. Copy, change the [brackets], send.",
         "Ambrose Hale is an AI character. For personal use; please don't resell. © 2026.", ""]
n = 0
for i in range(1, len(pages), 3):
    num, title, body = int(pages[i]), pages[i + 1].strip(), pages[i + 2]
    if num >= 43: break
    section = label = None; block = []; found = []
    def name():
        if section and label and label != section: return f"{section}: {label}"
        return label or section
    for ln in body.splitlines():
        if ln.startswith(">"):
            block.append(ln.lstrip("> ").replace("**", "").strip()); continue
        if block:
            found.append((name(), "\n".join(b for b in block if b))); block = []
        st = ln.strip()
        if st.startswith("|"):
            cells = [c.strip() for c in st.strip("|").split("|")]
            q = [c for c in cells[1:] if c.startswith('"')]
            if q: found.append((cells[0].replace("*", ""), q[0])); continue
        h = re.match(r"^#{2,4}\s*(.+)$", st)
        if h: section, label = h.group(1).strip(), None; continue
        b = re.match(r"^\*\*(.+?)\*\*(.*)$", st)
        if b: label = (b.group(1) + b.group(2)).replace("*", "").strip(" :")
    if block: found.append((name(), "\n".join(b for b in block if b)))
    if not found: continue
    lines += ["=" * 60, f"PAGE {num} · {title}", "=" * 60, ""]
    for lab, sc in found:
        n += 1
        lines += [f"[{n}] {lab or 'Script'}", sc.replace("*", ""), ""]
open(out, "w", encoding="utf-8").write("\n".join(lines))
print(f"wrote {out}: {n} scripts")
if n < 20: sys.exit("FAIL: fewer than 20 scripts; the listing promises twenty-plus")
