const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
    AUTHORSHIP_FIELD,
    AUTHORSHIP_STATE_FIELD,
    UNVERIFIED_AUTHOR_ID,
    applyAuthorshipPlaceholders,
    authorshipInstances,
    checkAuthorship,
    contentDigest,
    guardWireMessages,
    readAuthorship,
    signAuthorship,
    snowflakeTime,
} = require("../../src/util/util/federation/Authorship.ts");
const { rawPublicKey } = require("../../src/util/util/federation/Protocol.ts");

const pair = () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    return { privateKey, publicKey: rawPublicKey(publicKey) };
};
const home = pair();
const third = pair();
const rogue = pair();

const HOST = "host.example";
const HOME = "home.example";
const THIRD = "third.example";
const EPOCH = 1420070400000;
const NOW = Date.parse("2026-10-13T12:00:00.000Z");
const snowflake = (time, n = 0) => ((BigInt(time - EPOCH) << 22n) + BigInt(n)).toString();
const id = (time, instance = HOST, n = 0) => `@${snowflake(time, n)}@${instance}`;

const alice = `@${snowflake(NOW - 86_400_000, 7)}@${HOME}`;
const carol = `@${snowflake(NOW - 86_400_000, 9)}@${THIRD}`;
const mallory = `@${snowflake(NOW - 86_400_000, 11)}@${HOST}`;
const channel = id(NOW - 86_400_000, HOST, 1);

const body = {
    content: "hi <@@123456789012345678@home.example>\r\nthere ",
    nonce: "1290000000000000555",
    embeds: [{ title: "Notes", description: "see below", fields: [{ name: "a", value: "b" }] }],
    sticker_ids: [id(NOW - 86_400_000, HOST, 40)],
    message_reference: { message_id: id(NOW - 3_600_000, HOST, 3), fail_if_not_exists: false },
    attachments: [{ id: "0", filename: "cat photo.png", description: "a cat", uploaded_filename: "1/CLOUD_x/0/cat_photo.png" }],
};
const signedAttachments = [{ filename: "cat_photo.png", description: "a cat", size: 1234, sha256: "abc" }];

const finalMessage = (overrides = {}) => ({
    id: id(NOW, HOST, 50),
    channel_id: channel,
    type: 19,
    author: { id: alice, username: "alice" },
    content: "hi <@@123456789012345678@home.example>\nthere",
    nonce: body.nonce,
    timestamp: new Date(NOW).toISOString(),
    embeds: [
        { type: "rich", title: "Notes", description: "see below", fields: [{ name: "a", value: "b", inline: false }] },
        { type: "link", url: "https://example.com", title: "Example" },
    ],
    sticker_items: [{ id: id(NOW - 86_400_000, HOST, 40), name: "cat", format_type: 1 }],
    message_reference: { message_id: id(NOW - 3_600_000, HOST, 3), channel_id: channel, guild_id: id(NOW - 86_400_000, HOST, 2) },
    attachments: [{ id: id(NOW, HOST, 51), filename: "cat_photo.png", description: "a cat", size: 1234, url: "https://host.example/attachments/x/y/cat_photo.png" }],
    ...overrides,
});

const createToken = (overrides = {}, key = home.privateKey) =>
    signAuthorship({ author: alice, channel, nonce: body.nonce, attachments: signedAttachments, at: new Date(NOW), ...overrides }, body, key);

test("a statement signed before the host assigns an id verifies against the message the host made", () => {
    const token = createToken();
    const result = checkAuthorship(finalMessage(), token, { publicKey: home.publicKey, now: NOW });
    assert.equal(result.ok, true, result.reason);
    assert.equal(readAuthorship(token).message, null);
    assert.equal(readAuthorship(token).nonce, body.nonce);
});

