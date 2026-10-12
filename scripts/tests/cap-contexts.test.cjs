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
        { module, exports: module.exports, require: (name) => imports[name] ?? require(name), Buffer, Date, JSON, Array, Promise, console: { log() {} } },
    );
    return module.exports;
};

const signals = load("src/api/util/utility/automationSignals.ts", {});
const instrumentedToken = `x.${Buffer.from(JSON.stringify({ ei: "sealed" })).toString("base64url")}.y`;
const plainToken = `x.${Buffer.from(JSON.stringify({ n: 1 })).toString("base64url")}.y`;
const browser = {
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    uaDataPresent: true,
    uaData: { brands: ["Chromium/141"], mobile: false },
    outerWH: [1440, 900],
    webdriver: false,
    fx: { gl: "Apple M3", pl: 5, mt: 2, ch: "object", np: "default", nq: "prompt" },
};

const harness = (captcha = {}) => {
    const generated = [];
    const stored = [];
    const exports = load("src/api/util/utility/localCap.ts", {
        "@spacebar/database/Sql": { sqlReturning: (sql) => sql },
        "@spacebar/database": {
            RateLimit: {
                query: async (sql, parameters) => {
                    if (sql.startsWith("INSERT INTO rate_limits (id, executor_id, hits, blocked, expires_at) VALUES ($1, 'cap', 0, false, $2)") && !sql.includes("RETURNING"))
                        stored.push(parameters[0]);
                    return [{ id: parameters[0] }];
                },
            },
        },
        "@spacebar/util": {
            Config: {
                get: () => ({
                    security: {
                        requestSignature: "secret",
                        captcha: {
                            challenges: {
                                register: { count: 64, size: 32, difficulty: 5 },
                                login: { count: 16, size: 32, difficulty: 5 },
                                passwordReset: { count: 900, size: 2, difficulty: 3.5 },
                            },
                            ...captcha,
                        },
                    },
                }),
            },
        },
        "capjs-core": {
            generateChallenge: async (key, options) => {
                generated.push(options);
                return {
                    challenge: { c: options.challengeCount, s: options.challengeSize, d: options.challengeDifficulty },
                    token: "challenge",
                    expires: 1,
                    instrumentation: zlib.deflateRawSync(Buffer.from("parent.postMessage({},'*')")).toString("base64"),
                };
            },
            validateChallenge: async () => ({ success: true, token: "redeemed", expires: Date.now() + 60_000 }),
        },
        "./automationSignals": signals,
    });
    return { ...exports, generated, stored };
};

test("each captcha place has its own work with bounds and defaults", () => {
    const cap = harness();
    assert.deepEqual(JSON.parse(JSON.stringify(cap.capChallengeParameters("register"))), { challengeCount: 64, challengeSize: 32, challengeDifficulty: 5 });
    assert.deepEqual(JSON.parse(JSON.stringify(cap.capChallengeParameters("login"))), { challengeCount: 16, challengeSize: 32, challengeDifficulty: 5 });
    assert.deepEqual(JSON.parse(JSON.stringify(cap.capChallengeParameters("password_reset"))), { challengeCount: 500, challengeSize: 16, challengeDifficulty: 5 });
    assert.deepEqual(JSON.parse(JSON.stringify(harness({ challenges: undefined }).capChallengeParameters("login"))), {
        challengeCount: 64,
        challengeSize: 32,
        challengeDifficulty: 5,
    });
    assert.equal(cap.isCapContext("login"), true);
    assert.equal(cap.isCapContext("__proto__"), false);
});

test("challenges use a scope per place and only wrap instrumentation while blocking", async () => {
    const blocking = harness();
    const challenge = await blocking.createRegistrationChallenge("password_reset");
    assert.equal(blocking.generated[0].scope, "fosscord-password-reset");
    assert.equal(blocking.generated[0].instrumentation.blockAutomatedBrowsers, true);
    assert.ok(zlib.inflateRawSync(Buffer.from(challenge.instrumentation, "base64")).toString().startsWith("(function(parent){"));
    const open = harness({ blockAutomatedBrowsers: false });
    const plain = await open.createRegistrationChallenge();
    assert.equal(open.generated[0].scope, "fosscord-registration");
    assert.equal(open.generated[0].instrumentation.blockAutomatedBrowsers, false);
    assert.equal(zlib.inflateRawSync(Buffer.from(plain.instrumentation, "base64")).toString(), "parent.postMessage({},'*')");
});

test("an automated browser's solve is refused while blocking is on", async () => {
    const cap = harness();
    const refused = await cap.redeemRegistrationChallenge({ token: instrumentedToken, solutions: [1], instr: { p: { ...browser, webdriver: true } } }, "login");
    assert.deepEqual(JSON.parse(JSON.stringify(refused)), { success: false, reason: "automated_browser" });
    const stripped = await cap.redeemRegistrationChallenge({ token: instrumentedToken, solutions: [1], instr: { p: { ...browser, fx: undefined } } });
    assert.equal(stripped.reason, "automated_browser");
    assert.equal(cap.stored.length, 0);
    const accepted = await cap.redeemRegistrationChallenge({ token: instrumentedToken, solutions: [1], instr: { p: browser } }, "login");
    assert.equal(accepted.success, true);
    assert.match(cap.stored[0], /^cap-token:login:[0-9a-f]{64}$/);
});

test("the same solve is accepted when blocking is off or the challenge had no instrumentation", async () => {
    const open = harness({ blockAutomatedBrowsers: false });
    assert.equal((await open.redeemRegistrationChallenge({ token: instrumentedToken, solutions: [1], instr: { p: { ...browser, webdriver: true } } })).success, true);
    assert.match(open.stored[0], /^cap-token:[0-9a-f]{64}$/);
    const blocking = harness();
    assert.equal((await blocking.redeemRegistrationChallenge({ token: plainToken, solutions: [1] })).success, true);
});
