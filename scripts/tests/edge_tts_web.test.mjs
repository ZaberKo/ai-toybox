import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import vm from "node:vm";

const html = readFileSync(new URL("../../edge_tts/index.html", import.meta.url), "utf8");
const source = html.match(/<script id="edge-tts-app">([\s\S]*?)<\/script>/)[1];
const chineseMessages = html.match(/<script type="application\/json" id="edge-tts-zh">([\s\S]*?)<\/script>/)[1];

function createApp({ blockPlayback = false, storedLanguage = "en" } = {}) {
    const elements = new Map();
    const groups = new Map();
    const downloads = [];
    const { promise: firstSocket, resolve: socketOpened } = Promise.withResolvers();
    let initialize;

    class FakeWebSocket {
        static CLOSING = 2;
        readyState = 0;
        sent = [];
        constructor(url) { this.url = url; socketOpened(this); }
        send(message) { this.sent.push(message); }
        close() { this.readyState = 3; }
        open() { this.readyState = 1; this.onopen(); }
        receive(data) { this.onmessage({ data }); }
    }

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
    const markup = html.slice(0, html.indexOf('<script type="application/json" id="edge-tts-zh">'));
    for (const [, tag, attributeText] of markup.matchAll(/<(button|input|textarea|select|h2|p|span)\b([^>]*)>/g)) {
        const attributes = Object.fromEntries([...attributeText.matchAll(/([\w-]+)="([^"]*)"/g)].map(value => [value[1], value[2]]));
        const item = elements.get(attributes.id) || element(tag);
        item.attributes = attributes;
        item.className = attributes.class || "";
        const selectors = Object.keys(attributes).filter(key => key.startsWith("data-i18n")).map(key => `[${key}]`);
        if (tag === "button") selectors.push(...item.className.split(" ").map(name => `.${name}`));
        for (const selector of selectors) {
            if (!groups.has(selector)) groups.set(selector, []);
            groups.get(selector).push(item);
        }
    }
    elements.get("edge-tts-zh").textContent = chineseMessages;
    elements.get("tts-text").value = html.match(/<textarea[^>]*id="tts-text"[^>]*>([\s\S]*?)<\/textarea>/)[1];
    elements.get("locale-filter").value = "ALL";
    const context = vm.createContext({
        Blob, URL, URLSearchParams, AbortController, AbortSignal, DOMException, Uint8Array, ArrayBuffer, DataView,
        TextEncoder, TextDecoder, crypto: webcrypto, WebSocket: FakeWebSocket,
        setTimeout() {}, clearTimeout() {}, requestAnimationFrame() { return 1; }, cancelAnimationFrame() {},
        window: {
            localStorage: { getItem() { return storedLanguage; }, setItem(_, value) { storedLanguage = value; } },
            addEventListener(name, handler) { if (name === "DOMContentLoaded") initialize = handler; }
        },
        document: {
            documentElement: {},
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
        context, elements, downloads, groups, run, syncVoices, firstSocket,
        mockSynthesis(handler) {
            context.testSynthesis = handler;
            run("requestSynthesis = testSynthesis");
        },
        cleanup() { run("stopAllPlayback(); clearAudioResult()"); }
    };
}

function audioResult() {
    return { blob: new Blob(["audio"], { type: "audio/mpeg" }), cues: [] };
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

test("stopping aborts the synthesis and prevents late playback", async () => {
    const app = createApp();
    let signal;
    let reply;
    app.mockSynthesis((_, voice, rate, volume, pitch, requestSignal) => new Promise(resolve => {
        signal = requestSignal;
        reply = resolve;
    }));
    const pending = app.run("handleSynthesizeAndPlay()");
    app.run("stopAllPlayback()");
    reply(audioResult());
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
    app.mockSynthesis(async () => { throw new Error("Edge connection failed"); });
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

test("the single page signs the handshake and sends the exact voice, text, and prosody to Microsoft", async () => {
    const app = createApp();
    assert.equal(await app.run("edgeHandshakeToken(1770000000000)"),
        "00DDB33FD01602D8-87C1FE6B212DC02BD1C09F05EE72850D2069A3CC92C5F462FDD6DDE2B15E8B08");
    app.run('selectVoice({ ShortName: "sq-AL-AnilaNeural", Locale: "sq-AL" }); state.rate = 25; state.volume = -20; state.pitch = -100;');
    app.elements.get("tts-text").value = "Përshëndetje & <test>";
    const pending = app.run("handleSynthesizeAndPlay()");
    const socket = await app.firstSocket;
    assert.equal(socket.url.hostname, "speech.platform.bing.com");
    assert.match(socket.url.searchParams.get("Sec-MS-GEC"), /^[A-F0-9]{16}-[A-F0-9]{64}$/);
    socket.open();
    assert.match(socket.sent[0], /audio-24khz-48kbitrate-mono-mp3/);
    assert.match(socket.sent[1], /\(sq-AL, AnilaNeural\)/);
    assert.match(socket.sent[1], /rate="\+25%" volume="-20%" pitch="-100Hz"/);
    assert.match(socket.sent[1], /Përshëndetje &amp; &lt;test&gt;/);
    const header = new TextEncoder().encode("Path:audio\r\nContent-Type:audio/mpeg\r\n");
    const frame = new Uint8Array(2 + header.length + 4);
    new DataView(frame.buffer).setUint16(0, header.length);
    frame.set(header, 2);
    socket.receive(frame.buffer);
    socket.receive("Path:turn.end\r\n\r\n");
    await pending;
    assert.equal(socket.readyState, 3);
    assert.equal(app.elements.get("btn-download-mp3").disabled, false);
    app.cleanup();
});

test("connection errors distinguish failed handshakes from interrupted synthesis", async () => {
    for (const [connected, message] of [
        [false, /Could not establish a browser connection/],
        [true, /closed the connection before synthesis finished/]
    ]) {
        const app = createApp();
        const pending = app.run("handleSynthesizeAndPlay()");
        const socket = await app.firstSocket;
        if (connected) socket.open();
        socket.onerror();
        await pending;
        assert.equal(socket.readyState, 3);
        assert.match(app.elements.get("status-message").textContent, message);
        assert.equal(app.elements.get("btn-download-mp3").disabled, true);
        app.cleanup();
    }
});

test("switching voices cancels an in-flight synthesis", async () => {
    const app = createApp();
    let signal;
    let reply;
    app.mockSynthesis((_, voice, rate, volume, pitch, requestSignal) => new Promise(resolve => {
        signal = requestSignal;
        reply = resolve;
    }));
    const pending = app.run("handleSynthesizeAndPlay()");
    app.run('selectVoice(state.voices.find(voice => voice.ShortName === "ja-JP-NanamiNeural"))');
    reply(audioResult());
    await pending;
    assert.equal(signal.aborted, true);
    assert.match(app.elements.get("status-message").textContent, /Ready to synthesize ja-JP-NanamiNeural/);
    assert.equal(app.run("state.lastAudioBlobUrl"), null);
    app.cleanup();
});

test("autoplay rejection, pause, replay, and decode errors update playback state", async () => {
    for (const blockPlayback of [true, false]) {
        const app = createApp({ blockPlayback });
        app.mockSynthesis(async () => audioResult());
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
    app.mockSynthesis(async () => audioResult());
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
    app.mockSynthesis(async (_, voice) => {
        requests.push(voice);
        return audioResult();
    });
    await app.elements.get("btn-synthesize").click();
    assert.deepEqual(requests, ["en-US-AndrewMultilingualNeural"]);
    app.cleanup();
});

test("empty results clear selection and cancel pending audio without sending another request", async () => {
    const app = createApp();
    let signal;
    let reply;
    let requests = 0;
    app.mockSynthesis((_, voice, rate, volume, pitch, requestSignal) => {
        requests++;
        if (requests !== 1) return Promise.resolve(audioResult());
        signal = requestSignal;
        return new Promise(resolve => { reply = resolve; });
    });
    const pending = app.elements.get("btn-synthesize").click();
    const search = app.elements.get("voice-search");
    search.value = "no matching voice";
    search.handlers.input({ target: search });
    assert.equal(signal.aborted, true);
    assert.equal(app.run("state.selectedVoice"), null);
    assert.equal(app.elements.get("current-selected-badge").textContent, "No voice selected");
    assert.equal(app.elements.get("synthesis-voice-id").value, "");
    assert.equal(app.elements.get("btn-copy-voice-id").disabled, true);
    reply(audioResult());
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

test("the interface defaults to Chinese and switching languages keeps the synthesis state", async () => {
    const app = createApp({ storedLanguage: null });
    const language = app.elements.get("ui-language");
    const search = app.elements.get("voice-search");
    const text = app.elements.get("tts-text");
    assert.equal(app.context.document.documentElement.lang, "zh-CN");
    assert.equal(search.getAttribute("aria-label"), "搜索音色");
    assert.match(app.elements.get("status-message").textContent, /就绪/);

    search.value = "英语";
    search.handlers.input({ target: search });
    text.value = "Keep this text.";
    text.handlers.input();
    const voice = app.run("state.selectedVoice.ShortName");
    assert.equal(voice, "en-US-AvaNeural");
    app.mockSynthesis(async () => { throw new Error("The Microsoft speech service returned no audio."); });
    await app.elements.get("btn-synthesize").click();
    assert.match(app.elements.get("status-message").textContent, /微软语音服务没有返回音频/);

    language.value = "en";
    language.handlers.change({ target: language });
    assert.equal(app.context.document.documentElement.lang, "en");
    assert.equal(app.context.window.localStorage.getItem(), "en");
    assert.equal(search.getAttribute("aria-label"), "Search voices");
    assert.equal(search.value, "英语");
    assert.equal(text.value, "Keep this text.");
    assert.equal(app.run("state.selectedVoice.ShortName"), voice);
    assert.equal(app.elements.get("char-counter").textContent, "15 characters");
    assert.match(app.elements.get("status-message").textContent, /Synthesis failed for en-US-AvaNeural\. The Microsoft speech service/);
    assert.match(app.elements.get("toast-container").children.at(-1).textContent, /Synthesis failed for/);
    app.cleanup();
});

test("a delayed pause event does not replace the stopped status", async () => {
    const app = createApp();
    app.mockSynthesis(async () => audioResult());
    await app.run("handleSynthesizeAndPlay()");
    app.run("stopAllPlayback()");
    app.elements.get("audio-player").emit("pause");
    assert.equal(app.elements.get("status-message").textContent, "Playback stopped");
    app.cleanup();
});

test("WebVTT exports input as plain cue text", async () => {
    const app = createApp();
    app.mockSynthesis(async () => ({
        ...audioResult(), cues: [{ offset: 0, duration: 0.2, text: "<b>one & two</b>\nthree" }]
    }));
    await app.run("handleSynthesizeAndPlay()");
    app.elements.get("btn-download-vtt").click();
    const [{ href }] = app.downloads;
    assert.match(await (await fetch(href)).text(), /00:00:00\.000 --> 00:00:00\.001\n&lt;b&gt;one &amp; two&lt;\/b&gt; three/);
    URL.revokeObjectURL(href);
    app.cleanup();
});

test("the tool exposes only Edge cloud synthesis and media controls", () => {
    assert.doesNotMatch(html, /custom-api|api-mode-select|speechSynthesis|code-preview-content|chk-subtitles|desktop Microsoft Edge|engine-status-tag|VITE_EDGE_TTS_API_URL|\/api\/edge-tts/);
    assert.doesNotMatch(html, /<a\b[^>]*href="https:\/\/github\.com\/rany2\/edge-tts"/);
});