test("a statement is refused for another key, author, channel, nonce or creation time", () => {
    const token = createToken();
    const refused = (message, options = {}) => checkAuthorship(message, "token" in options ? options.token : token, { publicKey: home.publicKey, now: NOW, ...options });
    assert.equal(refused(finalMessage(), { publicKey: rogue.publicKey }).ok, false);
    assert.equal(refused(finalMessage(), { token: createToken({}, rogue.privateKey) }).ok, false);
    assert.equal(refused(finalMessage({ author: { id: `@${snowflake(NOW - 86_400_000, 8)}@${HOME}` } })).ok, false);
    assert.equal(refused(finalMessage({ channel_id: id(NOW - 86_400_000, HOST, 99) })).ok, false);
    assert.equal(refused(finalMessage({ nonce: "other" })).ok, false);
    assert.equal(refused(finalMessage({ id: id(NOW + 11 * 60_000, HOST, 50) })).ok, false);
    assert.equal(refused(finalMessage({ id: id(NOW - 11 * 60_000, HOST, 50) })).ok, false);
    assert.equal(refused(finalMessage(), { token: `${token.split(".")[0]}.${token.split(".")[1].replace(/^./, (c) => (c === "A" ? "B" : "A"))}` }).ok, false);
    assert.equal(refused(finalMessage(), { token: undefined }).ok, false);
    assert.equal(refused(finalMessage(), { publicKey: null }).ok, false);
});

test("the content hash covers every field rendered as the author's words", () => {
    const base = finalMessage();
    const digest = contentDigest(base);
    const changed = (patch) => contentDigest({ ...base, ...patch }) !== digest;
    assert.ok(changed({ content: "hi" }));
    assert.ok(changed({ embeds: [{ ...base.embeds[0], title: "Other" }] }));
    assert.ok(changed({ embeds: [{ ...base.embeds[0], description: "other" }] }));
    assert.ok(changed({ embeds: [{ ...base.embeds[0], url: "https://evil.example" }] }));
    assert.ok(changed({ embeds: [{ ...base.embeds[0], fields: [{ name: "a", value: "c" }] }] }));
    assert.ok(changed({ embeds: [{ ...base.embeds[0], author: { name: "Someone" } }] }));
    assert.ok(changed({ embeds: [{ ...base.embeds[0], footer: { text: "signed" } }] }));
    assert.ok(changed({ embeds: [...base.embeds, { title: "Injected" }] }));
    assert.ok(changed({ sticker_items: [] }));
    assert.ok(changed({ message_reference: { message_id: id(NOW - 3_600_000, HOST, 4) } }));
    assert.ok(changed({ message_reference: { ...base.message_reference, type: 1 } }));
    assert.ok(changed({ message_reference: undefined }));
    assert.ok(changed({ poll: { question: { text: "Q" }, answers: [{ poll_media: { text: "yes" } }] } }));
    const poll = { question: { text: "Q" }, answers: [{ poll_media: { text: "yes" } }, { poll_media: { text: "no" } }], allow_multiselect: false };
    const withPoll = contentDigest({ ...base, poll });
    assert.notEqual(contentDigest({ ...base, poll: { ...poll, question: { text: "Q2" } } }), withPoll);
    assert.notEqual(contentDigest({ ...base, poll: { ...poll, answers: [poll.answers[1], poll.answers[0]] } }), withPoll);
    assert.notEqual(contentDigest({ ...base, poll: { ...poll, allow_multiselect: true } }), withPoll);
    assert.equal(contentDigest({ ...base, poll: { ...poll, expiry: "2026-10-14T00:00:00.000Z", results: { answer_counts: [] } } }), withPoll);
    assert.ok(!changed({ embeds: [base.embeds[0]] }), "link previews the host adds aren't the author's words");
    assert.ok(!changed({ content: `  ${base.content}\r\n` }), "line endings and outer whitespace are normalized like the host does");
    assert.ok(!changed({ embeds: [{ ...base.embeds[0], color: 255, image: { url: "https://x" } }] }));
});

