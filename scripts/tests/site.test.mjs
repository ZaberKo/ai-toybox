import assert from "node:assert/strict";
import { build } from "vite";
import { test } from "vitest";
import routes from "../../routes.json" with { type: "json" };

test("Vite emits every registered tool at its GitHub Pages URL", async () => {
    const { output } = await build({ logLevel: "silent", build: { write: false } });
    const files = new Map(output.map(asset => [asset.fileName, asset.source]));
    const homepage = files.get("index.html");
    assert.ok(homepage);
    assert.doesNotMatch(homepage, /<!-- TOOL_/);

    for (const [route, entry] of Object.entries(routes)) {
        assert.ok(files.has(entry), `Missing page for ${route}`);
        assert.ok(homepage.includes(`href="${route}/"`), `Missing homepage link for ${route}`);
    }

    const stylesheet = homepage.match(/href="\/ai-toybox\/(assets\/[^"]+\.css)"/)?.[1];
    assert.ok(stylesheet && files.has(stylesheet), "The homepage stylesheet must resolve under the Pages base path");
    assert.match(files.get("404.html"), /id="home" href="\/ai-toybox\/"/);
    assert.deepEqual(JSON.parse(files.get("routes.json")), routes);
});
