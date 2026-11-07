import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { finished } from "node:stream/promises";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { defineConfig } from "vite";
import routes from "./routes.json" with { type: "json" };

const root = import.meta.dirname;
const home = resolve(root, "index.html");
const pages = Object.entries(routes);

const toolMetadata = {
    keyboard_test: {
        name: "Keyboard Diagnostics",
        description: "Test your keys. Investigate unwanted double presses.",
        category: "Hardware",
        icon: '<rect x="3" y="6" width="26" height="20" rx="3"/><path d="M8 11h1m6 0h1m6 0h1M8 16h1m6 0h1m6 0h1M9 21h14"/>'
    },
    edge_tts: {
        name: "Edge TTS Studio",
        description: "Turn words into speech. Find a voice that fits.",
        category: "Audio",
        icon: '<path d="M5 13v6m5-12v18m6-23v28m6-23v18m5-12v6"/>'
    }
};

for (const [name, source] of pages) {
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name) || ["index", "404"].includes(name.toLowerCase()) || source !== `${name}/index.html`) {
        throw new Error(`Invalid tool route: ${name} must point to its own index.html`);
    }
}

function escapeHtml(value) {
    const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return value.replace(/[&<>"']/g, character => entities[character]);
}

function renderCard([route, source], index) {
    const number = index + 1;
    const metadata = Object.hasOwn(toolMetadata, route) ? toolMetadata[route] : {};
    const name = metadata.name || readFileSync(resolve(root, source), "utf8").match(/<title[^>]*>([^<]*)<\/title>/i)?.[1].trim() || route;
    const description = metadata.description || "A useful tool, ready when you need it.";
    const category = metadata.category || "Utility";
    const icon = metadata.icon || '<path d="M8 8h16v16H8zM16 3v5m0 16v5M3 16h5m16 0h5"/>';

    return `<a class="card" href="${route}/" aria-labelledby="tool-${number}-title">
          <div class="card-top"><span class="tool-icon" aria-hidden="true"><svg viewBox="0 0 32 32">${icon}</svg></span><span class="tool-meta"><span>${escapeHtml(category)}</span><span class="tool-number">${String(number).padStart(2, "0")}</span></span></div>
          <div class="card-bottom">
            <div><h3 id="tool-${number}-title" class="tool-title">${escapeHtml(name)}</h3><p class="tool-description">${escapeHtml(description)}</p></div>
            <span class="open-tool" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 18 18 6M6 6h12v12"/></svg></span>
          </div>
        </a>`;
}

// The local Vite server supplies the speech service transport for the static page.
const edgeTtsPath = "/api/edge-tts";
const maxRequestBytes = 64 * 1024;
const maxAudioBytes = 12 * 1024 * 1024;
const maxConcurrentRequests = 4;
const maxUpstreamTextBytes = 4096;

class RequestError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

async function readInput(request) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length;
        if (bytes > maxRequestBytes) {
            request.resume();
            throw new RequestError(413, "The synthesis request exceeds 64 KiB.");
        }
        chunks.push(chunk);
    }
    let input;
    try {
        input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        throw new RequestError(400, "Invalid synthesis JSON.");
    }
    const validPercent = value => typeof value === "string" && /^[+-](?:100|\d{1,2})%$/.test(value);
    if (!input || typeof input.text !== "string" || !input.text.trim()
        || typeof input.voice !== "string" || !/^[a-z]{2,3}-[A-Z]{2}(?:-[A-Za-z0-9]+)*-[A-Za-z0-9]+Neural$/.test(input.voice)
        || !validPercent(input.rate) || !validPercent(input.volume)
        || typeof input.pitch !== "string" || !/^[+-](?:100|\d{1,2})Hz$/.test(input.pitch)) {
        throw new RequestError(400, "Provide text, an Edge voice ID, and valid prosody parameters.");
    }
    return input;
}

function splitText(text) {
    const xml = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
    const escape = value => value.replace(/[&<>]/g, character => xml[character]);
    const cleaned = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, " ");
    const chunks = [];
    let chunk = "";
    let bytes = 0;
    function append(escaped, size) {
        if (bytes + size > maxUpstreamTextBytes) {
            if (chunk.trim()) chunks.push(chunk);
            chunk = "";
            bytes = 0;
        }
        chunk += escaped;
        bytes += size;
    }
    for (const word of cleaned.match(/\S+\s*|\s+/gu) || []) {
        const escaped = escape(word);
        const size = Buffer.byteLength(escaped);
        if (size <= maxUpstreamTextBytes) {
            append(escaped, size);
            continue;
        }
        for (const character of word) {
            const unit = escape(character);
            append(unit, Buffer.byteLength(unit));
        }
    }
    if (chunk.trim()) chunks.push(chunk);
    return chunks;
}