test("attachments must match by name, alt text and size", () => {
    const token = createToken();
    const check = (attachments) => checkAuthorship(finalMessage({ attachments }), token, { publicKey: home.publicKey, now: NOW }).ok;
    const genuine = finalMessage().attachments;
    assert.equal(check(genuine), true);
    assert.equal(check([{ ...genuine[0], filename: "cat photo.png" }]), true);
    assert.equal(check([{ ...genuine[0], size: 9999 }]), false);
    assert.equal(check([{ ...genuine[0], filename: "dog.png" }]), false);
    assert.equal(check([{ ...genuine[0], description: "a dog" }]), false);
    assert.equal(check([]), false);
    assert.equal(check([...genuine, { ...genuine[0], id: id(NOW, HOST, 52) }]), false);
    const unknownSize = createToken({ attachments: [{ ...signedAttachments[0], size: null }] });
    assert.equal(checkAuthorship(finalMessage({ attachments: [{ ...genuine[0], size: 77 }] }), unknownSize, { publicKey: home.publicKey, now: NOW }).ok, true);
});

test("an edit needs a statement for the new content, and a stale one is refused", () => {
    const original = finalMessage();
    const edited = { ...original, content: "edited text", edited_timestamp: new Date(NOW + 60_000).toISOString() };
    const stale = createToken();
    assert.equal(checkAuthorship(edited, stale, { publicKey: home.publicKey, now: NOW + 60_000 }).ok, false);
    const fresh = signAuthorship({ author: alice, channel, message: original.id, attachments: signedAttachments, at: new Date(NOW + 60_000) }, edited, home.privateKey);
    assert.equal(checkAuthorship(edited, fresh, { publicKey: home.publicKey, now: NOW + 60_000 }).ok, true);
    assert.equal(checkAuthorship({ ...edited, id: id(NOW, HOST, 60) }, fresh, { publicKey: home.publicKey, now: NOW + 60_000 }).ok, false);
    assert.equal(checkAuthorship(original, fresh, { publicKey: home.publicKey, now: NOW + 60_000 }).ok, false);
});

test("a create statement can't be reused for a second message", () => {
    const token = createToken();
    const seen = new Map();
    assert.equal(checkAuthorship(finalMessage(), token, { publicKey: home.publicKey, now: NOW, seen }).ok, true);
    assert.equal(checkAuthorship(finalMessage(), token, { publicKey: home.publicKey, now: NOW, seen }).ok, true);
    assert.equal(checkAuthorship(finalMessage({ id: id(NOW, HOST, 77), nonce: undefined }), token, { publicKey: home.publicKey, now: NOW, seen }).ok, false);
});

test("a forum post statement binds to the new thread", () => {
    const post = { content: "first post" };
    const token = signAuthorship({ author: alice, channel, thread: true, at: new Date(NOW) }, post, home.privateKey);
    const thread = id(NOW, HOST, 80);
    const starter = { id: thread, channel_id: thread, type: 0, author: { id: alice }, content: "first post", attachments: [], embeds: [] };
    assert.equal(checkAuthorship(starter, token, { publicKey: home.publicKey, now: NOW }).ok, true);
    assert.equal(checkAuthorship({ ...starter, channel_id: channel }, token, { publicKey: home.publicKey, now: NOW }).ok, false);
});

const guard = (value, options = {}) =>
    guardWireMessages(value, {
        host: HOST,
        keys: new Map([
            [HOME, home.publicKey],
            [THIRD, third.publicKey],
        ]),
        cutoff: NOW - 3_600_000,
        fresh: false,
        now: NOW,
        ...options,
    });

