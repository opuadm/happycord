/* SPDX-License-Identifier: AGPL-3.0-only */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const releasePath = path.resolve(process.env.CLIENT_RELEASE_PATH || path.join(__dirname, "..", "client", "release.json"));
const cachePath = path.resolve(process.env.CLIENT_CACHE_PATH || path.join(__dirname, "..", "assets", "cache"));
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const describe = (cache, html, names) => {
    const buildNumber = html.match(/"BUILD_NUMBER"\s*:\s*"(\d+)"/)?.[1];
    const versionHash = html.match(/"VERSION_HASH"\s*:\s*"([0-9a-f]+)"/)?.[1];
    if (!buildNumber || !versionHash) throw new Error("The client does not identify its build number and version hash");
    const assets = [...names].sort().map((name) => {
        if (!/^[\w.-]+$/.test(name)) throw new Error("Invalid client asset name");
        return [name, digest(fs.readFileSync(path.join(cache, name)))];
    });
    return {
        buildNumber,
        versionHash,
        indexSha256: digest(html.replace(/<script[^>]*>[^<]*__CF\$cv\$params[\s\S]*?<\/script>/, "").replace(/nonce="[^"]*"/g, 'nonce=""')),
        assetCount: assets.length,
        assetsSha256: digest(JSON.stringify(assets)),
    };
};
const verify = (actual) => {
    const expected = JSON.parse(fs.readFileSync(releasePath, "utf8"));
    for (const key of ["buildNumber", "versionHash", "indexSha256", "assetCount", "assetsSha256"])
        if (actual[key] !== expected[key]) throw new Error(`Unreviewed client release: ${key} differs from client/release.json`);
    return actual;
};
const RELEASE_REPOSITORY = "meowcorded/meowcord";
const pinnedIndexUrl = () => {
    if (process.env.CLIENT_INDEX_URL) return process.env.CLIENT_INDEX_URL;
    const { buildNumber } = JSON.parse(fs.readFileSync(releasePath, "utf8"));
    return `https://github.com/${RELEASE_REPOSITORY}/releases/download/client-${buildNumber}/index.html`;
};
const check = (cache = cachePath) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(cache, "release-manifest.json"), "utf8"));
    return verify(describe(cache, fs.readFileSync(path.join(cache, "index.html"), "utf8"), manifest.assets));
};
module.exports = { describe, verify, check, pinnedIndexUrl };
if (require.main === module) {
    try {
        if (process.argv.includes("--record")) {
            const manifest = JSON.parse(fs.readFileSync(path.join(cachePath, "release-manifest.json"), "utf8"));
            const actual = describe(cachePath, fs.readFileSync(path.join(cachePath, "index.html"), "utf8"), manifest.assets);
            fs.writeFileSync(releasePath, `${JSON.stringify(actual, null, 4)}\n`);
            console.log(`Recorded client ${actual.buildNumber}; run the browser compatibility and encryption checks before committing this pin`);
        } else console.log(`Verified client ${check().buildNumber}`);
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
