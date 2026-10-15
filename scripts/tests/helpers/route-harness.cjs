/* SPDX-License-Identifier: AGPL-3.0-only */
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

class StubError extends Error {
    constructor(message, code = 400) {
        super(message);
        this.code = code;
    }
}

function loadModule(file, stubs, globals = {}) {
    const source = ts.transpileModule(fs.readFileSync(file, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const module = { exports: {} };
    vm.runInNewContext(source, {
        module,
        exports: module.exports,
        Buffer,
        console,
        process,
        URL,
        setTimeout,
        clearTimeout,
        ...globals,
        require(name) {
            if (name in stubs) return stubs[name];
            if (name.startsWith("node:") || ["crypto", "path", "net"].includes(name)) return require(name);
            throw new Error(`unstubbed import ${name} in ${file}`);
        },
    });
    return module.exports;
}

function loadRoutes(file, stubs, globals) {
    const handlers = {};
    const router = new Proxy(
        {},
        {
            get:
                (_, method) =>
                (path, ...args) => {
                    handlers[`${String(method).toUpperCase()} ${path}`] = args.filter((arg) => typeof arg === "function").at(-1);
                    return router;
                },
        },
    );
    loadModule(
        file,
        {
            express: { Router: () => router },
            "@spacebar/api/middlewares": { route: () => () => undefined },
            ...stubs,
        },
        globals,
    );
    return handlers;
}

function response() {
    const res = {
        statusCode: 200,
        body: undefined,
        status(code) {
            res.statusCode = code;
            return res;
        },
        json(body) {
            res.body = body;
            return res;
        },
        send(body) {
            res.body = body;
            return res;
        },
        sendStatus(code) {
            res.statusCode = code;
            return res;
        },
    };
    return res;
}

module.exports = { StubError, loadModule, loadRoutes, response };
