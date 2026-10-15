const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

const loadRemote = (host, instanceId) => {
    const module = { exports: {} };
    const location = { host, origin: `https://${host}` };
    const window = { GLOBAL_ENV: { INSTANCE_ID: instanceId, INSTANCE_NAME: "Home" } };
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync("client/plugins/fosscordFederation/remote.ts", "utf8"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText,
        {
            module,
            exports: module.exports,
            require: (name) => {
                if (name === "@webpack/common") return { GuildStore: {}, RestAPI: {} };
                if (name === "./join") return { errorText: () => null };
                throw new Error(name);
            },
            window,
            location,
            URL,
            encodeURIComponent,
            decodeURIComponent,
        },
    );
    return module.exports;
};

test("a local user's global username and friend link name the instance", () => {
    const remote = loadRemote("chat.home.example", "home.example");
    assert.equal(remote.globalHandle({ username: "alice" }), "alice@home.example");
    assert.equal(remote.friendLink({ username: "alice" }), "https://chat.home.example/add/alice");
    assert.equal(remote.globalHandle(null), null);
    assert.equal(remote.friendLink({}), null);
});

test("a remote user's friend link points at their own instance", () => {
    const remote = loadRemote("home.example", "home.example");
    assert.equal(remote.globalHandle({ username: "bob@other.example" }), "bob@other.example");
    assert.equal(remote.friendLink({ username: "bob@other.example" }), "https://other.example/add/bob");
    assert.equal(remote.friendLink({ username: "bob@localhost:3001" }), "http://localhost:3001/add/bob");
});

test("add friend accepts a pasted friend link or handle", () => {
    const remote = loadRemote("home.example", "home.example");
    assert.equal(remote.friendInput("https://other.example/add/bob"), "bob@other.example");
    assert.equal(remote.friendInput("other.example/add/bob/"), "bob@other.example");
    assert.equal(remote.friendInput("https://home.example/add/alice"), "alice");
    assert.equal(remote.friendInput("alice@home.example"), "alice");
    assert.equal(remote.friendInput("bob@other.example"), "bob@other.example");
    assert.equal(remote.friendInput("carol"), "carol");
    assert.equal(remote.friendInput("https://other.example/add/%E0%A4%A"), "https://other.example/add/%E0%A4%A");
    assert.ok(remote.isHandle(remote.friendInput("https://other.example/add/bob")));
});

test("the add friend page escapes the name and only serves local users", () => {
    const source = fs.readFileSync("src/bundle/TestClient.ts", "utf8");
    assert.match(source, /app\.get\("\/add\/:name"/);
    assert.match(source, /federated_instance: IsNull\(\), bot: false, deleted: false/);
    assert.match(source, /escapeHtml\(name\)/);
    assert.match(source, /escapeHtml\(handle\)/);
    const page = fs.readFileSync("assets/public/add-friend.html", "utf8");
    for (const placeholder of ["__FRIEND_NAME__", "__FRIEND_HANDLE__", "__OPEN_HREF__", "__OPEN_GRAPH__"]) assert.ok(page.includes(placeholder), placeholder);
    assert.doesNotMatch(page, /[–—]/);
});
