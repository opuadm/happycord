/* SPDX-License-Identifier: AGPL-3.0-only */
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { solveCap } from "./cap-token.mjs";

const origin = `http://localhost:${process.env.PORT || 3001}`;
const api = `${origin}/api/v9`;
const DEFAULT_RIGHTS = 875069521787904n;
const MANAGE_USERS = 1n << 7n;
const results = [];

const request = async (method, url, token, body) => {
    const res = await fetch(`${api}${url}`, {
        method,
        headers: { ...(body !== undefined && { "content-type": "application/json" }), ...(token && { authorization: token }) },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
        json = text ? JSON.parse(text) : null;
    } catch {
        json = null;
    }
    return { status: res.status, json, text };
};

const must = async (method, url, token, body) => {
    const res = await request(method, url, token, body);
    if (res.status >= 300) throw new Error(`${method} ${url} returned HTTP ${res.status}: ${res.text.slice(0, 200)}`);
    return res.json;
};

const expect = async (name, method, url, token, body, status) => {
    const expected = Array.isArray(status) ? status : [status];
    try {
        const res = await request(method, url, token, body);
        const pass = expected.includes(res.status);
        results.push({ name, pass, detail: pass ? "" : `HTTP ${res.status}, wanted ${expected.join(" or ")}: ${res.text.slice(0, 160)}` });
        return res;
    } catch (error) {
        results.push({ name, pass: false, detail: error.message });
        return { status: 0, json: null, text: "" };
    }
};

const check = (name, pass, detail = "") => results.push({ name, pass: Boolean(pass), detail: pass ? "" : detail });

const playwright = createRequire(path.join(homedir(), ".cache/fosscord-tools/package.json"))("playwright-core");
const browser = await playwright.chromium.launch({
    executablePath: process.env.CHROME_PATH || "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    headless: true,
});

const register = async (label) => {
    const username = `${label}_${randomBytes(3).toString("hex")}`;
    const { token } = await must("POST", "/auth/register", null, {
        email: `${username}@staff-probe.test`,
        username,
        password: randomBytes(12).toString("hex"),
        date_of_birth: "2000-01-01",
        consent: true,
        captcha_key: await solveCap({ origin, browser }),
    });
    const user = await must("GET", "/users/@me", token);
    return { token, id: user.id, username };
};

const accounts = {};
try {
    for (const label of ["op", "admin", "mod", "mod2", "support", "audit", "member", "legacy"]) accounts[label] = await register(label);
} finally {
    await browser.close();
}
const { op, admin, mod, mod2, support, audit, member, legacy } = accounts;

const grant = Bun.spawnSync(["bun", "scripts/ops/operator.mjs", "grant", op.id], { stdout: "pipe", stderr: "pipe" });
if (grant.exitCode !== 0) throw new Error(`operator grant failed: ${grant.stderr.toString()}`);

const guild = await must("POST", "/guilds", member.token, { name: "staff probe" });
const channels = await must("GET", `/guilds/${guild.id}/channels`, member.token);
const text = channels.find((channel) => channel.type === 0);
const message = await must("POST", `/channels/${text.id}/messages`, member.token, { content: "remove me" });
const adminMessage = await must("POST", `/channels/${text.id}/messages`, member.token, { content: "second" });

const roleList = await must("GET", "/admin/staff/roles", op.token);
const byName = Object.fromEntries(roleList.roles.map((role) => [role.name, role]));
check(
    "the four default roles are seeded with descending positions",
    byName.Admin &&
        byName.Moderator &&
        byName.Support &&
        byName["Read-only audit"] &&
        byName.Admin.position > byName.Moderator.position &&
        byName.Moderator.position > byName.Support.position &&
        byName.Support.position > byName["Read-only audit"].position,
    JSON.stringify(roleList.roles.map((role) => [role.name, role.position])),
);
check(
    "default roles never carry OPERATOR",
    roleList.roles.every((role) => (BigInt(role.rights) & 1n) === 0n),
);

const assign = (user, ...names) =>
    expect(
        `operator gives ${user.username.split("_")[0]} ${names.join(", ") || "no roles"}`,
        "PUT",
        `/admin/users/${user.id}/staff-roles`,
        op.token,
        { role_ids: names.map((name) => byName[name].id) },
        200,
    );
await assign(admin, "Admin");
await assign(mod, "Moderator");
await assign(mod2, "Moderator");
await assign(support, "Support");
await assign(audit, "Read-only audit");
await expect("operator makes a legacy MANAGE_USERS account without a role", "PATCH", `/admin/users/${legacy.id}`, op.token, { rights: String(DEFAULT_RIGHTS | MANAGE_USERS) }, 200);

await expect("a member has no dashboard access", "GET", "/admin", member.token, undefined, 403);
for (const [label, account] of Object.entries({ admin, mod, support, audit, legacy }))
    await expect(`${label} opens the dashboard overview`, "GET", "/admin", account.token, undefined, 200);
const overview = await must("GET", "/admin", support.token);
check(
    "the overview reports support's access",
    overview.access.users &&
        overview.access.support &&
        !overview.access.moderate &&
        !overview.access.manage_users &&
        !overview.access.audit &&
        overview.staff_roles[0]?.name === "Support",
    JSON.stringify(overview.access),
);

await expect("read-only audit reads the audit log", "GET", "/admin/audit-log", audit.token, undefined, 200);
await expect("read-only audit reads reports", "GET", "/admin/reports", audit.token, undefined, 200);
await expect("read-only audit reads a user's violations", "GET", `/admin/users/${member.id}/violations`, audit.token, undefined, 200);
await expect("read-only audit can't search accounts", "GET", "/admin/users", audit.token, undefined, 403);
await expect("read-only audit can't issue a violation", "POST", `/admin/users/${member.id}/violations`, audit.token, { classification_type: 1, description: "probe" }, 403);
await expect("read-only audit can't edit a report", "PATCH", "/admin/reports/1", audit.token, { status: "resolved" }, 403);
await expect("read-only audit can't list staff roles", "GET", "/admin/staff/roles", audit.token, undefined, 403);

await expect("support searches accounts", "GET", `/admin/users?q=${member.username}`, support.token, undefined, 200);
await expect("support opens an account", "GET", `/admin/users/${member.id}`, support.token, undefined, 200);
await expect("support reads moderation history", "GET", `/admin/users/${member.id}/violations`, support.token, undefined, 200);
await expect("support sends a password reset link", "POST", `/admin/users/${member.id}/password-reset`, support.token, {}, 200);
await expect("support marks an email verified", "PATCH", `/admin/users/${member.id}`, support.token, { verified: true }, 200);
await expect("support can't disable an account", "PATCH", `/admin/users/${member.id}`, support.token, { disabled: true }, 403);
await expect("support can't edit a profile", "PATCH", `/admin/users/${member.id}`, support.token, { bio: "probe" }, 403);
await expect("support can't issue a violation", "POST", `/admin/users/${member.id}/violations`, support.token, { classification_type: 1, description: "probe" }, 403);
await expect("support can't read the audit log", "GET", "/admin/audit-log", support.token, undefined, 403);
await expect("support can't reset a moderator's password", "POST", `/admin/users/${mod.id}/password-reset`, support.token, {}, 403);

await expect("a moderator issues a violation to a member", "POST", `/admin/users/${member.id}/violations`, mod.token, { classification_type: 1, description: "probe" }, 201);
await expect("a moderator suspends a member", "PATCH", `/admin/users/${member.id}`, mod.token, { suspended_until: new Date(Date.now() + 3600_000).toISOString() }, 200);
await expect("a moderator lifts the suspension", "PATCH", `/admin/users/${member.id}`, mod.token, { suspended_until: null }, 200);
await expect(
    "a moderator issues a violation to support, a lower role",
    "POST",
    `/admin/users/${support.id}/violations`,
    mod.token,
    { classification_type: 1, description: "probe" },
    201,
);
await expect("a moderator can't act on another moderator", "POST", `/admin/users/${mod2.id}/violations`, mod.token, { classification_type: 1, description: "probe" }, 403);
await expect("a moderator can't suspend an admin", "PATCH", `/admin/users/${admin.id}`, mod.token, { suspended_until: new Date(Date.now() + 3600_000).toISOString() }, 403);
await expect("a moderator can't act on an operator", "POST", `/admin/users/${op.id}/violations`, mod.token, { classification_type: 1, description: "probe" }, 403);
await expect("a moderator can't edit a profile", "PATCH", `/admin/users/${member.id}`, mod.token, { bio: "probe" }, 403);
await expect("a moderator can't send a password reset", "POST", `/admin/users/${member.id}/password-reset`, mod.token, {}, 403);
await expect("a moderator can't manage staff roles", "GET", "/admin/staff/roles", mod.token, undefined, 403);
await expect("a moderator can't delete accounts in bulk", "POST", "/admin/users/bulk", mod.token, { user_ids: [member.id], action: "delete" }, 403);

await expect(
    "a moderator removes content in a server they aren't in through the role's MANAGE_MESSAGES",
    "DELETE",
    `/channels/${text.id}/messages/${message.id}`,
    mod.token,
    undefined,
    204,
);

await expect("an admin edits a member's profile", "PATCH", `/admin/users/${member.id}`, admin.token, { bio: "edited by the staff probe" }, 200);
await expect("an admin gives a member the Support role", "PUT", `/admin/users/${member.id}/staff-roles`, admin.token, { role_ids: [byName.Support.id] }, 200);
await expect("an admin takes it away again", "PUT", `/admin/users/${member.id}/staff-roles`, admin.token, { role_ids: [] }, 200);
await expect("an admin can't give a role at their own position", "PUT", `/admin/users/${member.id}/staff-roles`, admin.token, { role_ids: [byName.Admin.id] }, 403);
await expect("an admin can't change their own roles", "PUT", `/admin/users/${admin.id}/staff-roles`, admin.token, { role_ids: [] }, 403);
await expect("an admin can't act on an operator", "PATCH", `/admin/users/${op.id}`, admin.token, { bio: "probe" }, 403);
await expect("an admin can't act on staff that has no role", "PATCH", `/admin/users/${legacy.id}`, admin.token, { bio: "probe" }, 403);
await expect("an admin can't create a role at their own position", "POST", "/admin/staff/roles", admin.token, { name: "Probe peer", position: byName.Admin.position }, 403);
await expect("an admin can't grant a right they don't have", "POST", "/admin/staff/roles", admin.token, { name: "Probe tokens", position: 1, rights: String(1n << 50n) }, 403);
await expect("nobody can put OPERATOR in a role", "POST", "/admin/staff/roles", op.token, { name: "Probe operator", position: 1, rights: "1" }, 400);
const created = await expect(
    "an admin creates a role below their own",
    "POST",
    "/admin/staff/roles",
    admin.token,
    { name: "Probe helper", position: 1, rights: String(1n << 51n), show_badge: true },
    201,
);
if (created.json?.id) {
    await expect("an admin can't move that role to their own position", "PATCH", `/admin/staff/roles/${created.json.id}`, admin.token, { position: byName.Admin.position }, 403);
    await expect("an admin renames that role", "PATCH", `/admin/staff/roles/${created.json.id}`, admin.token, { name: "Probe helper 2" }, 200);
    await expect("an admin reorders roles below their own", "PATCH", "/admin/staff/roles", admin.token, [{ id: created.json.id, position: 2 }], 200);
    await expect("an admin deletes that role", "DELETE", `/admin/staff/roles/${created.json.id}`, admin.token, undefined, 204);
}
await expect("an admin can't edit their own role", "PATCH", `/admin/staff/roles/${byName.Admin.id}`, admin.token, { name: "Probe" }, 403);
await expect("an admin can't delete a role above their own", "DELETE", `/admin/staff/roles/${byName.Admin.id}`, admin.token, undefined, 403);
await expect("an admin can't change instance settings", "PATCH", "/admin/settings", admin.token, { general: { instanceDescription: "probe" } }, 403);
await expect("an admin removes content through the role's MANAGE_MESSAGES", "DELETE", `/channels/${text.id}/messages/${adminMessage.id}`, admin.token, undefined, 204);

await expect("a legacy MANAGE_USERS account edits a member", "PATCH", `/admin/users/${member.id}`, legacy.token, { bio: "legacy edit" }, 200);
await expect("a legacy MANAGE_USERS account can't act on staff with a role", "PATCH", `/admin/users/${audit.id}`, legacy.token, { bio: "probe" }, 403);

const profile = await must("GET", `/users/${mod.id}/profile`, op.token);
check(
    "a moderator's profile shows the role's staff badge",
    profile.badges.some((badge) => String(badge.id).startsWith("staff-role-") && badge.description.endsWith("Moderator")),
    JSON.stringify(profile.badges),
);
const auditProfile = await must("GET", `/users/${audit.id}/profile`, op.token);
check("a role without the badge shows none", !auditProfile.badges.some((badge) => String(badge.id).startsWith("staff-role-")), JSON.stringify(auditProfile.badges));

const log = await must("GET", `/admin/audit-log?actor_id=${admin.id}&limit=100`, audit.token);
const actions = log.entries.map((entry) => entry.action);
check(
    "the audit log records the admin's role changes",
    ["staff_role.create", "staff_role.update", "staff_role.delete", "staff_role.assign", "staff_role.remove"].every((action) => actions.includes(action)),
    actions.join(", "),
);
check(
    "the audit log records the admin's profile edit with the field name",
    log.entries.some((entry) => entry.action === "PATCH /admin/users/:user_id" && entry.target_id === member.id && entry.changes.some((change) => change.key === "bio")),
    actions.join(", "),
);
check("refused actions are not logged", !log.entries.some((entry) => entry.target_id === op.id));
const staffOnly = await must("GET", `/admin/audit-log?area=staff&limit=100`, audit.token);
check("the area filter returns only staff role changes", staffOnly.entries.length > 0 && staffOnly.entries.every((entry) => entry.area === "staff"));
const modLog = await must("GET", `/admin/audit-log?actor_id=${mod.id}&limit=100`, audit.token);
check(
    "the audit log records the moderator's message removal with the right it used",
    modLog.entries.some((entry) => entry.options?.right === "MANAGE_MESSAGES" && entry.target_id === member.id),
    JSON.stringify(modLog.entries.map((entry) => [entry.action, entry.options?.right])),
);
const recent = await must(`GET`, `/admin/audit-log?after=${encodeURIComponent(new Date(Date.now() + 86400_000).toISOString())}`, audit.token);
check("the date filter excludes older entries", recent.entries.length === 0);

await assign(mod2);
await expect("a moderator whose role was taken loses access right away", "GET", "/admin/users", mod2.token, undefined, 403);

const failed = results.filter((result) => !result.pass);
for (const result of results) console.log(`${result.pass ? "pass" : "FAIL"}  ${result.name}${result.detail ? `\n      ${result.detail}` : ""}`);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
