const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function releaseFixture(files, action) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "meowcord-release-"));
    const run = (command, args) =>
        spawnSync(command, args, {
            cwd: root,
            encoding: "utf8",
            env: { PATH: process.env.PATH, HOME: root },
        });
    const git = (...args) => {
        const result = run("git", args);
        assert.equal(result.status, 0, result.stderr);
        return result.stdout;
    };
    try {
        fs.mkdirSync(path.join(root, "scripts"));
        fs.copyFileSync(path.join(__dirname, "../release.js"), path.join(root, "scripts/release.js"));
        fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "0.1.0-alpha.1" }));
        for (const file of files) {
            fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
            fs.writeFileSync(path.join(root, file), "synthetic fixture");
        }
        git("init", "-q");
        git("add", "--all");
        git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture");
        return action({ root, run, git });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

const forbidden = [
    "config.json",
    "nested/config.json",
    "jwt.key",
    "nested/jwt.key.pub",
    "federation.key",
    "nested/federation.key",
    ".e2ee-recovery.key.backup",
    "nested/.e2ee-recovery.key",
    "files/object",
    "db/data",
    "dump/session/events.json",
    ".e2ee-system/identity",
    ".announcement-spool/message",
    "database.db",
    "database.db-wal",
    "http-client.private.env.json",
    "scripts/dev/.test-account",
    "scripts/dev/.e2ee-test-accounts",
    "scripts/dev/.test-bot",
    "scripts/dev/.scale-tokens.json",
    "assets/cache/index.html",
    "assets/cache_compressed/web.gz",
    "assets/vencord/browser.js",
    "assets/cacheMisses/missing",
    "assets/cacheFailures",
    ".vencord/package.json",
    ".env",
    ".env.production",
    "nested/.env.example.backup",
    "nested/line\nbreak/.env",
];
for (const file of forbidden) {
    test(`release rejects committed runtime artifact ${JSON.stringify(file)}`, () => {
        releaseFixture([file], ({ root, run }) => {
            const result = run(process.execPath, ["scripts/release.js"]);
            assert.notEqual(result.status, 0, file);
            assert.match(result.stderr, /Remove private configuration and cached client output/);
            assert.equal(fs.existsSync(path.join(root, "releases")), false, file);
        });
    });
}

test("release includes committed source and examples but excludes untracked runtime files", () => {
    releaseFixture([".env.example", "nested/.env.example", "src/configuration.ts", "docs/private-keys.md"], ({ root, run, git }) => {
        fs.writeFileSync(path.join(root, ".env"), "synthetic untracked fixture");
        fs.writeFileSync(path.join(root, ".git/info/exclude"), ".env\nreleases/\n");
        const result = run(process.execPath, ["scripts/release.js"]);
        assert.equal(result.status, 0, result.stderr);
        const archive = path.join(root, "releases/meowcord-0.1.0-alpha.1.tar.gz");
        const listing = run("tar", ["-tzf", archive]);
        assert.equal(listing.status, 0, listing.stderr);
        assert.match(listing.stdout, /meowcord-0\.1\.0-alpha\.1\/nested\/\.env\.example/);
        assert.doesNotMatch(listing.stdout, /\/\.env\n/);
        const digest = require("node:crypto").createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
        assert.equal(fs.readFileSync(`${archive}.sha256`, "utf8"), `${digest}  meowcord-0.1.0-alpha.1.tar.gz\n`);
        assert.match(result.stdout, new RegExp(git("rev-parse", "HEAD").trim()));
    });
});

test("release refuses dirty tracked source before creating an archive", () => {
    releaseFixture([], ({ root, run }) => {
        fs.appendFileSync(path.join(root, "package.json"), "\n");
        const result = run(process.execPath, ["scripts/release.js"]);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Commit the release changes/);
        assert.equal(fs.existsSync(path.join(root, "releases")), false);
    });
});
