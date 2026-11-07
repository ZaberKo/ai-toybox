import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { test, vi } from "vitest";
import { createEdgeTtsApi } from "../../vite.config.js";

const upstream = vi.hoisted(() => ({ calls: [] }));

vi.mock("msedge-tts", () => ({
    OUTPUT_FORMAT: { AUDIO_24KHZ_48KBITRATE_MONO_MP3: "mp3" },
    MsEdgeTTS: class {
        async setMetadata(voice, format, options) {
            this.request = { voice, format, options };
        }

        toStream(text, prosody) {
            upstream.calls.push({ ...this.request, text, prosody });
            return {
                audioStream: Readable.from([Buffer.alloc(6000)]),
                metadataStream: Readable.from([Buffer.from(JSON.stringify({ Metadata: [
                    { Type: "WordBoundary", Data: { Offset: 100000, Duration: 50000, text: { Text: "word" } } }
                ] }))])
            };
        }

        close() {}
    }
}));

const input = { voice: "sq-AL-AnilaNeural", rate: "+25%", volume: "-20%", pitch: "-10Hz", text: "Përshëndetje" };

async function call(api, { method = "POST", origin, body = JSON.stringify(input) } = {}) {
    const request = Object.assign(Readable.from([Buffer.from(body)]), {
        method, url: "/api/edge-tts", headers: { host: "tts.example.com", origin, "content-type": "application/json" }, socket: {}
    });
    const headers = {};
    const response = Object.assign(new EventEmitter(), {
        setHeader(name, value) { headers[name] = value; },
        writeHead(status, values) { this.status = status; Object.assign(headers, values); },
        end(data) { this.body = data && JSON.parse(data); }
    });
    await api(request, response, () => assert.fail("Unexpected route"));
    return { status: response.status, body: response.body, headers };
}

test("the API escapes and chunks text, preserving the exact voice and subtitle offsets", async () => {
    const text = "😀&".repeat(500);
    const result = await call(createEdgeTtsApi(), { body: JSON.stringify({ ...input, text }) });
    assert.equal(result.status, 200);
    assert.equal(result.body.voice, input.voice);
    assert.equal(Buffer.from(result.body.audio, "base64").length, 12000);
    assert.deepEqual(result.body.cues.map(cue => cue.offset), [10, 1010]);
    assert.equal(upstream.calls.length, 2);
    for (const call of upstream.calls) {
        assert.equal(call.voice, input.voice);
        assert.deepEqual(call.prosody, { rate: input.rate, volume: input.volume, pitch: input.pitch });
        assert.equal(call.options.wordBoundaryEnabled, true);
        assert.ok(Buffer.byteLength(call.text) <= 4096);
        assert.doesNotMatch(call.text, /&(?!amp;)|[\uD800-\uDFFF]/u);
    }
    assert.equal(upstream.calls.map(call => call.text).join(""), text.replaceAll("&", "&amp;"));
});

test("the local API rejects cross-origin, invalid, and oversized requests", async () => {
    const api = createEdgeTtsApi();
    assert.equal((await call(api, { origin: "https://unrelated.example" })).status, 403);
    assert.equal((await call(api, { method: "GET", origin: "http://tts.example.com" })).status, 405);
    assert.equal((await call(api, { body: "{" })).status, 400);
    assert.equal((await call(api, { body: JSON.stringify({ ...input, pitch: "+101Hz" }) })).status, 400);
    assert.equal((await call(api, { body: "x".repeat(65537) })).status, 413);
});
