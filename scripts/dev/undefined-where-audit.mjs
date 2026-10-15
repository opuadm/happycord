/* SPDX-License-Identifier: AGPL-3.0-only */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

const root = join(import.meta.dirname, "../..");
const optionMethods = new Set(["find", "findOne", "findOneOrFail", "findAndCount", "count", "exists"]);
const criteriaMethods = new Set(["findBy", "findOneBy", "findOneByOrFail", "findAndCountBy", "countBy", "existsBy", "update", "delete", "softDelete", "increment", "decrement"]);
const requestSources = new Set(["params", "query", "body"]);

const unwrap = (node) => {
    while (
        node &&
        (ts.isParenthesizedExpression(node) ||
            ts.isAsExpression(node) ||
            ts.isNonNullExpression(node) ||
            ts.isTypeAssertionExpression(node) ||
            ts.isSatisfiesExpression(node) ||
            ts.isAwaitExpression(node))
    )
        node = node.expression;
    return node;
};

const isFunction = (node) => ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node);

const accessChain = (node) => {
    const names = [];
    let current = unwrap(node);
    while (current) {
        if (ts.isPropertyAccessExpression(current) || ts.isPropertyAccessChain?.(current)) {
            names.unshift(current.name.text);
            current = unwrap(current.expression);
        } else if (ts.isElementAccessExpression(current) && ts.isStringLiteralLike(current.argumentExpression)) {
            names.unshift(current.argumentExpression.text);
            current = unwrap(current.expression);
        } else if (ts.isIdentifier(current)) {
            names.unshift(current.text);
            return names;
        } else return undefined;
    }
    return undefined;
};

const enclosingFunctions = (node) => {
    const functions = [];
    for (let current = node.parent; current; current = current.parent) if (isFunction(current)) functions.push(current);
    return functions;
};

function taintOf(expression, scope) {
    const node = unwrap(expression);
    if (!node) return undefined;
    if (ts.isConditionalExpression(node)) return taintOf(node.whenTrue, scope) ?? taintOf(node.whenFalse, scope);
    if (ts.isIdentifier(node) && node.text === "undefined") return { source: "undefined", field: undefined, name: "undefined" };
    const chain = accessChain(node);
    if (!chain) return undefined;
    if (chain[0] === "req" && requestSources.has(chain[1])) return { source: chain[1], field: chain[2], name: chain.slice(0, 3).join(".") };
    const base = scope.get(chain[0]);
    if (!base) return undefined;
    if (chain.length === 1) return base;
    if (base.field !== undefined) return { ...base, name: chain.join(".") };
    return { source: base.source, field: chain[1], name: chain.slice(0, 2).join(".") };
}

function collectScope(functions, before) {
    const scope = new Map();
    for (const fn of [...functions].reverse()) {
        const visit = (node) => {
            if (node !== fn && isFunction(node)) return;
            if (node.pos >= before) return;
            if (ts.isVariableDeclaration(node) && node.initializer) {
                const taint = taintOf(node.initializer, scope);
                if (taint && taint.source !== "undefined") {
                    if (ts.isIdentifier(node.name)) scope.set(node.name.text, { ...taint, name: node.name.text });
                    else if (ts.isObjectBindingPattern(node.name))
                        for (const element of node.name.elements) {
                            if (element.initializer || !ts.isIdentifier(element.name) || element.dotDotDotToken) continue;
                            const field = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : element.name.text;
                            scope.set(
                                element.name.text,
                                taint.field === undefined ? { source: taint.source, field, name: element.name.text } : { ...taint, name: element.name.text },
                            );
                        }
                } else if (ts.isIdentifier(node.name)) scope.delete(node.name.text);
            }
            ts.forEachChild(node, visit);
        };
        visit(fn.body ?? fn);
    }
    return scope;
}

const mentions = (node, source, name) => {
    const text = node.getText(source);
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^\\w$.])${escaped}(?![\\w$])`).test(text);
};

const negates = (node, source, name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^\\w$.])!\\s*${escaped}(?![\\w$])|(^|[^\\w$.])${escaped}\\s*===?\\s*(undefined|null)(?![\\w$])`).test(node.getText(source));
};

