# AI Toybox

一个 **AI 生成的小工具集合**：把日常遇到的小需求，做成打开浏览器就能使用的独立网页应用。

工具代码与页面设计主要通过 AI 生成，再结合代码 review、回归测试和实际浏览器检查持续迭代。

**在线使用：[AI Toybox](https://zaberko.github.io/ai-toybox/)**

| 工具 | 用途 | 在线入口 |
| --- | --- | --- |
| 键盘诊断工具 | 查看按键响应、记录输入间隔，排查疑似重复触发 | [打开工具](https://zaberko.github.io/ai-toybox/keyboard_test/) |
| Edge TTS Studio | 浏览音色、调节语音参数、合成试听并导出音频与字幕 | [打开工具](https://zaberko.github.io/ai-toybox/edge_tts/) |

## 关于这个项目

AI Toybox 是一个持续扩充的 AI 小工具实验集合。每个工具围绕一个具体用途设计，可以独立访问；首页只负责发现和打开工具，不展示源码路径或部署细节。

站点以静态文件运行，通过 GitHub Pages 发布。语音工具默认使用 Edge TTS，无需额外 API Key；如果浏览器限制远端连接，会尝试匹配本机语音。键盘诊断结果用于观察疑似异常输入，不替代硬件检测。

## 开发与验证

路由写在 [`routes.json`](routes.json) 中，构建脚本为 [`scripts/build_site.py`](scripts/build_site.py)。推送到 `main` 后，GitHub Actions 会先运行回归测试，再构建并发布站点。

运行回归测试：

```bash
node --test scripts/tests/*.test.mjs
```

本地构建与预览：

```bash
python3 scripts/build_site.py
python3 -m http.server -d dist
```

## 加工具

在 `routes.json` 加一条 `url_name: path`：

```json
{
  "keyboard_test": "keyboard_test/keyboard_test.html",
  "edge_tts": "edge_tts_dashboard/edge_tts_web.html"
}
```

`url_name` 是网址，`path` 是页面文件。发布后从 `https://zaberko.github.io/ai-toybox/<url_name>/` 打开。页面所在目录里的样式、脚本和图片会一起发布。
