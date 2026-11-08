import assert from "node:assert/strict";
import { build } from "vite";
import { test } from "vitest";

test("Vite emits the keyboard and speech tools at their GitHub Pages URLs", async () => {
    const { output } = await build({ logLevel: "silent", build: { write: false } });
    const files = new Map(output.map(asset => [asset.fileName, asset.source]));
    const homepage = files.get("index.html");
    assert.ok(homepage);
    assert.doesNotMatch(homepage, /<!-- TOOL_/);

    for (const route of ["keyboard_test", "edge_tts"]) {
        assert.ok(files.has(`${route}/index.html`), `Missing page for ${route}`);
        assert.ok(homepage.includes(`href="${route}/"`), `Missing homepage link for ${route}`);
    }

    const stylesheet = homepage.match(/href="\/ai-toybox\/(assets\/[^"]+\.css)"/)?.[1];
    assert.ok(stylesheet && files.has(stylesheet), "The homepage stylesheet must resolve under the Pages base path");
    assert.match(files.get("404.html"), /id="home" href="\/ai-toybox\/"/);
    const edgeTool = files.get("edge_tts/index.html");
    assert.match(edgeTool, /<script id="edge-tts-app">/);
    assert.doesNotMatch(edgeTool, /<script[^>]+src="\/ai-toybox\//, "The speech tool should keep its JavaScript inline");
});
