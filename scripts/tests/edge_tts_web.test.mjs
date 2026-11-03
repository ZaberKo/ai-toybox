import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../../edge_tts_dashboard/edge_tts_web.html", import.meta.url), "utf8");
const source = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].at(-1)[1];
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };

function createApp({ voices = [], blockPlayback = false } = {}) {
    const elements = new Map();
    const groups = new Map();
    const downloads = [];
    const timers = new Map();
    const sockets = [];
    let timerId = 0;
    let now = 0;
    let initialize;

    function element(tag = "div") {
        const item = {
            tag, value: "", checked: true, disabled: false, textContent: "", className: "", attributes: {}, handlers: {}, children: [],
            style: {}, currentTime: 0, paused: true, src: "",
            addEventListener(event, handler) { this.handlers[event] = handler; },
            setAttribute(name, value) { this.attributes[name] = value; },
            getAttribute(name) { return this.attributes[name]; },
            removeAttribute(name) { delete this.attributes[name]; if (name === "src") this.src = ""; },
            appendChild(child) { this.children.push(child); },
            remove() {}, select() {},
            querySelector(selector) { if (selector === "span") return this.label ??= element("span"); },
            querySelectorAll(selector) {
                if (selector !== ".voice-card") return [];
                return [...(this.innerHTML || "").matchAll(/data-voice="([^"]+)"/g)].map(match => {
                    const card = element();
                    card.attributes["data-voice"] = match[1];
                    return card;
                });
            },
            click() {
                if (this.tag === "a") downloads.push({ href: this.href, download: this.download });
                return this.handlers.click?.();
            },
            emit(event) { this[`on${event}`]?.({}); },
            pause() { const wasPlaying = !this.paused; this.paused = true; if (wasPlaying) this.emit("pause"); },
            load() { this.paused = true; },
            play() {
                if (blockPlayback) return Promise.reject(new DOMException("Playback blocked", "NotAllowedError"));
                this.paused = false;
                this.emit("playing");
                return Promise.resolve();
            },
            getBoundingClientRect() { return { width: 400, height: 56 }; },
            getContext() {
                return { scale() {}, clearRect() {}, beginPath() {}, roundRect() {}, fill() {}, createLinearGradient() { return { addColorStop() {} }; } };
            }
        };
        item.classList = {
            add(name) { item.className = `${item.className} ${name}`; },
            remove(name) { item.className = item.className.split(" ").filter(value => value !== name).join(" "); }
        };
        return item;
    }

    for (const match of html.matchAll(/\bid="([^"]+)"/g)) elements.set(match[1], element());
    for (const match of html.matchAll(/<button\b([^>]*)>/g)) {
        const attributes = Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(value => [value[1], value[2]]));
        const button = elements.get(attributes.id) || element("button");
        button.attributes = attributes;
        button.className = attributes.class || "";
        for (const className of button.className.split(" ")) {
            if (!groups.has(`.${className}`)) groups.set(`.${className}`, []);
            groups.get(`.${className}`).push(button);
        }
    }
    elements.get("tts-text").value = html.match(/<textarea[^>]*id="tts-text"[^>]*>([\s\S]*?)<\/textarea>/)[1];
    elements.get("locale-filter").value = "ALL";
    const speech = {
        voices, spoken: [], handlers: new Map(),
        getVoices() { return this.voices; },
        addEventListener(name, handler) { this.handlers.set(name, handler); },
        removeEventListener(name) { this.handlers.delete(name); },
        cancel() { this.spoken.at(-1)?.onerror?.({ error: "canceled" }); },
        speak(utterance) { this.spoken.push(utterance); }
    };
    class FakeWebSocket {
        constructor(url) { this.url = url; this.sent = []; this.closed = false; sockets.push(this); }
        send(data) { this.sent.push(data); }
        close() { this.closed = true; }
        open() { this.onopen?.(); }
        message(data) { this.onmessage?.({ data }); }
    }
    const context = vm.createContext({
        Blob, URL, AbortController, DOMException, ArrayBuffer, DataView, Uint8Array, TextEncoder, crypto: webcrypto,
        WebSocket: FakeWebSocket, SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
        setTimeout(callback, delay) { timers.set(++timerId, { callback, at: now + delay }); return timerId; },
        clearTimeout(id) { timers.delete(id); }, requestAnimationFrame() { return 1; }, cancelAnimationFrame() {},
        lucide: { createIcons() {} },
        window: { speechSynthesis: speech, addEventListener(name, handler) { if (name === "DOMContentLoaded") initialize = handler; } },
        document: {
            body: element("body"), createElement: element,
            getElementById(id) { assert.ok(elements.has(id), `Unknown element: ${id}`); return elements.get(id); },
            querySelectorAll(selector) { return groups.get(selector) || []; }
        }
    });
    vm.runInContext(source, context);
    const run = code => vm.runInContext(code, context);
    run('syncAllCloudVoices = async () => {}; generateSecMsGec = async () => "test_token";');
    initialize();
    return {
        context, elements, speech, sockets, downloads, groups, run,
        advance(milliseconds) {
            const target = now + milliseconds;
            while (true) {
                const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
                if (!next) break;
                now = next[1].at;
                timers.delete(next[0]);
                next[1].callback();
            }
            now = target;
        },
        cleanup() { run("stopAllPlayback(); clearAudioResult()"); }
    };
}

