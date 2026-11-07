import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import vm from "node:vm";

const html = readFileSync(new URL("../../edge_tts/index.html", import.meta.url), "utf8");
const source = html.match(/<script id="edge-tts-app">([\s\S]*?)<\/script>/)[1];

function createApp({ blockPlayback = false, pageUrl = "http://localhost:5173/edge_tts/" } = {}) {
    const elements = new Map();
    const groups = new Map();
    const downloads = [];
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
            remove() {}, select() {}, focus() {},
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
    const context = vm.createContext({
        Blob, URL, AbortController, AbortSignal, DOMException, Uint8Array, atob,
        setTimeout() {}, requestAnimationFrame() { return 1; }, cancelAnimationFrame() {},
        window: { location: new URL(pageUrl), addEventListener(name, handler) { if (name === "DOMContentLoaded") initialize = handler; } },
        document: {
            body: element("body"), createElement: element,
            getElementById(id) { assert.ok(elements.has(id), `Unknown element: ${id}`); return elements.get(id); },
            querySelectorAll(selector) { return groups.get(selector) || []; }
        }
    });
    vm.runInContext(source, context);
    const run = code => vm.runInContext(code, context);
    const syncVoices = run("syncAllCloudVoices");
    run("syncAllCloudVoices = async () => {};");
    initialize();
    return {
        context, elements, downloads, groups, run, syncVoices,
        cleanup() { run("stopAllPlayback(); clearAudioResult()"); }
    };
}

function audioResponse(voice) {
    return { ok: true, json: async () => ({ voice, audio: "YXVkaW8=", cues: [] }) };
}

test("sample selection preserves unmatched languages and manual text", () => {
    const app = createApp();
    for (const [name, key] of [["zh-HK-HiuGaaiNeural", "hk"], ["en-US-AriaNeural", "en"], ["ja-JP-NanamiNeural", "ja"], ["zh-CN-XiaoxiaoNeural", "zh"], ["en-US-AvaMultilingualNeural", "en"], ["en-GB-SoniaNeural", "en"]]) {
        app.run(`selectVoice(state.voices.find(voice => voice.ShortName === ${JSON.stringify(name)}))`);
        assert.equal(app.run("state.selectedSample"), key);
        assert.equal(app.elements.get("tts-text").value, app.run(`SAMPLE_TEXTS[${JSON.stringify(key)}]`));
    }
    const multiSample = app.groups.get(".sample-btn").find(button => button.getAttribute("data-sample") === "multi");
    multiSample.click();
    assert.equal(app.run("state.selectedSample"), "multi");
    assert.equal(app.run("state.selectedVoice.ShortName"), "en-GB-SoniaNeural");
    assert.equal(app.elements.get("tts-text").value, app.run("SAMPLE_TEXTS.multi"));
    app.elements.get("tts-text").value = "Keep this text";
    app.elements.get("tts-text").handlers.input();
    app.run('selectVoice({ ShortName: "fr-FR-DeniseNeural", Locale: "fr-FR" })');
    assert.equal(app.elements.get("tts-text").value, "Keep this text");
    assert.equal(app.run("state.selectedSample"), null);
    app.cleanup();
});

test("stopping aborts the HTTP request and prevents late playback", async () => {
    const app = createApp();
    let signal;
    let reply;
    app.context.fetch = (_, options) => new Promise(resolve => {
        signal = options.signal;
        reply = resolve;
    });
    const pending = app.run("handleSynthesizeAndPlay()");
    app.run("stopAllPlayback()");
    reply(audioResponse("zh-CN-XiaoxiaoNeural"));
    await pending;
    assert.equal(signal.aborted, true);
    assert.equal(app.run("state.lastAudioBlobUrl"), null);
    assert.equal(app.run("state.isSynthesizing"), false);
    app.cleanup();
});