const exits = (statement) => {
    let found = false;
    const visit = (node) => {
        if (found || isFunction(node)) return;
        if (ts.isThrowStatement(node) || ts.isReturnStatement(node) || ts.isContinueStatement(node) || ts.isBreakStatement(node)) found = true;
        else ts.forEachChild(node, visit);
    };
    visit(statement);
    return found;
};

function guarded(call, source, name) {
    let child = call;
    for (let current = call.parent; current; child = current, current = current.parent) {
        if (isFunction(current)) {
            if (current.parameters.some((parameter) => mentions(parameter, source, name.split(".")[0]))) return false;
        }
        const condition = ts.isIfStatement(current) ? current.expression : ts.isConditionalExpression(current) ? current.condition : undefined;
        if (condition && child !== condition && mentions(condition, source, name)) {
            const otherwise = child === current.elseStatement || child === current.whenFalse;
            if (otherwise === negates(condition, source, name)) return true;
        }
        if (
            ts.isBinaryExpression(current) &&
            current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
            child === current.right &&
            mentions(current.left, source, name)
        )
            return true;
        if (ts.isBlock(current) || ts.isSourceFile(current)) {
            for (const statement of current.statements) {
                if (statement === child) break;
                if (ts.isIfStatement(statement) && statement.expression.getText(source) !== name && mentions(statement.expression, source, name) && exits(statement.thenStatement))
                    return true;
            }
        }
    }
    return false;
}

const routeCallOf = (call, source) => {
    for (let current = call.parent; current; current = current.parent) {
        if (
            ts.isCallExpression(current) &&
            ts.isPropertyAccessExpression(current.expression) &&
            /router$/i.test(current.expression.expression.getText(source)) &&
            ["get", "post", "put", "patch", "delete", "all"].includes(current.expression.name.text)
        )
            return current;
    }
    return undefined;
};

const routeOptions = (routeCall, source) => {
    const options = {};
    for (const argument of routeCall?.arguments ?? []) {
        if (ts.isStringLiteralLike(argument)) options.path = argument.text;
        if (ts.isArrayLiteralExpression(argument)) options.path = argument.elements.map((element) => element.getText(source)).join(" ");
        if (!ts.isCallExpression(argument) || argument.expression.getText(source) !== "route") continue;
        const [config] = argument.arguments;
        if (!config || !ts.isObjectLiteralExpression(config)) continue;
        for (const property of config.properties)
            if (ts.isPropertyAssignment(property) && property.name.getText(source) === "requestBody" && ts.isStringLiteralLike(property.initializer))
                options.requestBody = property.initializer.text;
    }
    return options;
};

const reviewed = new Map(
    [
        ["src/api/util/handlers/AdminUserCustomization.ts", ["req.params.user_id"], "every router using it is mounted under admin/users/#user_id"],
        [
            "src/api/util/handlers/ApplicationCommands.ts",
            ["req.params.application_id", "req.params.guild_id", "req.params.command_id", "guildId", "applicationId"],
            "every router using it is mounted under applications/#application_id, and the permission routers under guilds/#guild_id/commands",
        ],
        ["src/api/util/handlers/Webhook.ts", ["webhook_id"], "executeWebhook is only mounted under webhooks/#webhook_id/#webhook_token"],
        ["src/cdn/util/cloudUploads.ts", ["channel_id", "attachment_id", "filename"], "only used on PUT /:channel_id/:batch_id/:attachment_id/:filename"],
    ].flatMap(([file, values, reason]) => values.map((value) => [`${file}:${value}`, reason])),
);