function finishSocket(socket) {
    socket.message(new Uint8Array([0, 0, 1, 2, 3]).buffer);
    socket.message("Path:turn.end\r\n\r\n");
}

test("sample selection preserves unmatched languages and manual text", () => {
    const app = createApp();
    for (const [name, key] of [["zh-HK-HiuGaaiNeural", "hk"], ["en-US-AriaNeural", "en"], ["ja-JP-NanamiNeural", "ja"], ["zh-CN-XiaoxiaoNeural", "zh"], ["zh-CN-XiaoxiaoMultilingualNeural", "multi"]]) {
        app.run(`selectVoice(state.voices.find(voice => voice.ShortName === ${JSON.stringify(name)}))`);
        assert.equal(app.run("state.selectedSample"), key);
        assert.equal(app.elements.get("tts-text").value, app.run(`SAMPLE_TEXTS[${JSON.stringify(key)}]`));
    }
    app.elements.get("tts-text").value = "Keep this text";
    app.elements.get("tts-text").handlers.input();
    app.run('selectVoice({ ShortName: "fr-FR-DeniseNeural", Locale: "fr-FR" })');
    assert.equal(app.elements.get("tts-text").value, "Keep this text");
    assert.equal(app.run("state.selectedSample"), null);
    app.cleanup();
});

test("stopping an in-flight socket prevents playback and local fallback", async () => {
    const app = createApp();
    const pending = app.run("handleSynthesizeAndPlay()");
    await flush();
    const socket = app.sockets[0];
    socket.open();
    app.run("stopAllPlayback()");
    finishSocket(socket);
    await pending;
    assert.equal(socket.closed, true);
    assert.equal(app.speech.spoken.length, 0);
    assert.equal(app.run("state.lastAudioBlobUrl"), null);
    assert.equal(app.run("state.isSynthesizing"), false);
    app.cleanup();
});

test("new requests supersede late results and retain their parameter snapshot", async () => {
    const app = createApp();
    app.run("var pendingResults = []; synthesizeViaEdgeWebSocket = () => new Promise(resolve => pendingResults.push(resolve));");
    const first = app.run("handleSynthesizeAndPlay()");
    app.elements.get("tts-text").value = "New text";
    app.run("state.rate = 25");
    const second = app.run("handleSynthesizeAndPlay()");
    app.run('pendingResults[1]({ blob: new Blob(["new"], { type: "audio/mpeg" }), cues: [] })');
    await second;
    const currentUrl = app.run("state.lastAudioBlobUrl");
    app.run('pendingResults[0]({ blob: new Blob(["old"], { type: "audio/mpeg" }), cues: [] })');
    await first;
    assert.equal(app.run("state.lastAudioBlobUrl"), currentUrl);
    assert.equal(app.run("state.lastSynthesis.text"), "New text");
    assert.equal(app.run("state.lastSynthesis.rate"), 25);
    app.cleanup();
});

test("streaming past 6.5 seconds succeeds and idle timeout resets on data", async () => {
    const app = createApp();
    const pending = app.run('synthesizeViaEdgeWebSocket("sample", "en-US-AriaNeural", "+0%", "+0%", "+0Hz")');
    await flush();
    const socket = app.sockets[0];
    socket.open();
    app.advance(6501);
    assert.equal(socket.closed, false);
    app.advance(50000);
    socket.message(new Uint8Array([0, 0, 4]).buffer);
    app.advance(50000);
    assert.equal(socket.closed, false);
    finishSocket(socket);
    assert.equal((await pending).blob.type, "audio/mpeg");
    assert.match(new URL(socket.url).searchParams.get("ConnectionId"), /^[a-f0-9]{32}$/);
    app.cleanup();
});