async function synthesize({ text, voice, rate, volume, pitch }, signal) {
    const chunks = splitText(text);
    if (!chunks.length) throw new RequestError(400, "Enter text that can be synthesized.");
    const audio = [];
    const cues = [];
    let bytes = 0;
    for (const chunk of chunks) {
        signal.throwIfAborted();
        const tts = new MsEdgeTTS();
        const cancel = () => tts.close();
        signal.addEventListener("abort", cancel, { once: true });
        try {
            await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, { wordBoundaryEnabled: true });
            signal.throwIfAborted();
            const startBytes = bytes;
            const { audioStream, metadataStream } = tts.toStream(chunk, { rate, volume, pitch });
            audioStream.on("data", data => {
                bytes += data.length;
                if (bytes > maxAudioBytes) audioStream.destroy(new RequestError(413, "The synthesized audio is too large."));
                else audio.push(data);
            });
            metadataStream.on("data", data => {
                let metadata;
                try {
                    metadata = JSON.parse(data.toString()).Metadata;
                } catch {
                    audioStream.destroy(new Error("Invalid Edge synthesis metadata."));
                    return;
                }
                if (!Array.isArray(metadata)) return;
                for (const item of metadata) {
                    const boundary = item?.Data;
                    if (item?.Type !== "WordBoundary" || !Number.isFinite(boundary?.Offset) || boundary.Offset < 0
                        || !Number.isFinite(boundary?.Duration) || boundary.Duration <= 0 || typeof boundary?.text?.Text !== "string") continue;
                    // A 48 kbps MP3 contains six bytes per millisecond.
                    cues.push({ offset: startBytes / 6 + boundary.Offset / 10000, duration: boundary.Duration / 10000, text: boundary.text.Text });
                }
            });
            await finished(audioStream, { signal, cleanup: true });
            if (bytes === startBytes) throw new Error("Edge returned no audio.");
        } finally {
            signal.removeEventListener("abort", cancel);
            tts.close();
        }
    }
    return { voice, audio: Buffer.concat(audio, bytes).toString("base64"), cues };
}

export function createEdgeTtsApi(path = edgeTtsPath) {
    let activeRequests = 0;
    return async (request, response, next) => {
        if (request.url?.split("?", 1)[0] !== path) return next();
        const send = (status, result) => {
            if (response.destroyed) return;
            response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
            response.end(JSON.stringify(result));
        };
        const origin = request.headers.origin;
        const protocol = request.socket.encrypted ? "https" : "http";
        if (origin && origin !== `${protocol}://${request.headers.host}`) {
            return send(403, { error: "Open the tool on the same origin as the Vite server." });
        }
        if (request.method !== "POST") {
            response.setHeader("Allow", "POST");
            return send(405, { error: "Use POST for synthesis requests." });
        }
        if (request.headers["content-type"]?.split(";", 1)[0].trim() !== "application/json") {
            return send(415, { error: "Send the synthesis request as JSON." });
        }
        if (activeRequests >= maxConcurrentRequests) {
            return send(429, { error: "The synthesis service is busy. Try again shortly." });
        }

        const controller = new AbortController();
        const onClose = () => controller.abort();
        response.once("close", onClose);
        const timeout = AbortSignal.timeout(120000);
        const signal = AbortSignal.any([controller.signal, timeout]);
        activeRequests++;
        try {
            const input = await readInput(request);
            signal.throwIfAborted();
            send(200, await synthesize(input, signal));
        } catch (error) {
            if (controller.signal.aborted) return;
            if (timeout.aborted) send(504, { error: "Synthesis took too long. Try a shorter passage." });
            else if (error instanceof RequestError) send(error.status, { error: error.message });
            else send(502, { error: "The Microsoft speech service could not synthesize the selected voice." });
        } finally {
            activeRequests--;
            response.removeListener("close", onClose);
        }
    };
}

function configureEdgeTts(server) {
    server.middlewares.use(createEdgeTtsApi(server.config.base + edgeTtsPath.slice(1)));
}

export default defineConfig(({ command, isPreview }) => ({
    base: command === "build" || isPreview ? "/ai-toybox/" : "/",
    appType: "mpa",
    plugins: [{
        name: "toybox-edge-tts",
        configureServer: configureEdgeTts,
        configurePreviewServer: configureEdgeTts
    }, {
        name: "toybox-tool-index",
        transformIndexHtml(html, { filename }) {
            if (filename !== home) return;
            return html.replace("<!-- TOOL_COUNT -->", String(pages.length).padStart(2, "0"))
                .replace("<!-- TOOL_CARDS -->", () => pages.map(renderCard).join("\n        "));
        },
        generateBundle() {
            this.emitFile({ type: "asset", fileName: "routes.json", source: JSON.stringify(routes, null, 2) + "\n" });
        }
    }],
    build: {
        rolldownOptions: {
            input: [home, resolve(root, "404.html"), ...pages.map(([, source]) => resolve(root, source))]
        }
    }
}));
