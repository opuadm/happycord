import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const root = join(import.meta.dirname, "../..");
const trees = [
    ["src/api/routes", "/api/v9"],
    ["src/api/routes_toplevel", ""],
];
const methods = new Set(["get", "post", "put", "patch", "delete", "all"]);
const markers = [
    ["getPermission", /\bgetPermission\(/],
    ["member", /\bMember\.(IsInGuildOrFail|findOneOrFail|findOne|exists|count)\(|\bisMember|\bgetMember|IsInGuild/],
    ["recipient", /recipient|isRecipient|\bdm\b/i],
    ["owner", /owner_id|\.owner\b|ownerId|isOwner|team/],
    ["self", /user_id\s*[!=]==|[!=]==\s*req\.user_id|author_id|author\.id\s*[!=]==/],
    ["rights", /getRights|req\.rights|Rights\.|\.rights\.has/],
    ["checkPerm", /\bcheck\w*Permission\w*\(|assert\w*Permission|hasPermission|canView|canManage|canAccess/],
    ["token", /\btoken\b|signature|secret/],
];

const walk = (dir) =>
    readdirSync(dir)
        .sort()
        .flatMap((name) => {
            const full = join(dir, name);
            if (statSync(full).isDirectory()) return walk(full);
            return /\.(ts|js)$/.test(name) && !name.endsWith(".d.ts") && !name.endsWith(".test.ts") ? [full] : [];
        });

const urlFor = (file, tree, prefix) => {
    const rel = relative(join(root, tree), file)
        .replace(/\.(ts|js)$/, "")
        .split("/")
        .filter((part) => part !== "index")
        .map((part) => part.replace(/^#/, ":"))
        .join("/");
    return `${prefix}/${rel}`.replace(/\/+$/, "") || "/";
};

const readOptions = (node, source) => {
    const options = { authentication: "required" };
    for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const name = property.name.getText(source);
        if (!["authentication", "permission", "right", "oauth2", "allowUnverified", "channelRelations"].includes(name)) continue;
        options[name] = property.initializer.getText(source).replace(/\s+/g, " ");
    }
    return options;
};

const rows = [];
const unmatched = [];
for (const [tree, prefix] of trees) {
    for (const file of walk(join(root, tree))) {
        const text = readFileSync(file, "utf8");
        const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
        let found = 0;
        const routeVariables = new Map();
        const collect = (node) => {
            if (
                ts.isVariableDeclaration(node) &&
                ts.isIdentifier(node.name) &&
                node.initializer &&
                ts.isCallExpression(node.initializer) &&
                node.initializer.expression.getText(source) === "route"
            )
                routeVariables.set(node.name.text, node.initializer);
            ts.forEachChild(node, collect);
        };
        collect(source);
        const asRouteCall = (arg) =>
            ts.isCallExpression(arg) && arg.expression.getText(source) === "route" ? arg : ts.isIdentifier(arg) ? routeVariables.get(arg.text) : undefined;
        const visit = (node) => {
            if (
                ts.isCallExpression(node) &&
                ts.isPropertyAccessExpression(node.expression) &&
                methods.has(node.expression.name.text) &&
                /router$/i.test(node.expression.expression.getText(source))
            ) {
                const [first, ...rest] = node.arguments;
                if (first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first) || ts.isRegularExpressionLiteral(first))) {
                    found++;
                    const routeArg = rest.find((arg) => asRouteCall(arg));
                    const routeCall = routeArg && asRouteCall(routeArg);
                    const options = routeCall?.arguments[0] && ts.isObjectLiteralExpression(routeCall.arguments[0]) ? readOptions(routeCall.arguments[0], source) : null;
                    const body = rest
                        .filter((arg) => arg !== routeArg)
                        .map((arg) => arg.getText(source))
                        .join("\n");
                    const sub = first.text === "/" ? "" : first.text.replace(/^\/?/, "/");
                    rows.push({
                        method: node.expression.name.text.toUpperCase(),
                        path: `${urlFor(file, tree, prefix)}${sub}`,
                        file: relative(root, file),
                        route: Boolean(routeCall),
                        ...(options ?? { authentication: "none (no route())" }),
                        checks: markers.filter(([, pattern]) => pattern.test(body)).map(([name]) => name),
                    });
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
        if (!found && /Router\(/.test(text)) unmatched.push(relative(root, file));
    }
}

const flags = (row) => {
    const out = [];
    if (!row.route) out.push("NO_ROUTE_MIDDLEWARE");
    if (row.authentication === '"never"' && row.method !== "GET") out.push("UNAUTH_WRITE");
    if (/\/admin\b/.test(row.path) && row.path.startsWith("/api") && !row.right) out.push("ADMIN_NO_RIGHT");
    if (/:guild_id|:channel_id/.test(row.path) && !row.permission && !row.checks.some((check) => ["getPermission", "member", "recipient", "checkPerm"].includes(check)))
        out.push("NO_SCOPE_CHECK");
    return out;
};

const asJson = process.argv.includes("--json");
const onlyFlagged = process.argv.includes("--flagged");
const output = rows.map((row) => ({ ...row, flags: flags(row) })).filter((row) => !onlyFlagged || row.flags.length);
if (asJson) {
    console.log(JSON.stringify({ routes: output, filesWithoutHandlers: unmatched }, null, 2));
} else {
    for (const row of output) {
        const parts = [`auth=${row.authentication}`];
        if (row.permission) parts.push(`perm=${row.permission}`);
        if (row.right) parts.push(`right=${row.right}`);
        if (row.oauth2) parts.push(`oauth2=${row.oauth2}`);
        if (row.checks.length) parts.push(`body=${row.checks.join(",")}`);
        if (row.flags.length) parts.push(`FLAGS=${row.flags.join(",")}`);
        console.log(`${row.method.padEnd(6)} ${row.path}  ${parts.join("  ")}`);
    }
    console.log(`\n${rows.length} handlers in ${new Set(rows.map((row) => row.file)).size} files, ${output.filter((row) => row.flags.length).length} flagged`);
    if (unmatched.length) console.log(`files with a router and no handler found: ${unmatched.join(", ")}`);
}