test("new requests supersede late results and retain their parameter snapshot", async () => {
    const app = createApp();
    app.run("var pendingResults = []; requestSynthesis = () => new Promise(resolve => pendingResults.push(resolve));");
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

test("a synthesis service error is shown for the selected voice without fallback", async () => {
    const app = createApp();
    let systemVoiceRequested = false;
    app.context.window.speechSynthesis = { speak() { systemVoiceRequested = true; } };
    app.run('selectVoice(state.voices.find(voice => voice.ShortName === "en-US-AvaMultilingualNeural"));');
    app.context.fetch = async () => ({ ok: false, status: 502, json: async () => ({ error: "Edge connection failed" }) });
    await app.run("handleSynthesizeAndPlay()");
    assert.equal(systemVoiceRequested, false);
    assert.equal(app.run("state.selectedVoice.ShortName"), "en-US-AvaMultilingualNeural");
    assert.match(app.elements.get("status-message").textContent, /en-US-AvaMultilingualNeural.*Edge connection failed/);
    assert.equal(app.elements.get("btn-download-mp3").disabled, true);
    app.cleanup();
});

test("catalog refresh replaces an unlisted voice with the first candidate and preserves manual text", async () => {
    const app = createApp();
    app.run('selectVoice({ShortName: "zh-CN-RemovedNeural", Locale: "zh-CN", Gender: "Female"}, false);');
    const text = app.elements.get("tts-text");
    text.value = "Keep this text";
    text.handlers.input();
    app.elements.get("locale-filter").value = "zh-CN";
    app.context.fetch = async () => ({ ok: true, json: async () => [
        { ShortName: "en-US-AvaNeural", FriendlyName: "Microsoft Ava Online (Natural)", Locale: "en-US", Gender: "Female" }
    ] });
    await app.syncVoices();
    assert.equal(app.run("state.selectedVoice.ShortName"), "en-US-AvaNeural");
    assert.equal(app.run("state.filterLocale"), "ALL");
    assert.equal(app.elements.get("current-selected-badge").textContent, "en-US-AvaNeural");
    assert.ok(app.elements.get("toast-container").children.some(toast => toast.textContent.includes("missing from the refreshed catalog")));
    assert.equal(app.elements.get("tts-text").value, "Keep this text");
    app.cleanup();
});

test("catalog refresh discards malformed entries and escapes display text", async () => {
    const app = createApp();
    app.context.fetch = async () => ({ ok: true, json: async () => [
        { ShortName: "en-US-InvalidNeural", Locale: null },
        { ShortName: "en-US-AvaNeural", Locale: "en-US", FriendlyName: "<img>", VoiceTag: { ContentCategories: ["<b>", null] } }
    ] });
    await app.syncVoices();
    const list = app.elements.get("voice-list-container").innerHTML;
    assert.equal(app.run("state.voices.length"), 1);
    assert.match(list, /&lt;img&gt;/);
    assert.match(list, /&lt;b&gt;/);
    assert.equal(app.elements.get("btn-sync-voices").disabled, false);
    app.context.fetch = async () => ({ ok: true, json: async () => [null] });
    await app.syncVoices();
    assert.equal(app.run("state.voices[0].ShortName"), "en-US-AvaNeural");
    app.cleanup();
});

test("the preview sends the exact voice, text, and prosody to its same-origin API", async () => {
    const app = createApp({ pageUrl: "http://localhost:4173/ai-toybox/edge_tts/" });
    app.run('selectVoice({ ShortName: "sq-AL-AnilaNeural", Locale: "sq-AL" }); state.rate = 25; state.volume = -20; state.pitch = -100;');
    app.elements.get("tts-text").value = "Përshëndetje & <test>";
    app.context.fetch = async (url, options) => {
        assert.equal(url.href, "http://localhost:4173/ai-toybox/api/edge-tts");
        assert.equal(options.method, "POST");
        assert.deepEqual(JSON.parse(options.body), {
            text: "Përshëndetje & <test>", voice: "sq-AL-AnilaNeural", rate: "+25%", volume: "-20%", pitch: "-100Hz"
        });
        return audioResponse("sq-AL-AnilaNeural");
    };
    await app.run("handleSynthesizeAndPlay()");
    assert.equal(app.elements.get("btn-download-mp3").disabled, false);
    app.context.fetch = async () => audioResponse("en-US-AvaNeural");
    await app.run("handleSynthesizeAndPlay()");
    assert.match(app.elements.get("status-message").textContent, /invalid result for the selected voice/);
    assert.equal(app.elements.get("btn-download-mp3").disabled, true);
    app.cleanup();
});

test("a static deployment without the synthesis endpoint directs users to local Vite", async () => {
    const app = createApp();
    app.context.fetch = async url => {
        assert.equal(url.href, "http://localhost:5173/api/edge-tts");
        return { ok: false, status: 404, json: async () => { throw new SyntaxError("HTML response"); } };
    };
    await app.run("handleSynthesizeAndPlay()");
    assert.match(app.elements.get("status-message").textContent, /local Vite server/);
    app.cleanup();
});

test("switching voices cancels an in-flight synthesis", async () => {
    const app = createApp();
    let signal;
    let reply;
    app.context.fetch = (_, options) => new Promise(resolve => {
        signal = options.signal;
        reply = resolve;
    });
    const pending = app.run("handleSynthesizeAndPlay()");
    app.run('selectVoice(state.voices.find(voice => voice.ShortName === "ja-JP-NanamiNeural"))');
    reply(audioResponse("zh-CN-XiaoxiaoNeural"));
    await pending;
    assert.equal(signal.aborted, true);
    assert.match(app.elements.get("status-message").textContent, /Ready to synthesize ja-JP-NanamiNeural/);
    assert.equal(app.run("state.lastAudioBlobUrl"), null);
    app.cleanup();
});

test("autoplay rejection, pause, replay, and decode errors update playback state", async () => {
    for (const blockPlayback of [true, false]) {
        const app = createApp({ blockPlayback });
        app.context.fetch = async () => audioResponse("zh-CN-XiaoxiaoNeural");
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

test("downloads use the generated voice and media extension until the voice changes", async () => {
    const app = createApp();
    app.context.fetch = async () => audioResponse("zh-CN-XiaoxiaoNeural");
    await app.run("handleSynthesizeAndPlay()");
    app.elements.get("btn-download-mp3").click();
    assert.match(app.downloads[0].download, /^zh-CN-XiaoxiaoNeural_\d+\.mp3$/);
    app.elements.get("btn-download-vtt").click();
    assert.equal(app.downloads[1].download, "zh-CN-XiaoxiaoNeural_subtitles.vtt");
    app.run('selectVoice(state.voices.find(voice => voice.Locale === "ja-JP"))');
    assert.equal(app.elements.get("btn-download-mp3").disabled, true);
    assert.equal(app.run("state.lastAudioBlobUrl"), null);
    app.cleanup();
});

test("clearing filters resets both their state and pressed indicators", () => {
    const app = createApp();
    const gender = app.groups.get(".gender-btn");
    const categories = app.groups.get(".cat-chip");
    const active = buttons => buttons.find(button => button.getAttribute("aria-pressed") === "true");
    gender.find(button => button.getAttribute("data-gender") === "Male").click();
    categories.find(button => button.getAttribute("data-cat") === "News").click();
    const search = app.elements.get("voice-search");
    search.value = "no such voice";
    search.handlers.input({ target: search });
    app.elements.get("btn-reset-filter").click();
    assert.equal(active(gender).getAttribute("data-gender"), "ALL");
    assert.equal(active(categories).getAttribute("data-cat"), "ALL");
    assert.equal(search.value, "");
    assert.ok(app.elements.get("filtered-count").textContent > 0);
    assert.equal(app.run("state.selectedVoice.ShortName"), "zh-CN-XiaoxiaoNeural");
    app.cleanup();
});

test("every filter chooses its first visible voice and synthesis sends that voice", async () => {
    const app = createApp();
    const list = app.elements.get("voice-list-container");
    const assertFirstVoice = expected => {
        const cards = [...list.innerHTML.matchAll(/data-voice="([^"]+)" aria-pressed="([^"]+)"/g)];
        assert.deepEqual(cards[0].slice(1), [expected, "true"]);
        assert.ok(cards.slice(1).every(card => card[2] === "false"));
        assert.equal(app.elements.get("current-selected-badge").textContent, expected);
        assert.equal(app.elements.get("synthesis-voice-id").value, expected);
        assert.equal(app.run("state.selectedVoice.ShortName"), expected);
    };
    const locale = app.elements.get("locale-filter");
    locale.value = "en-US";
    locale.handlers.change({ target: locale });
    assertFirstVoice("en-US-AvaNeural");
    assert.equal(app.run("state.selectedSample"), "en");

    app.run('selectVoice(state.voices.find(voice => voice.ShortName === "en-US-EmmaNeural"))');
    const text = app.elements.get("tts-text");
    text.value = "Keep my own input.";
    text.handlers.input();
    const search = app.elements.get("voice-search");
    search.value = "en-US";
    search.handlers.input({ target: search });
    assertFirstVoice("en-US-AvaNeural");
    assert.equal(text.value, "Keep my own input.");

    app.groups.get(".gender-btn").find(button => button.getAttribute("data-gender") === "Male").click();
    assertFirstVoice("en-US-GuyNeural");
    app.groups.get(".cat-chip").find(button => button.getAttribute("data-cat") === "Multilingual").click();
    assertFirstVoice("en-US-AndrewMultilingualNeural");
    const requests = [];
    app.context.fetch = async (_, options) => {
        const { voice } = JSON.parse(options.body);
        requests.push(voice);
        return audioResponse(voice);
    };
    await app.elements.get("btn-synthesize").click();
    assert.deepEqual(requests, ["en-US-AndrewMultilingualNeural"]);
    app.cleanup();
});

test("empty results clear selection and cancel pending audio without sending another request", async () => {
    const app = createApp();
    let signal;
    let reply;
    let requests = 0;
    app.context.fetch = (_, options) => {
        requests++;
        if (requests !== 1) return Promise.resolve(audioResponse("zh-CN-XiaoxiaoNeural"));
        signal = options.signal;
        return new Promise(resolve => { reply = resolve; });
    };
    const pending = app.elements.get("btn-synthesize").click();
    const search = app.elements.get("voice-search");
    search.value = "no matching voice";
    search.handlers.input({ target: search });
    assert.equal(signal.aborted, true);
    assert.equal(app.run("state.selectedVoice"), null);
    assert.equal(app.elements.get("current-selected-badge").textContent, "No voice selected");
    assert.equal(app.elements.get("synthesis-voice-id").value, "");
    assert.equal(app.elements.get("btn-copy-voice-id").disabled, true);
    reply(audioResponse("zh-CN-XiaoxiaoNeural"));
    await pending;
    await app.elements.get("btn-synthesize").click();
    assert.equal(requests, 1);
    assert.equal(app.run("state.lastAudioBlobUrl"), null);
    assert.match(app.elements.get("status-message").textContent, /No voice matches the current filters/);
    assert.ok(app.elements.get("toast-container").children.some(toast => toast.textContent.includes("No voice matches the current filters")));
    app.elements.get("btn-download-vtt").click();
    assert.equal(app.downloads[0].download, "estimated_subtitles.vtt");
    URL.revokeObjectURL(app.downloads[0].href);
    app.cleanup();
});

test("the synthesis panel shows and copies the current voice ID", async () => {
    const app = createApp();
    const input = app.elements.get("synthesis-voice-id");
    const copyButton = app.elements.get("btn-copy-voice-id");
    const copied = [];
    app.context.window.navigator = { clipboard: { async writeText(text) { copied.push(text); } } };
    assert.equal(input.value, "zh-CN-XiaoxiaoNeural");
    app.run('selectVoice(state.voices.find(voice => voice.ShortName === "en-US-AvaNeural"))');
    assert.match(app.elements.get("synthesis-voice-name").textContent, /Ava/);
    assert.equal(input.value, "en-US-AvaNeural");
    assert.equal(copyButton.disabled, false);
    await copyButton.click();
    assert.deepEqual(copied, ["en-US-AvaNeural"]);

    let selected = false;
    input.select = () => { selected = true; };
    app.context.window.navigator.clipboard = undefined;
    await copyButton.click();
    assert.equal(selected, true);
    app.cleanup();
});

test("a delayed pause event does not replace the stopped status", async () => {
    const app = createApp();
    app.context.fetch = async () => audioResponse("zh-CN-XiaoxiaoNeural");
    await app.run("handleSynthesizeAndPlay()");
    app.run("stopAllPlayback()");
    app.elements.get("audio-player").emit("pause");
    assert.equal(app.elements.get("status-message").textContent, "Playback stopped");
    app.cleanup();
});

test("WebVTT exports input as plain cue text", async () => {
    const app = createApp();
    app.context.fetch = async () => ({ ok: true, json: async () => ({
        voice: "zh-CN-XiaoxiaoNeural", audio: "YXVkaW8=", cues: [{ offset: 0, duration: 0.2, text: "<b>one & two</b>\nthree" }]
    }) });
    await app.run("handleSynthesizeAndPlay()");
    app.elements.get("btn-download-vtt").click();
    const [{ href }] = app.downloads;
    assert.match(await (await fetch(href)).text(), /00:00:00\.000 --> 00:00:00\.001\n&lt;b&gt;one &amp; two&lt;\/b&gt; three/);
    URL.revokeObjectURL(href);
    app.cleanup();
});

test("the tool exposes only Edge cloud synthesis and media controls", () => {
    assert.doesNotMatch(html, /custom-api|api-mode-select|speechSynthesis|code-preview-content|chk-subtitles|new WebSocket|desktop Microsoft Edge|engine-status-tag|VITE_EDGE_TTS_API_URL/);
    assert.doesNotMatch(html, /<a\b[^>]*href="https:\/\/github\.com\/rany2\/edge-tts"/);
});
