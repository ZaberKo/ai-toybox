import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import vm from "node:vm";

const html = readFileSync(new URL("../../keyboard_test/index.html", import.meta.url), "utf8");
const source = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].at(-1)[1];

function createApp() {
    const elements = new Map();
    const keys = new Map();
    const handlers = new Map();
    const frames = new Map();
    let frameId = 0;
    let activeElement;
    function element(kind = "div") {
        const classes = new Set();
        return {
            kind, style: {}, innerHTML: "", textContent: "", className: "", value: "", handlers: {}, children: [],
            classList: {
                add(...names) { names.forEach(name => classes.add(name)); },
                remove(...names) { names.forEach(name => classes.delete(name)); },
                toggle(name, enabled) { if (enabled ?? !classes.has(name)) classes.add(name); else classes.delete(name); },
                contains(name) { return classes.has(name); }
            },
            addEventListener(name, handler) { this.handlers[name] = handler; },
            matches(selector) { return selector.split(",").some(value => value.trim() === this.kind || (this.kind === "range" && ["input", "input[type=range]"].includes(value.trim()))); },
            closest(selector) { return this.matches(selector) ? this : null; },
            focus() { activeElement = this; },
            blur() { activeElement = body; },
            insertAdjacentHTML(position, content) { this.innerHTML = content + this.innerHTML; },
            cloneNode() { return { innerText: this.textContent, querySelectorAll() { return []; } }; }
        };
    }
    const body = element("body");
    activeElement = body;
    for (const match of html.matchAll(/\bid="([^"]+)"/g)) elements.set(match[1], element());
    elements.get("threshold").kind = "range";
    elements.get("threshold").value = "40";
    for (const id of ["reset-btn", "theme-btn", "lang-toggle"]) elements.get(id).kind = "button";
    for (const match of html.matchAll(/data-code="([^"]+)"/g)) {
        const key = element();
        key.textContent = match[1];
        keys.set(match[1], key);
    }
    const context = vm.createContext({
        performance: { now() { return 0; } },
        requestAnimationFrame(callback) { frames.set(++frameId, callback); return frameId; },
        cancelAnimationFrame(id) { frames.delete(id); },
        window: { addEventListener(name, handler) { handlers.set(name, handler); } },
        document: {
            body, documentElement: element(), getElementById(id) { return elements.get(id); },
            querySelector(selector) { return keys.get(selector.match(/data-code="([^"]+)"/)?.[1]) || null; },
            querySelectorAll(selector) {
                if (selector === ".k-key") return [...keys.values()];
                if (selector === ".k-key.active") return [...keys.values()].filter(key => key.classList.contains("active"));
                return [];
            }
        }
    });
    vm.runInContext(source, context);
    return {
        elements, keys, frames, body,
        run(code) { return vm.runInContext(code, context); },
        event(name, code, timeStamp, options = {}) {
            const event = { code, timeStamp, target: activeElement, repeat: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...options };
            handlers.get(name)(event);
            return event;
        },
        flush() { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); },
        blur() { handlers.get("blur")(); },
        get activeElement() { return activeElement; }
    };
}

test("reset removes old rows and restores the empty state on every run", () => {
    const app = createApp();
    for (let run = 0; run < 2; run++) {
        app.event("keydown", "KeyA", 100);
        app.flush();
        assert.match(app.elements.get("stats-container").innerHTML, /KeyA/);
        app.elements.get("reset-btn").handlers.click();
        assert.equal(app.run("Object.keys(keyStats).length"), 0);
        assert.equal(app.run("hasStarted"), false);
        assert.match(app.elements.get("stats-container").innerHTML, /id="empty-stats"/);
        assert.doesNotMatch(app.elements.get("stats-container").innerHTML, /KeyA/);
    }
});

