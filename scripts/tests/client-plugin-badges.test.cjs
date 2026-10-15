const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const plugins = path.join(__dirname, "../../client/plugins");

test("plugins register profile badges through the list Equicord reads", () => {
    const singular = fs
        .readdirSync(plugins)
        .sort()
        .flatMap((name) => {
            const dir = path.join(plugins, name);
            if (!fs.statSync(dir).isDirectory()) return [];
            return fs
                .readdirSync(dir)
                .filter((file) => /\.tsx?$/.test(file))
                .filter((file) => /^\s*userProfileBadge\s*:/m.test(fs.readFileSync(path.join(dir, file), "utf8")))
                .map((file) => `${name}/${file}`);
        });
    assert.deepEqual(singular, [], "Equicord only adds badges from userProfileBadges, so a userProfileBadge field never shows");
    assert.match(fs.readFileSync(path.join(plugins, "fosscordFederation/index.tsx"), "utf8"), /userProfileBadges:\s*\[/);
});
