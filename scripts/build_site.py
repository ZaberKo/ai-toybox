#!/usr/bin/env python3
"""Build a GitHub Pages site from routes.json.

routes.json is an object of url_name: path. Each entry is published at
/<url_name>/, and the site root lists every route.

Add a tool by dropping its files in a folder and appending one entry:

    "my_tool": "my_tool/index.html"
"""

from __future__ import annotations

import html
import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ROUTES_FILE = ROOT / "routes.json"
DIST = ROOT / "dist"
URL_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")
TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)
SKIP_NAMES = {".DS_Store"}
TOOL_METADATA = {
    "keyboard_test": {
        "name": "Keyboard Diagnostics",
        "description": "Test your keys. Investigate unwanted double presses.",
        "category": "Hardware",
        "icon": '<rect x="3" y="6" width="26" height="20" rx="3"/><path d="M8 11h1m6 0h1m6 0h1M8 16h1m6 0h1m6 0h1M9 21h14"/>',
    },
    "edge_tts": {
        "name": "Edge TTS Studio",
        "description": "Turn words into speech. Find a voice that fits.",
        "category": "Audio",
        "icon": '<path d="M5 13v6m5-12v18m6-23v28m6-23v18m5-12v6"/>',
    },
}


def main() -> None:
    routes = load_routes()
    if DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir()

    pages: list[dict[str, str]] = []
    for url_name, rel_path in routes.items():
        src = resolve_page(url_name, rel_path)
        publish(url_name, src)
        title = extract_title(src.read_text(encoding="utf-8")) or url_name
        pages.append({"url_name": url_name, "path": rel_path, "title": title})

    (DIST / "routes.json").write_text(
        json.dumps({page["url_name"]: page["path"] for page in pages}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    (DIST / "index.html").write_text(render_index(pages), encoding="utf-8")
    (DIST / "404.html").write_text(render_missing(), encoding="utf-8")
    (DIST / ".nojekyll").write_text("", encoding="utf-8")
    print(f"built {len(pages)} pages -> {DIST}")


def load_routes() -> dict[str, str]:
    try:
        data = json.loads(ROUTES_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise SystemExit("routes.json is missing") from None
    except json.JSONDecodeError as exc:
        raise SystemExit(f"routes.json is not valid JSON: {exc}") from exc
    if not isinstance(data, dict) or not data:
        raise SystemExit("routes.json must be a non-empty object of url_name: path")
    return data


def resolve_page(url_name: str, rel_path: object) -> Path:
    if not isinstance(url_name, str) or not URL_NAME_RE.fullmatch(url_name):
        raise SystemExit(f"invalid url_name: {url_name!r} (use letters, digits, _ or -)")
    if url_name in {"index", "404"}:
        raise SystemExit(f"url_name {url_name!r} is reserved")
    if not isinstance(rel_path, str) or not rel_path.strip():
        raise SystemExit(f"invalid path for {url_name}")
    src = (ROOT / rel_path).resolve()
    if ROOT not in src.parents or not src.is_file():
        raise SystemExit(f"missing page for {url_name}: {rel_path}")
    if src.suffix.lower() not in {".html", ".htm"}:
        raise SystemExit(f"{url_name} must point at an HTML file, got {rel_path}")
    return src


def publish(url_name: str, src: Path) -> None:
    dest = DIST / url_name
    dest.mkdir()
    parent = src.parent
    if parent == ROOT:
        shutil.copy2(src, dest / "index.html")
        return

    copy_tree(parent, dest)
    published = dest / src.name
    index = dest / "index.html"
    if published.resolve() == index.resolve():
        return
    if index.exists():
        raise SystemExit(f"{url_name}: {parent.name}/ already contains index.html")
    published.rename(index)


def copy_tree(src: Path, dest: Path) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    for item in src.iterdir():
        if item.name in SKIP_NAMES:
            continue
        target = dest / item.name
        if item.is_dir():
            copy_tree(item, target)
        elif item.is_file():
            shutil.copy2(item, target)


def extract_title(markup: str) -> str:
    match = TITLE_RE.search(markup)
    if not match:
        return ""
    return re.sub(r"\s+", " ", match.group(1)).strip()


def render_index(pages: list[dict[str, str]]) -> str:
    cards = "\n".join(render_card(page, index) for index, page in enumerate(pages, 1))
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Toybox</title>
  <meta name="description" content="A collection of AI-generated mini tools for everyday tasks, including keyboard diagnostics and text-to-speech.">
  <meta name="theme-color" content="#101211">
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cpath fill='%23c5f86b' d='M4 4h10v10H4zm14 0h10v10H18zM4 18h10v10H4z'/%3E%3C/svg%3E">
  <style>
    :root {{
      color-scheme: dark;
      --background: #101211;
      --surface: #181b19;
      --surface-hover: #202420;
      --line: #343b35;
      --text: #f0f3ec;
      --muted: #a3ada2;
      --accent: #c5f86b;
      --mono: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
    }}
    * {{ box-sizing: border-box; }}
    ::selection {{ background: var(--accent); color: var(--background); }}
    body {{
      margin: 0;
      min-height: 100vh;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--background);
      color: var(--text);
      -webkit-font-smoothing: antialiased;
    }}
    a {{ color: inherit; }}
    .shell {{ width: min(1120px, calc(100% - 96px)); margin-inline: auto; }}
    .site-header {{
      min-height: 104px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
      border-bottom: 1px solid var(--line);
    }}
    .brand {{ display: flex; align-items: center; gap: 13px; font-size: 18px; font-weight: 650; letter-spacing: -0.04em; }}
    .brand-mark {{ width: 24px; height: 24px; display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }}
    .brand-mark span {{ background: var(--accent); }}
    .brand-mark span:last-child {{ background: transparent; border: 1px solid var(--accent); }}
    .index-label, .eyebrow, .section-label, .tool-meta, .footer-note {{ font-family: var(--mono); font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; }}
    .index-label {{ color: var(--muted); }}
    .hero {{ padding: 88px 0 66px; }}
    .eyebrow {{ color: var(--accent); margin: 0 0 26px; }}
    h1 {{ margin: 0; font-size: clamp(48px, 6.8vw, 84px); font-weight: 500; line-height: 1.03; letter-spacing: -0.065em; }}
    h1 span {{ color: var(--muted); }}
    .section-heading {{ display: flex; align-items: center; gap: 16px; margin-bottom: 20px; }}
    .section-label {{ margin: 0; color: var(--muted); font-weight: 400; }}
    .section-rule {{ flex: 1; height: 1px; background: var(--line); }}
    .tool-count {{ color: var(--accent); font-family: var(--mono); font-size: 11px; }}
    .grid {{ display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; }}
    .card {{
      min-height: 300px;
      display: flex;
      flex-direction: column;
      padding: 28px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--surface);
      color: inherit;
      text-decoration: none;
      transition: background-color 160ms ease, border-color 160ms ease;
    }}
    .card:hover {{ background: var(--surface-hover); border-color: var(--accent); }}
    .card:focus-visible {{ outline: 2px solid var(--accent); outline-offset: 5px; }}
    .card-top {{ display: flex; align-items: center; justify-content: space-between; gap: 20px; }}
    .tool-icon {{ display: grid; place-items: center; width: 54px; height: 54px; border: 1px solid var(--line); border-radius: 8px; color: var(--accent); }}
    .tool-icon svg {{ width: 30px; height: 30px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }}
    .tool-meta {{ color: var(--muted); display: flex; align-items: center; gap: 15px; }}
    .tool-number {{ color: var(--accent); }}
    .card-bottom {{ display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; margin-top: auto; padding-top: 46px; }}
    .tool-title {{ font-size: clamp(23px, 2.7vw, 32px); line-height: 1.15; font-weight: 500; letter-spacing: -0.045em; margin: 0 0 12px; }}
    .tool-description {{ color: var(--muted); font-size: 14px; line-height: 1.65; max-width: 31ch; margin: 0; }}
    .open-tool {{ width: 42px; height: 42px; border: 1px solid var(--line); border-radius: 50%; display: grid; place-items: center; flex-shrink: 0; color: var(--text); transition: background-color 160ms ease, color 160ms ease; }}
    .open-tool svg {{ width: 20px; height: 20px; }}
    .card:hover .open-tool, .card:focus-visible .open-tool {{ background: var(--accent); border-color: var(--accent); color: var(--background); }}
    .site-footer {{ margin-top: 44px; padding: 22px 0 32px; border-top: 1px solid var(--line); display: flex; justify-content: space-between; gap: 16px; }}
    .footer-note {{ color: var(--muted); margin: 0; font-size: 10px; letter-spacing: 0.08em; }}
    @media (max-width: 680px) {{
      .shell {{ width: calc(100% - 40px); }}
      .site-header {{ min-height: 80px; }}
      .index-label {{ font-size: 9px; letter-spacing: 0.05em; }}
      .hero {{ padding: 60px 0 48px; }}
      .eyebrow {{ margin-bottom: 20px; }}
      .grid {{ grid-template-columns: 1fr; gap: 14px; }}
      .card {{ min-height: 264px; padding: 24px; }}
      .tool-title {{ font-size: 28px; }}
      .site-footer {{ margin-top: 32px; flex-wrap: wrap; }}
    }}
    @media (prefers-reduced-motion: reduce) {{ * {{ transition: none !important; }} }}
  </style>
</head>
<body>
  <header class="site-header shell">
    <div class="brand"><span class="brand-mark" aria-hidden="true"><span></span><span></span><span></span><span></span></span>AI Toybox</div>
    <span class="index-label">An AI-generated tool collection</span>
  </header>
  <main class="shell">
    <section class="hero" aria-labelledby="intro-title">
      <p class="eyebrow">Small ideas, generated with AI</p>
      <h1 id="intro-title">AI-made tools.<br><span>Everyday purpose.</span></h1>
    </section>
    <section aria-labelledby="tools-title">
      <div class="section-heading"><h2 id="tools-title" class="section-label">Explore the toolbox</h2><span class="section-rule" aria-hidden="true"></span><span class="tool-count">{len(pages):02d}</span></div>
      <div class="grid">
{cards}
      </div>
    </section>
  </main>
  <footer class="site-footer shell"><p class="footer-note">AI-generated. Built to be useful.</p><p class="footer-note">AI Toybox</p></footer>
</body>
</html>
"""


def render_card(page: dict[str, str], index: int) -> str:
    url_name = html.escape(page["url_name"])
    metadata = TOOL_METADATA.get(page["url_name"], {})
    title = html.escape(metadata.get("name", page["title"]))
    description = html.escape(metadata.get("description", "A useful tool, ready when you need it."))
    category = html.escape(metadata.get("category", "Utility"))
    icon = metadata.get("icon", '<path d="M8 8h16v16H8zM16 3v5m0 16v5M3 16h5m16 0h5"/>')
    return f"""        <a class="card" href="{url_name}/" aria-labelledby="tool-{index}-title">
          <div class="card-top"><span class="tool-icon" aria-hidden="true"><svg viewBox="0 0 32 32">{icon}</svg></span><span class="tool-meta"><span>{category}</span><span class="tool-number">{index:02d}</span></span></div>
          <div class="card-bottom">
            <div><h3 id="tool-{index}-title" class="tool-title">{title}</h3><p class="tool-description">{description}</p></div>
            <span class="open-tool" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 18 18 6M6 6h12v12"/></svg></span>
          </div>
        </a>"""


def render_missing() -> str:
    return """<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>页面不存在</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b1020; color: #e8eefc; font-family: Inter, system-ui, sans-serif; }
    a { color: #7aa2ff; }
  </style>
</head>
<body>
  <p>这个地址还没有工具。<a id="home" href="/">返回目录</a></p>
  <script>
    const host = location.hostname;
    if (host.endsWith(".github.io")) {
      const repo = location.pathname.split("/").filter(Boolean)[0];
      if (repo) document.getElementById("home").href = "/" + repo + "/";
    }
  </script>
</body>
</html>
"""


if __name__ == "__main__":
    try:
        main()
    except SystemExit as exc:
        print(exc, file=sys.stderr)
        raise
