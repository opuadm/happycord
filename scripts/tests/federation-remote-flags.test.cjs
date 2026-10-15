/* SPDX-License-Identifier: AGPL-3.0-only */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { remotePublicFlags, sanitizeRemoteUser } = require("../../dist/util/util/federation/Ids.js");

const OFFICIAL_TAG = 1 << 28;
const SYSTEM_TAG = 1 << 29;
const AI_ACCOUNT = 1 << 30;
const HOUSE_BRAVERY = 1 << 6;

test("flags another instance grants never cross over", () => {
    for (const flag of [1 << 0, 1 << 1, 1 << 9, 1 << 11, 1 << 12, 1 << 16, 1 << 17, 1 << 18, 1 << 22, OFFICIAL_TAG, SYSTEM_TAG])
        assert.equal(remotePublicFlags(flag), 0, String(flag));
    assert.equal(remotePublicFlags(OFFICIAL_TAG | SYSTEM_TAG | HOUSE_BRAVERY | AI_ACCOUNT), HOUSE_BRAVERY | AI_ACCOUNT);
    for (const junk of [-1, "abc", null, undefined, 2 ** 60, Number.NaN]) assert.equal(remotePublicFlags(junk), 0, String(junk));
});

test("a remote user object loses the system mark and granted flags", () => {
    const user = sanitizeRemoteUser({ id: "1", username: "official@evil.example", system: true, staff: true, flags: OFFICIAL_TAG, public_flags: OFFICIAL_TAG | HOUSE_BRAVERY });
    assert.equal(user.system, false);
    assert.equal(user.public_flags, HOUSE_BRAVERY);
    assert.equal(user.flags, HOUSE_BRAVERY);
    assert.ok(!("staff" in user));
});

test("every user object from another instance goes through the sanitizer", () => {
    const ids = fs.readFileSync("src/api/util/utility/federationIds.ts", "utf8");
    assert.match(ids, /user\.discriminator = "0";\s*sanitizeRemoteUser\(user\);/);
    const shadows = fs.readFileSync("src/api/util/utility/federationShadows.ts", "utf8");
    assert.match(shadows, /public_flags: remotePublicFlags\(raw\.public_flags\)/);
});
