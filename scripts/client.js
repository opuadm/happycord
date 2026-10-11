const path = require("path");
const vm = require("vm");
const fs = require("fs/promises");
const { existsSync } = require("fs");
const release = require("./client-release.js");

const BASE_URL = process.env.CLIENT_BASE_URL || "https://discord.com";
const CACHE_PATH = path.resolve(process.env.CLIENT_CACHE_PATH || path.join(__dirname, "..", "assets", "cache"));
const CONCURRENCY = Math.max(1, Math.min(32, Math.floor(Number(process.env.CLIENT_CONCURRENCY) || 8)));
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const MEDIA_EXT = "svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|mp3|ogg|wav|mp4|webm|json|lottie|wasm";
const ASSET_NAME = new RegExp(`(?:^|["'(/\\s])((?:[\\w-]+\\.)?[0-9a-f]{8,32}\\.(?:js|css|${MEDIA_EXT}))(?=["')?#\\s]|$)`, "g");
const TEXT_EXT = /\.(js|css|json)$/;

const patch = (content) =>
    content
        .replaceAll("delete window.localStorage", "void 0")
        .replaceAll("`https://discord.com/ra/${", "`${location.origin}/ra/${")
        .replaceAll('"https:"+window.GLOBAL_ENV', " location.protocol+window.GLOBAL_ENV")
        .replaceAll("returnlocation.protocol", "return location.protocol")
        .replaceAll("`https:${window.GLOBAL_ENV", "`${location.protocol}${window.GLOBAL_ENV")
        .replaceAll("`https://${", "`${location.protocol}//${");

