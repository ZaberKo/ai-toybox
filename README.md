# AI Toybox

一组可以单独打开的静态小工具。路由写在 [`routes.json`](routes.json) 里，推送到 `main` 后由 GitHub Actions 发布到 GitHub Pages。

站点：https://zaberko.github.io/ai-toybox/

| 工具 | 地址 |
| --- | --- |
| 全尺寸键盘双击诊断工具 | https://zaberko.github.io/ai-toybox/keyboard_test/ |
| Edge-TTS Studio | https://zaberko.github.io/ai-toybox/edge_tts/ |

## 加工具

在 `routes.json` 加一条 `url_name: path`：

```json
{
  "keyboard_test": "keyboard_test/keyboard_test.html",
  "edge_tts": "edge_tts_dashboard/edge_tts_web.html"
}
```

`url_name` 是网址，`path` 是页面文件。发布后从 `https://zaberko.github.io/ai-toybox/<url_name>/` 打开。页面所在目录里的样式、脚本和图片会一起发布。

本地预览：

```bash
python3 scripts/build_site.py
python3 -m http.server -d dist
```