test("the receiver verifies authors of other instances and leaves the host's own users and system messages alone", () => {
    const own = { id: id(NOW, HOST, 1), channel_id: channel, type: 0, author: { id: mallory }, content: "host user", [AUTHORSHIP_STATE_FIELD]: "verified" };
    const join = { id: id(NOW, HOST, 2), channel_id: channel, type: 7, author: { id: alice }, content: "" };
    const genuine = { ...finalMessage(), [AUTHORSHIP_FIELD]: createToken() };
    const forged = { ...finalMessage({ id: id(NOW, HOST, 3), nonce: undefined, content: "I never said this" }) };
    const forgedThird = { ...finalMessage({ id: id(NOW, HOST, 4), nonce: undefined, author: { id: carol }, attachments: [], content: "fake carol" }) };
    const signedByRogue = {
        ...forgedThird,
        id: id(NOW, HOST, 5),
        [AUTHORSHIP_FIELD]: signAuthorship({ author: carol, channel, at: new Date(NOW) }, forgedThird, rogue.privateKey),
    };
    const list = [own, join, genuine, forged, forgedThird, signedByRogue];
    assert.deepEqual([...authorshipInstances(list, HOST)].sort(), [HOME, THIRD]);
    const result = guard(list);
    assert.equal(result.refused, 3);
    assert.equal(own[AUTHORSHIP_STATE_FIELD], undefined, "a host can't mark its own messages");
    assert.equal(join[AUTHORSHIP_STATE_FIELD], undefined);
    assert.equal(genuine[AUTHORSHIP_STATE_FIELD], "verified");
    assert.equal(genuine[AUTHORSHIP_FIELD], undefined, "the statement isn't passed to clients");
    assert.equal(forged[AUTHORSHIP_STATE_FIELD], "unverified");
    assert.equal(forgedThird[AUTHORSHIP_STATE_FIELD], "unverified");
    assert.equal(signedByRogue[AUTHORSHIP_STATE_FIELD], "unverified");
});

test("messages from before the cutoff stay readable in history but a new message always needs a statement", () => {
    const old = finalMessage({ id: id(NOW - 2 * 3_600_000, HOST, 1), nonce: undefined, content: "from last year" });
    assert.equal(guard(old).top, "legacy");
    const event = finalMessage({ id: id(NOW - 2 * 3_600_000, HOST, 2), nonce: undefined });
    assert.equal(guard(event, { fresh: true }).top, "unverified");
    const reply = finalMessage({ id: id(NOW, HOST, 3), nonce: undefined, referenced_message: finalMessage({ id: id(NOW - 2 * 3_600_000, HOST, 4), nonce: undefined }) });
    reply[AUTHORSHIP_FIELD] = "x";
    guard(reply, { fresh: true });
    assert.equal(reply.referenced_message[AUTHORSHIP_STATE_FIELD], "legacy");
    assert.equal(reply[AUTHORSHIP_STATE_FIELD], "unverified");
    const recent = finalMessage({ id: id(NOW - 60_000, HOST, 5), nonce: undefined });
    assert.equal(guard(recent).top, "unverified");
    assert.ok(snowflakeTime(old.id) < NOW - 3_600_000);
});

test("link previews on a message of another instance need a link in its text", () => {
    const quiet = finalMessage({
        id: id(NOW, HOST, 9),
        nonce: undefined,
        content: "no links here",
        embeds: [
            { type: "article", title: "Fake quote" },
            { type: "rich", title: "Notes" },
        ],
    });
    guard(quiet);
    assert.deepEqual(
        quiet.embeds.map((embed) => embed.type),
        ["rich"],
    );
});

test("unverified messages keep their text under a placeholder author", () => {
    const forged = finalMessage({ id: id(NOW, HOST, 10), nonce: undefined, content: "I never said this", member: { roles: [] } });
    const page = { messages: [[forged]] };
    guard(page);
    applyAuthorshipPlaceholders(page);
    const shown = page.messages[0][0];
    assert.equal(shown.author.id, UNVERIFIED_AUTHOR_ID);
    assert.equal(shown.author.global_name, "Unverified author");
    assert.equal(shown.content, "I never said this");
    assert.equal(shown.member, undefined);
    const genuine = { ...finalMessage(), [AUTHORSHIP_FIELD]: createToken() };
    guard(genuine);
    applyAuthorshipPlaceholders(genuine);
    assert.equal(genuine.author.id, alice);
});
