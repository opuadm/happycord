const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const dir = path.join(root, "assets/emojis/devices");
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));

const MOODS = ["happy", "angry", "neutral", "sad"];
const DEVICES = ["browser", "console", "pc", "phone", "vr", "toaster", "terminal", "toilet", "bed", "unknown"];
const LOW_QUALITY_MISSING = ["neutralvr", "angryvr", "sadvr"];
const LOW_QUALITY_DEVICES = ["browser", "console", "pc", "phone", "vr"];

const expectedNames = [];
for (const mood of MOODS)
    for (const device of DEVICES)
        for (const low of ["", "_low"]) {
            if (low && (LOW_QUALITY_MISSING.includes(`${mood}${device}`) || !LOW_QUALITY_DEVICES.includes(device))) continue;
            expectedNames.push(`${mood}${device}${low}`);
        }

test("every default device emoji file matches its manifest checksum", () => {
    assert.equal(manifest.emojiCount, 57);
    assert.equal(manifest.emojiCount, manifest.emojis.length);
    assert.deepEqual(
        fs
            .readdirSync(dir)
            .filter((x) => x.endsWith(".png"))
            .sort(),
        manifest.emojis.map((emoji) => path.basename(emoji.file)).sort(),
    );
    for (const emoji of manifest.emojis) {
        assert.match(emoji.name, /^[a-z]+(_low)?$/);
        assert.equal(
            createHash("sha256")
                .update(fs.readFileSync(path.join(root, "assets", emoji.file)))
                .digest("hex"),
            emoji.sha256,
        );
    }
});

test("the manifest covers every mood, device and quality with frozen unique ids", () => {
    assert.deepEqual(
        manifest.emojis.map((emoji) => emoji.name),
        expectedNames,
    );
    const ids = manifest.emojis.map((emoji) => emoji.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const [index, id] of ids.entries()) {
        assert.equal(id, String(101000000000000000n + BigInt(index)));
        assert.equal(manifest.emojis[index].file, `emojis/devices/${manifest.emojis[index].name}.png`);
    }
});