test("connection, idle, premature-close, and invalid-frame failures settle promptly", async () => {
    for (const failure of ["connection", "idle", "close", "frame"]) {
        const app = createApp();
        const pending = app.run('synthesizeViaEdgeWebSocket("sample", "voice", "+0%", "+0%", "+0Hz")');
        const rejected = assert.rejects(pending);
        await flush();
        const socket = app.sockets[0];
        if (failure === "connection") app.advance(10000);
        else {
            socket.open();
            if (failure === "idle") app.advance(60000);
            if (failure === "close") socket.onclose();
            if (failure === "frame") socket.message(new ArrayBuffer(1));
        }
        await rejected;
        assert.equal(socket.closed, true);
        app.cleanup();
    }
});

test("voice matching distinguishes gender words and does not substitute Mandarin for dialects", () => {
    const app = createApp();
    for (const name of ["System Female", "System Woman", "Microsoft Aria Online (Natural)"]) {
        app.context.candidates = [{ name: "System Male", lang: "en-US" }, { name, lang: "en-US" }];
        assert.equal(app.run('findBestBrowserVoice(candidates, { Locale: "en-US", ShortName: "en-US-JennyNeural", Gender: "Female" }).name'), name);
    }
    app.context.candidates = [{ name: "System Female", lang: "zh-CN" }];
    assert.equal(app.run('findBestBrowserVoice(candidates, { Locale: "zh-CN-liaoning", ShortName: "zh-CN-liaoning-XiaobeiNeural", Gender: "Female" })'), null);
    assert.equal(app.run('findBestBrowserVoice(candidates, { Locale: "zh-HK", ShortName: "zh-HK-HiuGaaiNeural", Gender: "Female" })'), null);
    app.context.candidates = [{ name: "System Male", lang: "en-US" }];
    assert.equal(app.run('findBestBrowserVoice(candidates, { Locale: "en-US", ShortName: "en-US-JennyNeural", Gender: "Female" })'), null);
    app.context.candidates = [{ name: "Bulgarian Voice", lang: "en-US" }];
    assert.equal(app.run('findBestBrowserVoice(candidates, { Locale: "en-US", ShortName: "en-US-JennyNeural", Gender: "Female" })'), null);
    app.cleanup();
});

test("local fallback is cancellable and late callbacks cannot replace a new request's status", async () => {
    const app = createApp({ voices: [{ name: "Microsoft Xiaoxiao Online (Natural)", lang: "zh-CN" }] });
    app.run('synthesizeViaEdgeWebSocket = async () => { throw new Error("Origin blocked"); }');
    const first = app.run("handleSynthesizeAndPlay()");
    await flush();
    const utterance = app.speech.spoken[0];
    const lateEnd = utterance.onend;
    app.run("synthesizeViaEdgeWebSocket = () => new Promise(() => {})");
    app.run("handleSynthesizeAndPlay()");
    const status = app.elements.get("status-message").textContent;
    lateEnd();
    await first;
    assert.equal(app.elements.get("status-message").textContent, status);
    assert.equal(app.elements.get("btn-download-mp3").disabled, true);
    app.cleanup();
});

test("missing local dialects fail instead of silently using a default voice", async () => {
    const app = createApp({ voices: [{ name: "System Female", lang: "zh-CN" }] });
    app.run('selectVoice(state.voices.find(voice => voice.Locale === "zh-HK")); synthesizeViaEdgeWebSocket = async () => { throw new Error("Origin blocked"); }');
    await app.run("handleSynthesizeAndPlay()");
    assert.equal(app.speech.spoken.length, 0);
    assert.match(app.elements.get("status-message").textContent, /No local female voice matches zh-HK/);
    assert.equal(app.run("state.isSynthesizing"), false);
    app.cleanup();
});

test("local speech waits for asynchronous voice loading and honors cancellation and mute", async () => {
    const app = createApp();
    app.run('state.volume = -100; synthesizeViaEdgeWebSocket = async () => { throw new Error("Origin blocked"); }');
    const pending = app.run("handleSynthesizeAndPlay()");
    await flush();
    assert.equal(app.speech.spoken.length, 0);
    app.speech.voices = [{ name: "Microsoft Xiaoxiao Online (Natural)", lang: "zh-CN" }];
    app.speech.handlers.get("voiceschanged")();
    await flush();
    assert.equal(app.speech.spoken[0].volume, 0);
    app.run("stopAllPlayback()");
    await pending;
    app.speech.voices = [];
    const canceled = app.run("handleSynthesizeAndPlay()");
    await flush();
    app.run("stopAllPlayback()");
    await canceled;
    assert.equal(app.speech.handlers.has("voiceschanged"), false);
    assert.equal(app.run("state.isSynthesizing"), false);
    app.cleanup();
});

