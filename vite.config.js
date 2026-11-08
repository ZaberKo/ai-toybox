import { resolve } from "node:path";
import { defineConfig } from "vite";

const routes = {
    keyboard_test: {
        name: "Keyboard Diagnostics",
        description: "Test your keys. Investigate unwanted double presses.",
        category: "Hardware",
        iconPath: "M6 6h20a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3z M8 11h1m6 0h1m6 0h1M8 16h1m6 0h1m6 0h1M9 21h14"
    },
    edge_tts: {
        name: "Edge TTS Studio",
        description: "Turn words into speech. Find a voice that fits.",
        category: "Audio",
        iconPath: "M5 13v6m5-12v18m6-23v28m6-23v18m5-12v6"
    }
};

const root = import.meta.dirname;
const home = resolve(root, "index.html");
const pages = Object.entries(routes);

for (const [route, tool] of pages) {
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(route) || ["index", "404"].includes(route.toLowerCase())) {
        throw new Error(`Invalid tool route: ${route}`);
    }
    if (typeof tool?.name !== "string" || !tool.name.trim()
        || ["description", "category", "iconPath"].some(key => tool[key] !== undefined && typeof tool[key] !== "string")) {
        throw new Error(`Invalid tool details for ${route}`);
    }
}

function escapeHtml(value) {
    const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return value.replace(/[&<>"']/g, character => entities[character]);
}

function renderCard([route, tool], index) {
    const number = index + 1;
    const {
        name,
        description = "A useful tool, ready when you need it.",
        category = "Utility",
        iconPath = "M8 8h16v16H8zM16 3v5m0 16v5M3 16h5m16 0h5"
    } = tool;

    return `<a class="card" href="${route}/" aria-labelledby="tool-${number}-title">
          <div class="card-top"><span class="tool-icon" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="${escapeHtml(iconPath)}"/></svg></span><span class="tool-meta"><span>${escapeHtml(category)}</span><span class="tool-number">${String(number).padStart(2, "0")}</span></span></div>
          <div class="card-bottom">
            <div><h3 id="tool-${number}-title" class="tool-title">${escapeHtml(name)}</h3><p class="tool-description">${escapeHtml(description)}</p></div>
            <span class="open-tool" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 18 18 6M6 6h12v12"/></svg></span>
          </div>
        </a>`;
}

export default defineConfig(({ command, isPreview }) => ({
    base: command === "build" || isPreview ? "/ai-toybox/" : "/",
    appType: "mpa",
    plugins: [{
        name: "toybox-tool-index",
        transformIndexHtml(html, { filename }) {
            if (filename !== home) return;
            return html.replace("<!-- TOOL_COUNT -->", String(pages.length).padStart(2, "0"))
                .replace("<!-- TOOL_CARDS -->", () => pages.map(renderCard).join("\n        "));
        }
    }],
    build: {
        rolldownOptions: {
            input: [home, resolve(root, "404.html"), ...pages.map(([route]) => resolve(root, route, "index.html"))]
        }
    }
}));
