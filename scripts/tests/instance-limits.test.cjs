const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");

const plugin = fs.readFileSync("client/plugins/fosscordLimits/index.ts", "utf8");

const ident = "[A-Za-z_$][\\w$]*";
const toTestPattern = (literal) => new RegExp(literal.slice(1, -1).replace(/\\i/g, ident));

const matches = [...plugin.matchAll(/match: (\/(?:\\.|[^/\n])+?\/)/g)].map((match) => match[1]);

test("every fosscordLimits patch matches the real client code it targets", () => {
    assert.ok(matches.length >= 20, `expected at least 20 patch patterns, found ${matches.length}`);
    const fixtures = [
        'return t?.isStaff()?s.$aF:e&&(0,r.ki)(t,l.PremiumTypes.TIER_2)&&(0,a.J)("getGroupDMRecipientLimit").enabled?25:s.wLU',
        "function l(e){return a.Ay.canUseIncreasedMessageLength(e.getCurrentUser())?s.CS1:s.uvi}",
        "let p=_?A.CS1:A.uvi;if(l.length>p)",
        "let A=n(652215).CS1+500",
        "uploadPromptCharacterCount:el.CS1,maxCharacterCount:$??e3",
        "premiumMaxMessageLength:M.CS1,onClick:()=>{(0,S.pX)(M.BVt.APPLICATION_STORE)}",
        "defaultConfig:{maxLength:r.NA2},variations:{0:{maxLength:r.NA2},1:{maxLength:r.wKD}}",
        "canUseIncreasedGuildCap(t)||t?.isStaff()?s.cZu:s.qlD",
        "text:s?en.intl.formatToPlainString(en.t.z9peav,{maxFriends:et.$4X})",
        'options:[{name:"new_nick",displayName:"new_nick",type:_.n4.STRING,get description(){return P.intl.string(P.t.WTSzVu)},maxLength:D.zzC}]',
        "function o(){return i.A.getGuildCount()>=s.qlD&&!l(r.default.getCurrentUser())}",
        "getMaxAttachmentsCount(){return s.XgB}",
        "let t=A.DEFAULT_EMOJI_SLOTS+(e.premiumFeatures?.additionalEmojiSlots??0);",
        "return Math.max(e.features.has(E.GuildFeatures.MORE_EMOJI)?A.EMOJI_MAX_SLOTS_MORE:A.DEFAULT_EMOJI_SLOTS,t)",
        "function S(e,t){return null!=t&&t.features.has(E.GuildFeatures.MORE_STICKERS)&&e===E.TVA.TIER_3?a.K.MAX_STICKER_SLOTS:h.d8[e]}",
        "function x(e){let t=h.OW+(e.premiumFeatures?.additionalSoundSlots??0);return Math.max(e.features.has(E.GuildFeatures.MORE_SOUNDBOARD)?h.xs:h.OW,t)}",
        'label:"username",placeholder:"Choose wisely",maxLength:32',
        'name:"pronouns",value:"",maxLength:40',
        'label:"displayName",placeholder:"opuayt",maxLength:32',
        "{[L.TVA.NONE]:e8,[L.TVA.TIER_1]:10,[L.TVA.TIER_2]:15,[L.TVA.TIER_3]:30}",
    ];
    const unmatched = fixtures.filter((fixture) => !matches.some((literal) => toTestPattern(literal).test(fixture)));
    assert.deepEqual(unmatched, []);
});

test("fosscordLimits reads instance limits without touching the plugin runtime", () => {
    assert.doesNotMatch(plugin, /\$self\./);
    for (const [path, fallback] of [
        ["message?.maxCharacters", "4000"],
        ["message?.maxAttachments", "15"],
        ["user?.maxBio", "190"],
        ["user?.maxGuilds", "200"],
        ["user?.maxFriends", "5000"],
        ["user?.maxUsername", "32"],
        ["channel?.maxGroupDmRecipients", "25"],
        ["guild?.maxEmojis", "2000"],
        ["guild?.maxStickers", "500"],
    ])
        assert.match(plugin, new RegExp(`window\\.GLOBAL_ENV\\?\\.INSTANCE_LIMITS\\?\\.${path.replaceAll("?", "\\?")}\\|\\|${fallback}`));
});

