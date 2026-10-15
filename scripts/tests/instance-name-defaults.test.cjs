const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const client = require("../../src/util/config/types/ClientConfiguration.ts");

function sourceModule(file, resolve, extra = "") {
    const module = { exports: {} };
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync(file, "utf8"), {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2022,
                esModuleInterop: true,
            },
        }).outputText + extra,
        { module, exports: module.exports, process: { env: {} }, console, require: resolve },
    );
    return module.exports;
}

const { GeneralConfiguration } = sourceModule("src/util/config/types/GeneralConfiguration.ts", (name) => {
    if (name === "@spacebar/util") return { Snowflake: { generate: () => "owned-id" } };
    if (name === "./ClientConfiguration") return client;
    return require(name);
});
const { migrate } = sourceModule(
    "src/util/util/Config.ts",
    (name) => {
        if (name === "../config/types/ClientConfiguration") return client;
        if (name === "../config/types/AutomodConfiguration") return require("../../src/util/config/types/AutomodConfiguration.ts");
        if (name === "../imports" || name === "../config" || name === "../../database/entities") return {};
        return require(name);
    },
    "\nmodule.exports.migrate = replaceStaleDefaults;",
);

function currentRevision() {
    const config = {};
    migrate(config);
    return config.defaultsRevision;
}

test("fresh client and general defaults use the configured Meowcord name", () => {
    assert.equal(client.DEFAULT_INSTANCE_NAME, "Meowcord");
    assert.equal(new client.ClientConfiguration().instanceName, "Meowcord");
    assert.equal(new GeneralConfiguration().instanceName, "Meowcord");
});

test("previous default names migrate once on a serialized older configuration", () => {
    const config = JSON.parse(
        JSON.stringify({
            defaultsRevision: currentRevision() - 2,
            client: { instanceName: "Fosscord", icon: "/owned.png" },
            general: { instanceName: "Fosscord" },
        }),
    );
    migrate(config);
    assert.equal(config.client.instanceName, "Meowcord");
    assert.equal(config.general.instanceName, "Meowcord");
    assert.equal(config.client.icon, "/owned.png");
    assert.equal(config.defaultsRevision, currentRevision());
    config.client.instanceName = "Fosscord";
    config.general.instanceName = "Fosscord";
    migrate(config);
    assert.equal(config.client.instanceName, "Fosscord");
    assert.equal(config.general.instanceName, "Fosscord");
});

test("default-name migration preserves custom client and general names independently", () => {
    for (const names of [
        ["Owned chat", "Owned server"],
        ["Owned chat", "Fosscord"],
        ["Fosscord", "Owned server"],
    ]) {
        const config = { client: { instanceName: names[0] }, general: { instanceName: names[1] } };
        migrate(config);
        assert.equal(config.client.instanceName, names[0] === "Fosscord" ? "Meowcord" : names[0]);
        assert.equal(config.general.instanceName, names[1] === "Fosscord" ? "Meowcord" : names[1]);
    }
});