function verdict(taint, call, source, file, schemas, value) {
    const text = source.text;
    const review = reviewed.get(`${file.split(sep).join("/")}:${value}`);
    if (review) return { dangerous: false, reason: "reviewed", note: review };
    if (taint.source === "undefined") return { dangerous: true, reason: "literal undefined" };
    if (guarded(call, source, taint.name)) return { dangerous: false, reason: "guarded" };
    const options = routeOptions(routeCallOf(call, source), source);
    if (taint.source === "params") {
        const segments = file.split(sep).join("/");
        if (taint.field && (segments.includes(`#${taint.field}/`) || segments.includes(`#${taint.field}.`) || (options.path ?? text).includes(`/:${taint.field}`)))
            return { dangerous: false, reason: "path parameter" };
        return { dangerous: true, reason: "parameter not in the route path" };
    }
    if (taint.source === "body" && taint.field && options.requestBody && schemas?.[options.requestBody]?.required?.includes(taint.field))
        return { dangerous: false, reason: `required by ${options.requestBody}` };
    return { dangerous: true, reason: `optional request ${taint.source}` };
}

function whereObjects(call, method, source) {
    const args = call.arguments.map(unwrap);
    if (optionMethods.has(method)) {
        const options = args.find((argument) => argument && ts.isObjectLiteralExpression(argument));
        const where = options?.properties.find((property) => ts.isPropertyAssignment(property) && property.name.getText(source) === "where");
        return where ? [unwrap(where.initializer)] : [];
    }
    const criteria =
        args.length >= 2 && ts.isIdentifier(args[0]) && /^[A-Z]/.test(args[0].text) && /manager|transaction|\bem\b|repository|runner/i.test(call.expression.getText(source))
            ? args[1]
            : args[0];
    return criteria ? [criteria] : [];
}

function whereValues(node, out = []) {
    if (!node) return out;
    if (ts.isArrayLiteralExpression(node)) for (const element of node.elements) whereValues(unwrap(element), out);
    if (!ts.isObjectLiteralExpression(node)) return out;
    for (const property of node.properties) {
        if (ts.isShorthandPropertyAssignment(property)) out.push({ key: property.name.text, value: property.name });
        else if (ts.isPropertyAssignment(property)) {
            const value = unwrap(property.initializer);
            if (ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value)) whereValues(value, out);
            else out.push({ key: property.name.getText(), value });
        }
    }
    return out;
}

export function auditSource(file, text, schemas) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const findings = [];
    const visit = (node) => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
            const method = node.expression.name.text;
            if (optionMethods.has(method) || criteriaMethods.has(method)) {
                const values = whereObjects(node, method, source).flatMap((where) => whereValues(where));
                if (values.length) {
                    const scope = collectScope(enclosingFunctions(node), node.pos);
                    for (const { key, value } of values) {
                        const taint = taintOf(value, scope);
                        if (!taint) continue;
                        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
                        findings.push({
                            file,
                            line: line + 1,
                            method,
                            key,
                            value: value.getText(source),
                            source: taint.source,
                            ...verdict(taint, node, source, file, schemas, value.getText(source)),
                        });
                    }
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return findings;
}

const walk = (dir) =>
    readdirSync(dir)
        .sort()
        .flatMap((name) => {
            const full = join(dir, name);
            if (statSync(full).isDirectory()) return name === "migration" ? [] : walk(full);
            return name.endsWith(".ts") && !name.endsWith(".d.ts") && !name.endsWith(".test.ts") ? [full] : [];
        });

export function auditTree(dir = join(root, "src")) {
    const schemas = JSON.parse(readFileSync(join(root, "assets/schemas.json"), "utf8"));
    return walk(dir).flatMap((file) => auditSource(relative(root, file), readFileSync(file, "utf8"), schemas));
}

if (import.meta.main) {
    const findings = auditTree();
    const dangerous = findings.filter((finding) => finding.dangerous);
    for (const finding of process.argv.includes("--all") ? findings : dangerous)
        console.log(
            `${finding.dangerous ? "UNSAFE" : "ok    "} ${finding.file}:${finding.line} ${finding.method} ${finding.key}: ${finding.value} (${finding.note ? `${finding.reason}, ${finding.note}` : finding.reason})`,
        );
    const reasons = Object.entries(Object.groupBy(findings, (finding) => finding.reason)).map(([reason, list]) => `${list.length} ${reason}`);
    console.log(`${findings.length} where values from request input, ${dangerous.length} unsafe. ${reasons.join(", ")}`);
    process.exit(dangerous.length ? 1 : 0);
}
