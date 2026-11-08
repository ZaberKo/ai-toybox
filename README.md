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

站点通过 GitHub Pages 发布静态网页。语音工具的页面、样式和交互代码写在同一个 HTML 文件里，使用原生 JavaScript、Tailwind CSS 和 Lucide 图标。示例文本按音色的语言填入，多语种示例可手动选择。键盘诊断结果用于观察疑似异常输入，不替代硬件检测。

## 开发与验证

首页和各工具都是 Vite 的独立 HTML 入口，工具清单在 [`vite.config.js`](vite.config.js) 中维护。建议使用与 CI 一致的 Node.js 26 LTS 和 [`package.json`](package.json) 指定的 pnpm 版本。推送到 `main` 后，GitHub Actions 会按 pnpm 锁文件安装依赖，通过 Vitest 回归测试后发布 Vite 构建产物。

安装依赖并启动开发服务器：

```bash
pnpm install --frozen-lockfile
pnpm dev
```

运行测试、构建并预览生产版本：

```bash
pnpm test
pnpm build
pnpm preview
```

开发版从 `/edge_tts/` 打开语音工具，生产预览路径为 `/ai-toybox/edge_tts/`。

语音工具由浏览器直接连接微软 Read Aloud 服务，使用所选音色和参数合成音频。微软会拒绝部分浏览器的握手，页面会报告连接失败。音色浏览和估算字幕导出可以独立使用。

## 加工具

把工具页面放在对应目录的 `index.html`，然后在 `vite.config.js` 的 `routes` 对象中添加以目录名为键的条目。Vite 用目录名定位页面，并用同一条配置生成首页卡片。

```js
my_tool: {
    name: "My Tool",
    description: "Describe what the tool does.",
    category: "Utility"
},
```

只有 `name` 必填。可用 `iconPath` 指定首页卡片图标的 SVG 路径。发布后可从 [AI Toybox 首页](https://zaberko.github.io/ai-toybox/)打开新工具。工具使用的样式、模块脚本和图片可以在页面中直接引用，由 Vite 处理。需按原路径发布的静态文件可放到 `public/`。