test("fosscordLimits replacements keep the surrounding client code intact", () => {
    const replacements = [...plugin.matchAll(/replace:\s*("(?:\\.|[^"\n])+?")/g)].map((match) => JSON.parse(match[1]));
    const apply = (fixture) => {
        for (const literal of matches) {
            const pattern = toTestPattern(literal);
            if (pattern.test(fixture)) return fixture.replace(pattern, (...args) => replacements[matches.indexOf(literal)].replace(/\$(\d+)/g, (_, n) => args[Number(n)]));
        }
        return null;
    };
    assert.equal(
        apply("function l(e){return a.Ay.canUseIncreasedMessageLength(e.getCurrentUser())?s.CS1:s.uvi}"),
        "function l(e){return (window.GLOBAL_ENV?.INSTANCE_LIMITS?.message?.maxCharacters||4000)}",
    );
    assert.equal(
        apply("let p=_?A.CS1:A.uvi;if(l.length>p){if(_||null==d){"),
        "let p=(window.GLOBAL_ENV?.INSTANCE_LIMITS?.message?.maxCharacters||4000);if(l.length>p){if(_||null==d){",
    );
    assert.equal(apply("let t=A.DEFAULT_EMOJI_SLOTS+(e.premiumFeatures?.additionalEmojiSlots??0);"), "let t=(window.GLOBAL_ENV?.INSTANCE_LIMITS?.guild?.maxEmojis||2000);");
    assert.equal(
        apply('label:"username",placeholder:"Choose wisely",maxLength:32'),
        'label:"username",placeholder:"Choose wisely",maxLength:(window.GLOBAL_ENV?.INSTANCE_LIMITS?.user?.maxUsername||32)',
    );
    assert.equal(apply('name:"pronouns",value:"",maxLength:40'), 'name:"pronouns",value:"",maxLength:(window.GLOBAL_ENV?.INSTANCE_LIMITS?.user?.maxPronouns||40)');
    assert.equal(
        apply("function S(e,t){return null!=t&&t.features.has(E.GuildFeatures.MORE_STICKERS)&&e===E.TVA.TIER_3?a.K.MAX_STICKER_SLOTS:h.d8[e]}"),
        "function S(e,t){return (window.GLOBAL_ENV?.INSTANCE_LIMITS?.guild?.maxStickers||500)}",
    );
    assert.equal(
        apply("function o(){return i.A.getGuildCount()>=s.qlD&&!l(r.default.getCurrentUser())}"),
        "function o(){return i.A.getGuildCount()>=(window.GLOBAL_ENV?.INSTANCE_LIMITS?.user?.maxGuilds||200)&&!l(r.default.getCurrentUser())}",
    );
    assert.equal(apply("getMaxAttachmentsCount(){return s.XgB}"), "getMaxAttachmentsCount(){return (window.GLOBAL_ENV?.INSTANCE_LIMITS?.message?.maxAttachments||15)}");
    assert.equal(
        apply("{[L.TVA.NONE]:e8,[L.TVA.TIER_1]:10,[L.TVA.TIER_2]:15,[L.TVA.TIER_3]:30}"),
        "{[L.TVA.NONE]:(window.GLOBAL_ENV?.INSTANCE_LIMITS?.guild?.maxStickers||500),[L.TVA.TIER_1]:10,[L.TVA.TIER_2]:15,[L.TVA.TIER_3]:30}",
    );
});

test("every admin panel limit reaches the web client", () => {
    const testClient = fs.readFileSync("src/bundle/TestClient.ts", "utf8");
    assert.match(testClient, /INSTANCE_LIMITS:/);
    assert.match(testClient, /instanceLimits\(\)/);
    assert.match(testClient, /Config\.get\(\)\.limits\.user/);
    assert.match(testClient, /Config\.get\(\)\.limits\.message/);
    for (const key of ["maxBio", "maxGuilds", "maxFriends", "maxUsername", "maxCharacters", "maxAttachments", "maxEmojis", "maxStickers", "maxGroupDmRecipients"])
        assert.match(plugin, new RegExp(key));
    const fallback = fs.readFileSync("assets/client_patches/80-instance-limits.js", "utf8");
    assert.match(fallback, /INSTANCE_LIMITS/);
    assert.match(fallback, /policies\/instance\/config/);
    assert.match(fallback, /aria-labelledby/);
    assert.match(fallback, /closest/);
    assert.match(fallback, /fieldsForAlert/);
    assert.match(fallback, /createTreeWalker/);
    assert.match(fallback, /stickers-tab/);
    for (const key of ["maxBio", "maxPronouns", "maxUsername", "maxName", "maxTopic"]) assert.match(fallback, new RegExp(key));
    const helper = fs.readFileSync("src/util/util/InstanceLimits.ts", "utf8");
    for (const key of [
        "maxGuilds",
        "maxUsername",
        "maxFriends",
        "maxBio",
        "maxPronouns",
        "maxRoles",
        "maxEmojis",
        "maxStickers",
        "maxMembers",
        "maxChannels",
        "maxCharacters",
        "maxPins",
        "maxTopic",
        "maxWebhooks",
        "maxName",
        "maxGroupDmRecipients",
    ])
        assert.match(helper, new RegExp(key));
});

test("instance config exposes limits to signed-in users instead of an empty body", () => {
    const source = fs.readFileSync("src/api/routes/policies/instance/config.ts", "utf8");
    assert.match(source, /outputtedConfig \?\?=/);
    assert.match(source, /limits: instanceLimits\(\)/);
});

test("admin limit settings are enforced by handlers instead of static schema caps", () => {
    const source = fs.readFileSync("src/api/routes/admin/users/#user_id/index.ts", "utf8");
    assert.ok(source.includes("Config.get().limits.user"));
    for (const snippet of ["username.length > maxUsername", "body.pronouns.length > maxPronouns", "global_name.length > maxUsername", "body.bio.length > maxBio"])
        assert.ok(source.includes(snippet));
    const pomelo = fs.readFileSync("src/api/util/utility/pomelo.ts", "utf8");
    assert.ok(pomelo.includes("Config.get().limits.user"));
    assert.ok(pomelo.includes("username.length > maxUsername"));
    assert.ok(!fs.readFileSync("src/api/routes/admin/conversations/#user_id/index.ts", "utf8").includes("Math.min(4000"));
    const channel = fs.readFileSync("src/api/routes/admin/guilds/#guild_id/channels/#channel_id.ts", "utf8");
    assert.ok(channel.includes("Config.get().limits.channel"));
    assert.ok(channel.includes("body.name.trim().length > maxName"));
    assert.ok(channel.includes("body.topic.length > maxTopic"));
});

test("generated schemas no longer clip custom admin limits", () => {
    const schemas = JSON.parse(fs.readFileSync("assets/schemas.json", "utf8"));
    const get = (name, prop) => schemas[name]?.properties?.[prop] ?? {};
    assert.equal(get("AdminUserUpdateSchema", "username").maxLength, undefined);
    assert.equal(get("AdminUserUpdateSchema", "pronouns").maxLength, undefined);
    assert.equal(get("AdminUserUpdateSchema", "global_name").maxLength, undefined);
    assert.equal(get("AdminAnnouncementCreateSchema", "body").maxLength, undefined);
    assert.equal(get("AdminChannelUpdateSchema", "name").maxLength, undefined);
    assert.equal(get("AdminChannelUpdateSchema", "topic").maxLength, undefined);
    assert.equal(get("AdminChannelCreateSchema", "topic").maxLength, undefined);
    assert.equal(get("UserModifySchema", "global_name").maxLength, undefined);
});

test("admin dashboard inputs follow the configured limits", () => {
    const admin = fs.readFileSync("assets/public/admin/admin.js", "utf8");
    assert.match(admin, /maxlength="\$\{maxUsername\}"/);
    assert.match(admin, /maxlength="\$\{maxPronouns\}"/);
    assert.match(admin, /maxlength="\$\{maxBio\}"/);
    assert.match(admin, /maxlength="\$\{maxMessage\}"/);
    assert.match(admin, /api\("\/admin\/settings"\)/);
});
