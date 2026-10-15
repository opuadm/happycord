/* SPDX-License-Identifier: AGPL-3.0-only */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { StubError, loadRoutes, response } = require("./helpers/route-harness.cjs");

function forgotRoute(users, sendResetPassword) {
    const sent = [];
    const delays = [];
    const routes = loadRoutes(
        "src/api/routes/auth/forgot.ts",
        {
            "@spacebar/api/util": { captchaKeyFrom: () => undefined, checkCaptcha: async () => null },
            "@spacebar/database": {
                User: {
                    loginWhere: (login) => login,
                    findOne: async ({ where }) => {
                        const user = users[where];
                        return user ? { ...user, tag: `${user.username}#0000` } : null;
                    },
                },
            },
            "@spacebar/util": {
                Config: { get: () => ({ passwordReset: { requireCaptcha: false } }) },
                Email: {
                    sendResetPassword:
                        sendResetPassword ??
                        (async (user, email) => {
                            sent.push({ id: user.id, email });
                        }),
                },
                FieldErrors: (fields) => new StubError(JSON.stringify(fields)),
            },
            "@spacebar/schemas": {},
        },
        {
            setTimeout: (resolve, ms) => {
                delays.push(ms);
                resolve();
            },
        },
    );
    const call = async (login) => {
        const res = response();
        await routes["POST /"]({ body: { login }, t: (key) => key }, res);
        await new Promise((resolve) => setImmediate(resolve));
        return { status: res.statusCode, body: JSON.parse(JSON.stringify(res.body)) };
    };
    return { call, sent, delays };
}

test("forgot password answers the same for known, unknown, disabled and deleted accounts", async () => {
    const { call, sent, delays } = forgotRoute({
        "known@example.com": { id: "1", username: "known", email: "known@example.com", deleted: false },
        "disabled@example.com": { id: "2", username: "disabled", email: "disabled@example.com", deleted: false, disabled: true },
        "deleted@example.com": { id: "3", username: "deleted", email: "deleted@example.com", deleted: true },
        noemail: { id: "4", username: "noemail", email: null, deleted: false },
    });
    const answers = [];
    for (const login of ["known@example.com", "unknown@example.com", "disabled@example.com", "deleted@example.com", "noemail"]) answers.push(await call(login));
    for (const answer of answers) assert.deepEqual(answer, { status: 200, body: { method: "password_reset" } });
    assert.deepEqual(
        sent.map((mail) => mail.id),
        ["1", "2"],
    );
    assert.equal(delays.length, answers.length);
    for (const delay of delays) assert.ok(delay > 300 && delay <= 400, `waits until at least 400 ms after the lookup started, got ${delay}`);
});

test("forgot password answers without waiting for the reset email to be delivered", async () => {
    const { call } = forgotRoute({ "slow@example.com": { id: "1", username: "slow", email: "slow@example.com", deleted: false } }, () => new Promise(() => undefined));
    assert.deepEqual(await call("slow@example.com"), { status: 200, body: { method: "password_reset" } });
});
