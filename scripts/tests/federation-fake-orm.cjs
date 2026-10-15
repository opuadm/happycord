const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

const In = (values) => ({ op: "in", values: [...values] });
const Not = (inner) => ({ op: "not", inner });
const IsNull = () => ({ op: "null" });
const LessThan = (value) => ({ op: "lt", value });

const matchValue = (actual, expected) => {
    if (expected && typeof expected === "object" && expected.op) {
        if (expected.op === "in") return expected.values.includes(actual);
        if (expected.op === "null") return actual === null || actual === undefined;
        if (expected.op === "not") return !matchValue(actual, expected.inner);
        if (expected.op === "lt") return actual < expected.value;
    }
    return actual === expected;
};

const matches = (row, where) => Object.entries(where ?? {}).every(([key, value]) => value === undefined || matchValue(row[key], value));
const wheres = (where) => (Array.isArray(where) ? where : [where ?? {}]);

function entity(name, keys = ["id"]) {
    const keyOf = (row) => keys.map((key) => row[key]).join(":");
    class Entity {
        constructor(data = {}) {
            Object.assign(this, data);
        }
        async save() {
            const plain = { ...this };
            const index = Entity.rows.findIndex((row) => keyOf(row) === keyOf(plain));
            if (index === -1) Entity.rows.push(plain);
            else Entity.rows[index] = { ...Entity.rows[index], ...Object.fromEntries(Object.entries(plain).filter(([, value]) => value !== undefined)) };
            return this;
        }
        async remove() {
            Entity.rows = Entity.rows.filter((row) => keyOf(row) !== keyOf(this));
        }
        toJSON() {
            return { ...this };
        }
        toPublicUser() {
            return { id: this.id, username: this.username, discriminator: this.discriminator ?? "0", global_name: this.global_name ?? null, avatar: this.avatar ?? null };
        }
    }
    Object.defineProperty(Entity, "name", { value: name });
    Entity.rows = [];
    Entity.create = (data = {}) => new Entity(data);
    Entity.find = async (options = {}) => {
        const found = Entity.rows.filter((row) => wheres(options.where).some((where) => matches(row, where)));
        const [orderKey, direction] = Object.entries(options.order ?? {})[0] ?? [];
        if (orderKey) found.sort((a, b) => (a[orderKey] < b[orderKey] ? -1 : a[orderKey] > b[orderKey] ? 1 : 0) * (direction === "DESC" ? -1 : 1));
        return found.slice(0, options.take ?? found.length).map((row) => new Entity({ ...row }));
    };
    Entity.findOne = async (options = {}) => (await Entity.find(options))[0] ?? null;
    Entity.findOneOrFail = async (options = {}) => {
        const found = await Entity.findOne(options);
        if (!found) throw new Error(`${name} not found`);
        return found;
    };
    Entity.exists = async (options = {}) => !!(await Entity.findOne(options));
    Entity.count = async (options = {}) => (await Entity.find(options)).length;
    Entity.delete = async (where) => {
        const before = Entity.rows.length;
        Entity.rows = Entity.rows.filter((row) => !wheres(where).some((entry) => matches(row, entry)));
        return { affected: before - Entity.rows.length };
    };
    Entity.update = async (where, values) => {
        for (const row of Entity.rows) if (wheres(where).some((entry) => matches(row, entry))) Object.assign(row, values);
        return {};
    };
    Entity.insert = async (data) => {
        if (Entity.rows.some((row) => keyOf(row) === keyOf(data))) throw new Error(`duplicate ${name}`);
        Entity.rows.push({ ...data });
        return {};
    };
    Entity.increment = async () => ({});
    Entity.decrement = async () => ({});
    Entity.upsert = async (data) => new Entity(data).save();
    return Entity;
}

const transpile = (file) => ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

const passThroughAuthorship = {
    acceptRelayAuthorship: async () => null,
    attachStoredAuthorship: async (value) => value,
    authoredRelay: () => null,
    guardIncoming: async () => ({ top: null, refused: 0 }),
    homeAuthorship: async () => null,
    reportAuthorshipMismatch: async () => undefined,
};

const unmoved = {
    aliasCanonical: (canonical) => canonical,
    normalizeMoved: (value) => value,
};

const authorshipExports = () => require("../../src/util/util/federation/Authorship.ts");

const load = (file, imports, globals = {}) => {
    const module = { exports: {} };
    const resolved = { "./federationAuthorship": passThroughAuthorship, "./federationMoves": unmoved, ...imports };
    if (resolved["@spacebar/util"]) resolved["@spacebar/util"] = { ...authorshipExports(), Snowflake: { generate: () => String(Date.now()) }, ...resolved["@spacebar/util"] };
    vm.runInNewContext(transpile(file), {
        module,
        exports: module.exports,
        require: (name) => {
            if (!(name in resolved)) throw new Error(`unexpected import ${name} in ${file}`);
            return resolved[name];
        },
        console,
        URL,
        URLSearchParams,
        Buffer,
        Date,
        JSON,
        Number,
        Math,
        Map,
        Set,
        Promise,
        Object,
        Array,
        String,
        Boolean,
        Error,
        RegExp,
        BigInt,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        ...globals,
    });
    return module.exports;
};

module.exports = { entity, In, IsNull, LessThan, load, Not };