const sliceExpression = (source, start) => {
    const closers = { "(": ")", "[": "]", "{": "}" };
    const stack = [];
    let quote = null;
    for (let i = start; i < source.length; i++) {
        const ch = source[i];
        if (quote) {
            if (ch === "\\") i++;
            else if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") quote = ch;
        else if (closers[ch]) stack.push(closers[ch]);
        else if (ch === ")" || ch === "]" || ch === "}") {
            if (!stack.length) return source.slice(start, i);
            stack.pop();
        } else if ((ch === "," || ch === ";") && !stack.length) return source.slice(start, i);
    }
    return source.slice(start);
};

const chunkNames = (source) => {
    const names = new Set();
    for (const match of source.matchAll(/\.[uk]=([a-zA-Z_$][\w$]*)=>/g)) {
        const parameter = match[1];
        const body = sliceExpression(source, match.index + match[0].length);
        const ids = new Set([...body.matchAll(/"(\d+)"===[a-zA-Z_$][\w$]*/g), ...body.matchAll(/[{,](\d+(?:e\d+)?):"[0-9a-f]+"/g)].map((m) => String(Number(m[1]))));
        let fn;
        try {
            fn = vm.runInNewContext(`(${parameter}=>${body})`, {}, { timeout: 100 });
        } catch {
            continue;
        }
        for (const id of ids) {
            const name = fn(id);
            if (typeof name === "string" && /^[\w.-]+$/.test(name) && !name.includes("undefined")) names.add(name);
        }
    }
    return names;
};

const WASM_MODULE = /\.v\(\w+,\w+\.id,"([0-9a-f]{8,32})"/g;
const references = (text) => {
    const names = [...text.matchAll(ASSET_NAME)]
        .filter((match) => {
            const prefix = text.slice(Math.max(0, match.index - 512), match.index + 1);
            const url = prefix.match(/https?:\/\/[^\s"'`]*$/)?.[0];
            return !url || /\/assets\/$/.test(url);
        })
        .map((match) => match[1]);
    return new Set([...names, ...[...text.matchAll(WASM_MODULE)].map((match) => `${match[1]}.module.wasm`)]);
};
const checkOnly = process.argv.includes("--check");
const reviewing = process.env.CLIENT_RELEASE_REVIEW === "1";
const onlyMissing = checkOnly || process.argv.includes("--missing");
const writeAtomic = async (file, body) => {
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, body);
    await fs.rename(temporary, file);
};

const main = async () => {
    if (!checkOnly) await fs.mkdir(CACHE_PATH, { recursive: true });
    const started = Date.now();

    const indexFile = path.join(CACHE_PATH, "index.html");
    let html;
    if (checkOnly && !existsSync(indexFile)) throw new Error("Client index.html is missing; generate a snapshot before checking it");
    if (onlyMissing && existsSync(indexFile)) html = await fs.readFile(indexFile, "utf8");
    else {
        const pinned = reviewing ? null : release.pinnedIndexUrl();
        const pinnedRes = pinned && (await fetch(pinned, { redirect: "follow", signal: AbortSignal.timeout(30000) }).catch(() => null));
        if (pinnedRes?.ok) html = await pinnedRes.text();
        else {
            if (pinned) console.warn(`The reviewed client index at ${pinned} returned ${pinnedRes?.status ?? "a network error"}, using the current ${BASE_URL}/app instead`);
            const appRes = await fetch(`${BASE_URL}/app`, {
                headers: { "user-agent": USER_AGENT },
                signal: AbortSignal.timeout(30000),
            });
            if (!appRes.ok) throw new Error(`GET /app returned ${appRes.status}`);
            html = await appRes.text();
        }
    }

    const servedHtml = html.replace(/<!-- section:seometa -->[\s\S]*?<!-- endsection -->/, "");
    const queue = [...new Set([...servedHtml.matchAll(/\/assets\/([\w.-]+)/g)].map((m) => m[1]))];
    const seen = new Set(queue);
    const failed = [];
    let done = 0;
    let bytes = 0;

    const enqueue = (names) => {
        for (const name of names) {
            if (seen.has(name)) continue;
            seen.add(name);
            queue.push(name);
        }
    };

    const fetchAsset = async (name) => {
        const file = path.join(CACHE_PATH, name);
        const isText = TEXT_EXT.test(name);
        if (existsSync(file)) {
            if (!isText) return;
            const text = await fs.readFile(file, "utf8");
            enqueue(references(text));
            if (name.endsWith(".js")) enqueue(chunkNames(text));
            const patched = name.endsWith(".json") ? text : patch(text);
            if (!checkOnly && patched !== text) await writeAtomic(file, patched);
            return;
        }
        if (checkOnly) {
            failed.push(`missing ${name}`);
            return;
        }
        const res = await fetch(`${BASE_URL}/assets/${name}`, {
            headers: { "user-agent": USER_AGENT },
            signal: AbortSignal.timeout(30000),
        });
        if (!res.ok) {
            failed.push(`${res.status} ${name}`);
            return;
        }
        if (!isText) {
            const buf = Buffer.from(await res.arrayBuffer());
            bytes += buf.length;
            await writeAtomic(file, buf);
            return;
        }
        const text = await res.text();
        bytes += text.length;
        enqueue(references(text));
        if (name.endsWith(".js")) enqueue(chunkNames(text));
        await writeAtomic(file, name.endsWith(".json") ? text : patch(text));
    };

    const report = setInterval(() => {
        process.stdout.write(`\r${done}/${seen.size} assets, ${(bytes / 1048576).toFixed(1)} MB, ${failed.length} failed, ${Math.round((Date.now() - started) / 1000)}s   `);
    }, 1000);

    let inflight = 0;
    try {
        await Promise.all(
            Array.from({ length: CONCURRENCY }, async () => {
                while (queue.length || inflight) {
                    const name = queue.shift();
                    if (!name) {
                        await new Promise((r) => setTimeout(r, 100));
                        continue;
                    }
                    inflight++;
                    await fetchAsset(name).catch((e) => failed.push(`${e.message} ${name}`));
                    inflight--;
                    done++;
                }
            }),
        );
    } finally {
        clearInterval(report);
    }
    if (!checkOnly) await writeAtomic(path.join(CACHE_PATH, "..", "cacheFailures"), failed.join("\n"));
    if (!failed.length) {
        const actual = release.describe(CACHE_PATH, html, seen);
        if (!reviewing) release.verify(actual);
        if (!checkOnly) {
            await writeAtomic(path.join(CACHE_PATH, "release-manifest.json"), JSON.stringify({ ...actual, assets: [...seen].sort() }));
            if (!onlyMissing) await writeAtomic(indexFile, html);
        }
    }
    console.log(
        `\nDone: ${done} assets, ${(bytes / 1048576).toFixed(1)} MB in ${Math.round((Date.now() - started) / 1000)}s, ${failed.length} failed${checkOnly ? "" : " (see assets/cacheFailures)"}`,
    );
    if (failed.length) throw new Error(`${failed.length} client assets are missing; client index was not published${checkOnly ? `: ${failed.slice(0, 20).join(", ")}` : ""}`);
};

module.exports = { chunkNames, references, patch };
if (require.main === module)
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
