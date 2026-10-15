import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
export const jsonPath = path.join(root, "instances.json");
export const markdownPath = path.join(root, "instances.md");

const cell = (text) => String(text).replaceAll("|", "\\|");

const linkText = (url) => {
    const parsed = new URL(url);
    if (parsed.hostname === "github.com") return parsed.pathname.replace(/^\/|\/$/g, "");
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
};

export function renderInstancesMarkdown(instances) {
    const rows = instances.map(
        (instance) =>
            `| ${cell(instance.name)} | [${cell(linkText(instance.url))}](${instance.url}) | ${instance.source_url ? `[${cell(linkText(instance.source_url))}](${instance.source_url})` : ""} |`,
    );
    return [
        "# instances",
        "",
        "public meowcord instances. this file is generated from [instances.json](instances.json) by `bun scripts/instances-md.mjs`, so edit the json, run the script and open a pull request with both files.",
        "",
        "| instance | link | source |",
        "| -------- | ---- | ------ |",
        ...rows,
        "",
    ].join("\n");
}

if (import.meta.main) {
    const markdown = renderInstancesMarkdown(JSON.parse(fs.readFileSync(jsonPath, "utf8")));
    if (process.argv.includes("--check")) {
        if (fs.readFileSync(markdownPath, "utf8") !== markdown) {
            console.error("instances.md is out of date, run bun scripts/instances-md.mjs");
            process.exit(1);
        }
    } else {
        fs.writeFileSync(markdownPath, markdown);
        console.log(`wrote ${markdownPath}`);
    }
}
