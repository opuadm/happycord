const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const root = path.resolve(__dirname, "..");
const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr || "git failed");
    return result.stdout.trim();
};
if (git("status", "--porcelain")) throw new Error("Commit the release changes before packaging the source archive");
const { version } = JSON.parse(git("show", "HEAD:package.json"));
if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.]+)?$/.test(version)) throw new Error("Invalid release version");
const files = git("ls-tree", "-rz", "--name-only", "HEAD").split("\0").filter(Boolean);
const forbidden = files.filter(
    (file) =>
        /^(?:assets\/(?:cache(?:_compressed)?|cacheMisses|cacheFailures|vencord)(?:\/|$)|(?:\.vencord|db|files|dump|\.e2ee-system|\.announcement-spool)(?:\/|$))/.test(file) ||
        /(?:^|\/)(?:config\.json|http-client\.private\.env\.json|jwt\.key[^/]*|federation\.key[^/]*|\.e2ee-recovery\.key[^/]*|\.test-account|\.e2ee-test-accounts|\.test-bot|\.scale-tokens\.json|database\.db(?:-[^/]*)?)$/.test(
            file,
        ) ||
        (/(?:^|\/)\.env(?:$|\.)/.test(file) && path.posix.basename(file) !== ".env.example"),
);
if (forbidden.length) throw new Error("Remove private configuration and cached client output from tracked release files");
const directory = path.join(root, "releases");
fs.mkdirSync(directory, { recursive: true });
const name = `meowcord-${version}.tar.gz`;
const archive = path.join(directory, name);
git("archive", "--format=tar.gz", `--prefix=meowcord-${version}/`, `--output=${archive}`, "HEAD");
const digest = createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
fs.writeFileSync(`${archive}.sha256`, `${digest}  ${name}\n`);
console.log(`Source archive: ${archive}\nSHA256: ${digest}\nCommit: ${git("rev-parse", "HEAD")}`);