test("autoplay rejection, pause, replay, and decode errors update playback state", async () => {
    for (const blockPlayback of [true, false]) {
        const app = createApp({ blockPlayback });
        app.run('synthesizeViaEdgeWebSocket = async () => ({ blob: new Blob(["audio"], { type: "audio/mpeg" }), cues: [] })');
        await app.run("handleSynthesizeAndPlay()");
        const audio = app.elements.get("audio-player");
        if (blockPlayback) {
            assert.equal(app.run("state.isSynthesizing"), false);
            assert.match(app.elements.get("status-message").textContent, /Playback could not start/);
        } else {
            assert.equal(app.run("state.isSynthesizing"), true);
            audio.pause();
            assert.equal(app.run("state.isSynthesizing"), false);
            await audio.play();
            assert.equal(app.run("state.isSynthesizing"), true);
            audio.emit("error");
            assert.equal(app.run("state.isSynthesizing"), false);
        }
        app.cleanup();
    }
});

test("downloads retain the generated voice and real media extension", async () => {
    const app = createApp();
    app.run('synthesizeViaEdgeWebSocket = async () => ({ blob: new Blob(["RIFF"], { type: "audio/wav" }), cues: [] })');
    await app.run("handleSynthesizeAndPlay()");
    app.run('selectVoice(state.voices.find(voice => voice.Locale === "ja-JP"))');
    app.elements.get("btn-download-mp3").click();
    assert.match(app.downloads[0].download, /^zh-CN-XiaoxiaoNeural_\d+\.wav$/);
    app.elements.get("btn-download-srt").click();
    assert.equal(app.downloads[1].download, "zh-CN-XiaoxiaoNeural_subtitles.vtt");
    app.cleanup();
});

test("generated shell commands preserve text without expanding substitutions", () => {
    const app = createApp();
    for (const text of ['$(printf INJECTED)', '`printf INJECTED`', "Quotes: ' and \"; $SENTINEL", "Line one\nLine two\\"]) {
        app.elements.get("tts-text").value = text;
        app.run('state.codeTab = "cli"; updateCodePreview()');
        const script = 'edge-tts() { printf "%s\\0" "$@"; }; edge-playback() { :; };\n' + app.elements.get("code-preview-content").textContent;
        const result = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { ...process.env, SENTINEL: "EXPANDED" } });
        assert.equal(result.status, 0, result.stderr);
        const args = result.stdout.split("\0");
        assert.equal(args[args.indexOf("--text") + 1], text);
        assert.equal(args[args.indexOf("--write-subtitles") + 1], "output.srt");
    }
    app.cleanup();
});

test("generated Python executes against the current subtitle API and preserves text", () => {
    const app = createApp();
    for (const includeSubs of [true, false]) {
        const text = "Quotes: ' and \"; path: C:\\new\\test\nTrailing slash: \\";
        app.elements.get("tts-text").value = text;
        app.elements.get("chk-subtitles").checked = includeSubs;
        app.run('state.codeTab = "python"; updateCodePreview()');
        const program = `import builtins, io, json, sys, types
payload = json.load(sys.stdin)
files = {}
class Output:
    def __init__(self, path, mode, **kwargs):
        self.path = path
        self.buffer = io.BytesIO() if "b" in mode else io.StringIO()
    def __enter__(self): return self.buffer
    def __exit__(self, *args): files[self.path] = self.buffer.getvalue()
class Communicate:
    def __init__(self, text, voice, **kwargs):
        assert text == payload["text"]
        assert kwargs["boundary"] == "WordBoundary"
    async def stream(self):
        yield {"type": "audio", "data": b"audio"}
        yield {"type": "WordBoundary", "offset": 0, "duration": 10000, "text": "sample"}
    async def save(self, path): files[path] = b"audio"
class SubMaker:
    def __init__(self): self.messages = []
    def feed(self, message): self.messages.append(message)
    def get_srt(self):
        assert len(self.messages) == 1
        return "1\\n00:00:00,000 --> 00:00:00,001\\nsample\\n"
sys.modules["edge_tts"] = types.SimpleNamespace(Communicate=Communicate, SubMaker=SubMaker)
builtins.open = Output
exec(payload["source"], {"__name__": "__main__"})
assert files["output.mp3"] == b"audio"
assert ("output.srt" in files) == payload["includeSubs"]
`;
        const result = spawnSync("python3", ["-c", program], { encoding: "utf8", input: JSON.stringify({ source: app.elements.get("code-preview-content").textContent, text, includeSubs }) });
        assert.equal(result.status, 0, result.stderr);
    }
    app.cleanup();
});

test("extra API-key providers and their controls remain removed", () => {
    assert.doesNotMatch(html, /custom-api|api-mode-select|generativelanguage|synthesizeViaCloudNeuralTTS/);
    assert.doesNotMatch(html, /<a\b[^>]*href="https:\/\/github\.com\/rany2\/edge-tts"/);
});
