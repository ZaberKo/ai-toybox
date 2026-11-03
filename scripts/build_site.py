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
    cards = "\n".join(render_card(page) for page in pages)
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Toybox</title>
  <style>
    :root {{
      color-scheme: dark;
      --bg: #0b1020;
      --card: #141b2e;
      --line: #26314d;
      --text: #e8eefc;
      --muted: #93a0bd;
      --accent: #7aa2ff;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      min-height: 100vh;
      font-family: Inter, system-ui, sans-serif;
      background: radial-gradient(1200px 500px at 10% -10%, #1a2750 0%, transparent 55%), var(--bg);
      color: var(--text);
    }}
    main {{ max-width: 880px; margin: 0 auto; padding: 64px 20px; }}
    h1 {{ margin: 0 0 8px; font-size: 32px; letter-spacing: -0.03em; }}
    .lead {{ margin: 0 0 28px; color: var(--muted); line-height: 1.6; }}
    code {{ font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--accent); }}
    .grid {{ display: grid; gap: 14px; }}
    a.card {{
      display: block;
      padding: 18px 20px;
      border: 1px solid var(--line);
      border-radius: 16px;
      background: rgba(20, 27, 46, 0.9);
      color: inherit;
      text-decoration: none;
    }}
    a.card:hover {{ border-color: var(--accent); }}
    .title {{ font-size: 18px; font-weight: 650; }}
    .route {{ margin-top: 8px; color: var(--muted); font-size: 13px; }}
  </style>
</head>
<body>
  <main>
    <h1>AI Toybox</h1>
    <p class="lead">每个工具有自己的地址。新增工具时，在 <code>routes.json</code> 里加一条 <code>url_name: path</code>，推送后 CI 会发布到 <code>/url_name/</code>。</p>
    <div class="grid">
{cards}
    </div>
  </main>
</body>
</html>
"""


def render_card(page: dict[str, str]) -> str:
    url_name = html.escape(page["url_name"])
    title = html.escape(page["title"])
    path = html.escape(page["path"])
    return f"""      <a class="card" href="{url_name}/">
        <div class="title">{title}</div>
        <div class="route">/{url_name}/ · {path}</div>
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