test("release bounce after a held key is counted while typematic repeats are ignored", () => {
    const app = createApp();
    app.event("keydown", "KeyA", 0);
    app.event("keydown", "KeyA", 300, { repeat: true });
    app.event("keyup", "KeyA", 400);
    app.event("keydown", "KeyA", 410);
    assert.equal(app.run("keyStats.KeyA.count"), 2);
    assert.equal(app.run("keyStats.KeyA.errors"), 1);
    assert.equal(app.run("keyStats.KeyA.minDiff"), 10);
    assert.equal(app.keys.get("KeyA").classList.contains("error-flagged"), true);
});

test("ordinary repeated presses remain healthy and keys are tracked independently", () => {
    const app = createApp();
    app.event("keydown", "KeyA", 10);
    app.event("keyup", "KeyA", 200);
    app.event("keydown", "KeyB", 210);
    app.event("keyup", "KeyB", 230);
    app.event("keydown", "KeyA", 300);
    assert.equal(app.run("keyStats.KeyA.errors"), 0);
    assert.equal(app.run("keyStats.KeyA.minDiff"), 100);
    assert.equal(app.run("keyStats.KeyB.count"), 1);
});

test("reset cancels queued rendering and clears active and fault markers", () => {
    const app = createApp();
    app.event("keydown", "KeyA", 10);
    app.event("keydown", "KeyA", 20);
    assert.equal(app.frames.size, 1);
    app.elements.get("reset-btn").handlers.click();
    assert.equal(app.frames.size, 0);
    assert.equal(app.keys.get("KeyA").classList.contains("active"), false);
    assert.equal(app.keys.get("KeyA").classList.contains("error-flagged"), false);
    assert.match(app.elements.get("stats-container").innerHTML, /id="empty-stats"/);
});

test("controls retain their native navigation and activation keys", () => {
    const app = createApp();
    const slider = app.elements.get("threshold");
    for (const code of ["ArrowRight", "ArrowLeft", "Home", "End", "Tab"]) {
        const event = app.event("keydown", code, 10, { target: slider });
        assert.equal(event.defaultPrevented, false);
    }
    for (const code of ["Enter", "Space"]) {
        assert.equal(app.event("keydown", code, 20, { target: app.elements.get("reset-btn") }).defaultPrevented, false);
    }
    assert.equal(app.run("Object.keys(keyStats).length"), 0);
    app.event("keydown", "KeyA", 50, { target: app.elements.get("reset-btn") });
    assert.equal(app.run("keyStats.KeyA.count"), 1);
});

test("Tab can be tested in the focused keyboard area and Escape releases focus", () => {
    const app = createApp();
    assert.equal(app.event("keydown", "Tab", 10).defaultPrevented, false);
    const area = app.elements.get("keyboard-container");
    area.handlers.click();
    assert.equal(app.activeElement, area);
    assert.equal(app.event("keydown", "Tab", 20).defaultPrevented, true);
    assert.equal(app.run("keyStats.Tab.count"), 1);
    app.event("keydown", "Escape", 30);
    assert.equal(app.activeElement, app.body);
    assert.equal(app.event("keydown", "Tab", 40).defaultPrevented, false);
});

test("window blur clears timing continuity to prevent false bounce detections", () => {
    const app = createApp();
    app.event("keydown", "KeyA", 10);
    app.event("keyup", "KeyA", 20);
    app.blur();
    app.event("keydown", "KeyA", 30);
    assert.equal(app.run("keyStats.KeyA.errors"), 0);
    assert.equal(app.keys.get("KeyA").classList.contains("active"), true);
});

test("language changes preserve the empty-state renderer and refresh populated rows", () => {
    const app = createApp();
    app.run('currentLang = "en"; updateLanguage()');
    assert.match(app.elements.get("stats-container").innerHTML, /Type anywhere/);
    app.event("keydown", "KeyA", 10);
    app.flush();
    app.run('currentLang = "zh"; updateLanguage()');
    assert.match(app.elements.get("stats-container").innerHTML, /KeyA/);
});
