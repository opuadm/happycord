const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const zlib = require("node:zlib");
const ts = require("typescript");

const load = (file, imports) => {
    const module = { exports: {} };
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync(file, "utf8"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
        }).outputText,
        { module, exports: module.exports, require: (name) => imports[name] ?? require(name), Buffer, JSON, Array, Promise },
    );
    return module.exports;
};

const signals = load("src/api/util/utility/automationSignals.ts", {});
const plain = (value) => JSON.parse(JSON.stringify(value));
const reasons = (probe) => plain(signals.judgeAutomation(probe).reasons);

const desktopChrome = {
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    uaDataPresent: true,
    uaData: { brands: ["Chromium/141", "Brave/141"], mobile: false },
    outerWH: [1440, 900],
    webdriver: false,
    fx: { gl: "ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)", pl: 5, mt: 2, ch: "object", np: "denied", nq: "denied" },
};
const probe = (overrides = {}, fx = {}) => ({ ...desktopChrome, ...overrides, fx: { ...desktopChrome.fx, ...fx } });

test("a normal desktop browser passes", () => {
    assert.deepEqual(JSON.parse(JSON.stringify(signals.judgeAutomation(probe()))), { automated: false, reasons: [] });
});

test("one strong signal is enough to refuse", () => {
    assert.deepEqual(reasons(probe({ webdriver: true })), ["webdriver"]);
    assert.equal(signals.judgeAutomation(probe({ webdriver: true })).automated, true);
    assert.equal(signals.judgeAutomation(probe({ ua: desktopChrome.ua.replace("Chrome/", "HeadlessChrome/") })).automated, true);
    assert.equal(signals.judgeAutomation(probe({ uaData: { brands: ["HeadlessChrome/141"], mobile: false } })).automated, true);
    assert.deepEqual(reasons(probe({ outerWH: [0, 0] })), ["zero_window"]);
});

test("a single weak signal passes and two refuse", () => {
    const software = signals.judgeAutomation(probe({}, { gl: "Google SwiftShader" }));
    assert.equal(software.automated, false);
    assert.deepEqual(plain(software.reasons), ["software_renderer"]);
    const two = signals.judgeAutomation(probe({}, { gl: "llvmpipe (LLVM 15.0.7, 256 bits)", ch: "undefined" }));
    assert.equal(two.automated, true);
    assert.deepEqual(plain(two.reasons), ["software_renderer", "missing_chrome_object"]);
    assert.equal(signals.judgeAutomation(probe({}, { pl: 0, mt: 0, np: "denied", nq: "prompt" })).automated, true);
});

test("chromium-only checks skip other engines and phones", () => {
    const firefox = probe({ uaDataPresent: false, uaData: null, ua: "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0" }, { pl: 0, mt: 0, ch: "undefined" });
    assert.equal(signals.judgeAutomation(firefox).automated, false);
    const phone = probe({ uaData: { brands: ["Chromium/141"], mobile: true } }, { pl: 0, mt: 0, ch: "undefined" });
    assert.equal(signals.judgeAutomation(phone).automated, false);
});

test("missing extra signals count as automated so a client can't strip them", () => {
    assert.deepEqual(reasons({ ...desktopChrome, fx: undefined }), ["signals_missing"]);
    assert.deepEqual(reasons(null), ["signals_missing"]);
    assert.deepEqual(reasons({ ...desktopChrome, fx: [] }), ["signals_missing"]);
});

test("the wrapped instrumentation keeps the original script and adds the collector", () => {
    const original = "parent.postMessage({type:'cap:instr',result:{i:1,state:{},p:{ua:navigator.userAgent}}},'*');";
    const wrapped = zlib.inflateRawSync(Buffer.from(signals.withAutomationSignals(zlib.deflateRawSync(Buffer.from(original)).toString("base64")), "base64")).toString("utf8");
    assert.ok(wrapped.startsWith("(function(parent){"));
    assert.ok(wrapped.includes(original));
    assert.ok(wrapped.includes("WEBGL_debug_renderer_info"));
    assert.ok(wrapped.includes("m.result.p.fx=x"));
});

test("the wrapped script relays the probe with the extra signals attached", async () => {
    const original = "parent.postMessage({type:'cap:instr',result:{i:1,state:{},p:{ua:'test'}}},'*');";
    const source = zlib.inflateRawSync(Buffer.from(signals.withAutomationSignals(zlib.deflateRawSync(Buffer.from(original)).toString("base64")), "base64")).toString("utf8");
    const posted = [];
    const sandbox = {
        document: { createElement: () => ({ getContext: () => null }) },
        navigator: { plugins: { length: 3 }, mimeTypes: { length: 2 }, permissions: { query: async () => ({ state: "granted" }) } },
        Notification: { permission: "granted" },
        Promise,
        setTimeout,
    };
    sandbox.window = { chrome: {}, parent: { postMessage: (message) => posted.push(message) } };
    vm.runInNewContext(source, sandbox);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(posted.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(posted[0].result.p)), { ua: "test", fx: { gl: null, pl: 3, mt: 2, ch: "object", np: "granted", nq: "granted" } });
});

test("tokens report whether the challenge carried instrumentation", () => {
    const token = (payload) => `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.y`;
    assert.equal(signals.tokenHasInstrumentation(token({ ei: "abc" })), true);
    assert.equal(signals.tokenHasInstrumentation(token({ n: 1 })), false);
    assert.equal(signals.tokenHasInstrumentation("not-a-token"), false);
    assert.equal(signals.tokenHasInstrumentation("x.%%%.y"), false);
    assert.equal(signals.tokenHasInstrumentation(undefined), false);
});
