const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const murmur = require("murmurhash-js/murmurhash3_gc");

const experiments = (() => {
    const module = { exports: {} };
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync("src/util/util/ApexExperiments.ts", "utf8"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
        }).outputText,
        { module, exports: module.exports, require: (name) => (name === "./Config" ? { Config: { get: () => ({}) } } : require(name)) },
    );
    return module.exports;
})();

test("signed in users get the user report experiment so the profile menu offers Report User Profile", () => {
    const assignments = JSON.parse(JSON.stringify(experiments.getUserExperiments("1559601132664270913")));
    const reporting = assignments.find(([hash]) => hash === murmur("2023-09_iar_user_reporting"));
    assert.deepEqual(reporting, [murmur("2023-09_iar_user_reporting"), 0, 1, 0, 0, -1, 0, 0]);
    assert.deepEqual(JSON.parse(JSON.stringify(experiments.getUserExperiments())), []);
});

test("READY and the experiments endpoint both send the user experiments", () => {
    assert.match(fs.readFileSync("src/gateway/opcodes/Identify.ts", "utf8"), /experiments: getUserExperiments\(this\.user_id\)/);
    assert.match(fs.readFileSync("src/api/routes/experiments.ts", "utf8"), /assignments: getUserExperiments\(req\.user_id\)/);
});

test("linked users answer an empty family so the report modal opens without an error", () => {
    const routes = [];
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync("dist/api/routes/users/@me/linked-users.js", "utf8"), {
        module,
        exports: module.exports,
        require: (name) => {
            if (name === "express") return { Router: () => ({ get: (path, options, handler) => routes.push({ path, handler }) }) };
            if (name === "@spacebar/api/middlewares") return { route: (options) => options };
            throw new Error(`unexpected import ${name}`);
        },
    });
    const [route] = routes;
    assert.equal(route.path, "/");
    let body;
    route.handler({}, { json: (value) => (body = JSON.parse(JSON.stringify(value))) });
    assert.deepEqual(body, { linked_users: [], users: [] });
});
