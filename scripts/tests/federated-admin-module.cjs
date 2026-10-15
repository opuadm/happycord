/* SPDX-License-Identifier: AGPL-3.0-only */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const source = path.join(__dirname, "../../src/api/util/utility/federatedAdmin.ts");

exports.loadFederatedAdmin = (HTTPError) => {
    const module = { exports: {} };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(source, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
        module,
        exports: module.exports,
        require: (name) => {
            if (name === "lambert-server/HTTPError") return { HTTPError };
            throw Error(name);
        },
    });
    return module.exports;
};
