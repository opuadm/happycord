# Federation protocol, version 1

This is the contract between Meowcord instances and the registry for phase 1 of [federation.md](federation.md): the instance directory and global discovery. Chat between instances comes in a later version of this document.

All JSON is UTF-8. Binary values are base64url without padding. Times are ISO 8601 in UTC. An instance id is its lowercase host, with the port when it isn't 443, for example `meow.example` or `localhost:3001`. A canonical object id is `@<snowflake>@<instance id>`.

## Keys

- The registry has one Ed25519 key pair. Its public key, `f0jm9Szfa52pkT0nWkeZK4D1wa3NUZ9hceWaFQLZYrk`, is the default `federation.registry.publicKey` in the server config. The private key lives in Proton Pass (`projects/meowcord/registry_signing_key`) and in the registry Worker as the `REGISTRY_SIGNING_KEY` secret.
- Each instance makes its own Ed25519 key pair on first start and stores it in a file next to `jwt.key`, `federation.key`. The public key is the raw 32 bytes, base64url.

## Signed envelope

Everything signed uses one shape:

```json
{ "payload": "<base64url of the JSON bytes>", "signature": "<base64url Ed25519 signature over the payload bytes>", "key_id": "<string>" }
```

The receiver verifies the signature over the exact decoded payload bytes before parsing them. For the registry, `key_id` is `registry-1`. For an instance, it is the instance id.

## Registry document

`GET https://<registry>/v1/registry` returns a signed envelope. Its payload:

```json
{
  "version": 1,
  "sequence": 1792500000000,
  "issued_at": "2026-10-12T20:00:00.000Z",
  "expires_at": "2026-10-19T20:00:00.000Z",
  "min_protocol": 1,
  "instances": [
    {
      "id": "meow.example",
      "name": "Meow",
      "description": "",
      "icon_url": "https://meow.example/...",
      "url": "https://meow.example",
      "source_url": "https://github.com/...",
      "public_key": "<base64url or null>",
      "protocol": 1,
      "registration": "open",
      "state": "active",
      "listed_at": "2026-10-12T20:00:00.000Z"
    }
  ],
  "blocked": {
    "instances": [{ "id": "bad.example", "reason": "", "at": "..." }],
    "guilds": [{ "id": "@123@meow.example", "reason": "", "at": "..." }],
    "users": [{ "id": "@456@meow.example", "reason": "", "at": "..." }]
  },
  "discovery": [
    {
      "id": "@123@meow.example",
      "instance": "meow.example",
      "name": "Cat pictures",
      "description": "",
      "icon_url": "https://meow.example/icons/...",
      "member_count": 120,
      "invite_url": "https://meow.example/invite/abc",
      "verified_at": "..."
    }
  ]
}
```

- `sequence` only grows. The registry uses the publish time in milliseconds.
- `state` is `active` (federates), `listed` (shown in the directory, no key yet or not running a federating version), `suspended` (shown, not federating) or `blocked`.
- `registration` is `open`, `invite`, `approval` or `closed`.
- `public_key` is null until the registry has read it from the instance's well-known document.
- `discovery` holds every server that an approved instance lists in its signed discovery list, minus the ones the registry operators removed or blocked. An instance only lists servers its own admins verified.
- Fields the registry hasn't read from a well-known document yet are null: `public_key`, `protocol`, `registration` and `icon_url`. `description` is then an empty string. This is the case for instances listed from `instances.json` that don't run a federating version.
- A blocked instance is only in `blocked.instances`, never in `instances`.

An instance accepts a document only when the signature verifies against its configured registry key, `version` is 1, `sequence` is higher than or equal to the last one it accepted, and `expires_at` is in the future. It keeps the last accepted document. When that document expires, federation features turn off until a newer one arrives.

## Instance well-known document

`GET https://<instance>/.well-known/meowcord`, unauthenticated, cacheable for 5 minutes:

```json
{
  "protocol": 1,
  "software": "meowcord",
  "version": "<revision>",
  "id": "meow.example",
  "url": "https://meow.example",
  "name": "Meow",
  "description": "",
  "icon_url": "https://meow.example/...",
  "public_key": "<base64url>",
  "registration": "open",
  "federation": { "enabled": true, "accepts_unlisted": false },
  "discovery_url": "https://meow.example/.well-known/meowcord/discovery"
}
```

`GET https://<instance>/.well-known/meowcord/discovery` returns a signed envelope from the instance (`key_id` is the instance id) whose payload is:

```json
{ "instance": "meow.example", "issued_at": "...", "guilds": [{ "id": "@123@meow.example", "name": "", "description": "", "icon_url": "", "member_count": 0, "invite_url": "" }] }
```

Each guild can also carry `keywords`, up to 10 strings of up to 30 characters, `category_ids`, up to 5 discovery category ids with the primary one first, `presence_count`, the members online, and `active_at`, the hour of the server's last message as an ISO timestamp. All four are optional. A receiver cuts each keyword to 30 characters and keeps the first 10 distinct ones, keeps the first 5 distinct category ids, caps `presence_count` at `member_count`, and uses them to search, filter and order its Other instances list. Older instances send none of them and their servers sort by member count alone.

A guild can also carry `splash_url`, an absolute `http` or `https` URL of its discovery splash, splash or banner in that order, and `welcome`, its welcome screen when the owner turned it on: `{ "description": "", "channels": [{ "name": "", "description": "", "emoji_name": "", "emoji_url": "" }] }`. A receiver keeps 300 characters of the description, the first 5 channels that have a name, 100 characters of each name and description, 32 of `emoji_name`, and `emoji_url` only when it is an `http` or `https` URL, and drops `welcome` when it ends up with neither a description nor a channel. It shows both in the Other instances preview and loads the images through `/federation-media`. Older instances ignore both fields.

A receiver treats a server missing from an instance's freshly fetched list as withdrawn by its owner and stops showing it, even while the registry document still lists it.

It lists only servers whose owner turned on "Show on other instances", which the instance's admins haven't hidden, and which have a permanent invite. A server owner turning the switch on makes the instance create a permanent invite for it if none exists.

## Announcing to the registry

`POST https://<registry>/v1/announce` with a signed envelope from the instance. The payload is:

```json
{ "type": "announce", "id": "meow.example", "sent_at": "...", "nonce": "<16 random bytes, base64url>", "contacts": ["meow@meow.example"], "stats": { "users": 120, "servers": 14, "messages_24h": 3400 } }
```

`contacts` lists up to 10 global handles, `username@id`, of the instance's admins. The instance sends the accounts named in `federation.contacts`, or every local account with the OPERATOR right that isn't deleted, disabled, a bot or a system account when that list is empty. The registry keeps only handles that end in `@<id>` of the announcing instance and stores them privately for its admins. It never puts them in the registry document. An announce without `contacts`, from an older instance, leaves the stored list as it is, and an empty list clears it. Older registries ignore the field.

`stats` is optional. `users` counts local accounts that aren't deleted, bots or system accounts, `servers` counts local servers, and `messages_24h` counts messages local users sent in the last 24 hours. Each is a whole number from 0 to 1,000,000,000. The instance leaves the field out when `federation.announceStats` is off. The registry keeps one set of counts per instance per hour, shows them to its admins and never publishes them. Registries without support for the field ignore it, and an announce without it, from an older instance, stores nothing.

The registry:

1. Refuses a `sent_at` more than 5 minutes off and a nonce it saw in the last 10 minutes.
2. Fetches `https://<id>/.well-known/meowcord` and refuses the announce if its `id` doesn't match or the signature doesn't verify against its `public_key`. This proves the sender controls the domain.
3. Stores or updates the instance as pending review, with the well-known data, then fetches and stores its discovery list as pending.
4. Answers `202` with `{ "status": "pending" | "listed" | "active" | "suspended" | "blocked" }`.

A refused announce gets `{ "error": "<text>" }` with `400` for a malformed envelope or payload, `403` when the signature doesn't verify, `409` for a reused nonce, `413` for a body over 8 KiB, `422` when the well-known document can't be fetched or doesn't match, and `429` with `Retry-After` when rate limited. The registry doesn't follow redirects when it fetches an instance. When an approved instance's well-known document shows a new public key, the registry keeps publishing the old one until an operator accepts the new one.

Instances announce on start, once a day and when an admin presses "Send to registry". It is on by default and an admin can turn it off. An instance never announces when its id is `localhost`, an IP address or a private name.

The registry rate limits announces to 10 per instance id and 30 per IP address or IPv6 /64 per hour, and to 60 per hour across all instance ids it has never seen.

## Instance moves

An instance changes its id by keeping its key and listing the old id in `federation.previousIds`. [change-url.md](../self-hosting/change-url.md) is the operator guide.

### Move statement

The instance signs one statement per previous id with its key, as a signed envelope whose `key_id` is the old id:

```json
{ "type": "instance_move", "v": 1, "from": "old.example", "to": "new.example", "at": "2026-10-14T12:00:00.000Z", "public_key": "<base64url key of new.example>" }
```

It serves the envelopes in its well-known document:

```json
{ "id": "new.example", "public_key": "<base64url>", "moved_from": [{ "payload": "...", "signature": "...", "key_id": "old.example" }] }
```

A receiver accepts a statement only when it verifies against the key it has on record for `from`, `key_id` equals `from`, `from` and `to` are the ids it expects, and `at` is no more than 5 minutes in the future. When `public_key` differs from the key on record the move is a key change. A signed announce envelope from the new id, `{ "type": "announce", "id": "new.example", ... }` with `key_id` set to the new id, also proves a move when it verifies against the old key, since only the holder of that key can sign it.

### In the registry document

The registry document has a `moves` list. Older instances ignore it.

```json
"moves": [{ "from": "old.example", "to": "new.example", "at": "...", "public_key": "<key the old id had>", "proof": { "payload": "...", "signature": "...", "key_id": "old.example" }, "review": "proof" }]
```

- `public_key` is the key the registry had for `from`.
- `proof` is the move statement or the announce the registry checked, or null when a registry admin approved a move without one.
- `review` is `proof` when the registry applied the move because the proof verified with an unchanged key, and `admin` when a registry admin approved it, which the registry requires for every key change.

The old id leaves `instances` and the new id carries its state. The registry imports moves from `previous_ids` in `instances.json`, see [registry.md](../self-hosting/registry.md#moves).

### What an instance checks

An instance records the key of every instance it learns of in `federation_instance_keys`, from the registry document, from peers' well-known documents and from applied moves. For each move, from the registry or sent directly, it:

1. Refuses the move when the registry names another key for `from` than the one on record.
2. Verifies the proof against the key on record, or against the registry's `public_key` when it has no record.
3. Refuses a move of its own id, a move onto its own id unless `from` is one of its previous ids, a move whose `from` the registry still lists as active, and a move to an id whose recorded key differs from the statement's key.
4. Marks a key change as `unverified` unless it comes from the registry with `review` set to `admin`. An admin of the instance can still apply it.
5. Rewrites the rows that name `from`, see [change-url.md](../self-hosting/change-url.md#what-other-instances-rewrite), and keeps the move as an alias from `from` to `to`.

Aliases are folded in the order of `at`, and a later move back removes the earlier alias. Lookups follow at most 8 hops and stop on a cycle. Incoming bodies have canonical ids of an old id rewritten to the new id before they are translated, except inside `encrypted`, `meowcord_authorship`, `e2ee` and `fingerprint`, and message authorship statements verify against both the current and the old canonical ids.

A request signed by an old id is refused with `403` and a message that names the new id. A request signed for one of the receiver's previous ids, from an instance that hasn't applied its move yet, is accepted.

## Instance config

```
federation.enabled                   true
federation.registry.url              https://meowcord-registry.tiag.workers.dev
federation.registry.publicKey        f0jm9Szfa52pkT0nWkeZK4D1wa3NUZ9hceWaFQLZYrk
federation.announce                  true
federation.announceStats             true
federation.allowUnlistedPeers        false
federation.peers                     []
federation.contacts                  []
federation.previousIds               []
federation.discovery.verification    "registry" | "instance"
```

- `previousIds` are ids this instance had before, at most 10. The instance signs a move statement for each one, see [Instance moves](#instance-moves).

- `contacts` are local usernames sent with each announce, at most 10. Empty means every account with the OPERATOR right.
- `announceStats` sends the user, server and message counts with each announce.

- With `verification` set to `registry`, global discovery shows what the registry document lists. With `instance`, the instance's own admins verify servers for their users, from the discovery lists of approved instances and peers.
- `peers` are extra instance ids the admins chose to federate with. They are used only when `allowUnlistedPeers` is true, and never when the registry blocks them.
- Local admins can add their own blocks on top of the registry's, and can't lift a registry block.

# Federation protocol, version 2

Version 2 adds chat between instances: servers, DMs, group DMs, friends, profiles, media, E2EE and voice. Instances announce `"protocol": 2` in their well-known document and accept version 1 registry documents unchanged. Phases 2 to 5 of [federation.md](federation.md) build on it.

## Model

- The host instance is the only authority for a server, DM or group DM. Nothing is merged.
- Each instance stores a shadow user for every remote user it has seen: a normal `users` row with `federated_instance` set, no password and no way to sign in. Its `username` is `name@instance`, so the stock client shows the handle everywhere without a patch.
- The home instance keeps mirror rows for remote servers and DMs its users are in: the guild, its channels, roles, emojis, stickers and members, with `federated_instance` set on the guild and channel rows. Mirrors only change when the host says so. Messages aren't mirrored.
- A user's client only talks to its home instance. A REST call that touches a mirror is relayed to the host, and the host runs it through its own routes as the user's shadow, so permissions, automod, rate limits and validation are the same code as for local users.
- The host forwards gateway events to every home instance that has a user who should see them. The home updates its mirrors and hands the event to those users' sessions.

## Ids

A canonical id is `@<snowflake>@<instance id>`. Both sides use the same translation, keyed by a `federated_objects` table (`canonical` primary key, `local_id` unique, `instance`, `created_at`).

- Outgoing: a local snowflake that maps to a canonical id becomes that id. Any other local snowflake becomes `@<snowflake>@<own id>`.
- Incoming: a canonical id with the own instance id becomes the plain snowflake. Any other canonical id becomes its mapped local id, and an unknown one gets a new mapping when it names the sender or an instance the receiver federates with. Ids of other instances become null. The new local id is a snowflake generated at the timestamp of the original snowflake, never later than now, so sorting and creation times stay right. One request may add at most `federation.limits.newObjectsPerRequest` ids, and each instance at most `federation.limits.objectsPerInstance`; past either the receiver answers `507` with `quota_exceeded`. A body may nest at most 64 levels.
- Only values that are 15 to 20 digit strings are translated, and only under these keys: `id`, keys ending in `_id`, keys ending in `_ids`, `roles`, `mention_roles`, `recipients` when it holds strings, `permission_overwrites[].id`, `parent_id`, `owner_id`, `guild_id`, `channel_id`, `message_id`, `user_id`, `application_id`, `webhook_id`, `sticker_ids`, and the keys of the maps `channel_overrides` and `e2ee_context_keys`. Mentions in message content (`<@id>`, `<@!id>`, `<@&id>`, `<#id>`, `<:name:id>`, `<a:name:id>`) are translated too. An incoming mention with a bare snowflake becomes `<@0>` and the like, so a remote can't point at a local user, role or channel. Encrypted content is never rewritten.
- A user object for a remote user gets `username` set to `name@instance`. A user object for one of the receiver's own users gets the receiver's own row values.
- A request may only assert a user of the sending instance as the actor. Canonical ids of other instances in a body are references and are allowed.

## Signed requests

Every request between instances is HTTPS (plain HTTP only for private ids with `security.allowPrivateNetworkRequests`), through `fetchPublicUrl`, with these headers:

```
Meowcord-Instance: <sender instance id>
Meowcord-Timestamp: <unix milliseconds>
Meowcord-Nonce: <16 random bytes, base64url>
Meowcord-Signature: <base64url Ed25519 signature>
```

The signature covers the UTF-8 bytes of `METHOD\nPATH_WITH_QUERY\nTARGET_INSTANCE_ID\nTIMESTAMP\nNONCE\nBASE64URL_SHA256_OF_BODY`. The receiver refuses a timestamp more than 5 minutes off, a nonce it saw in the last 10 minutes, a sender that isn't allowed to federate (see below) and a signature that doesn't verify against the sender's key from the registry document, or from its well-known document for an allowed unlisted peer. Errors are `{ "code": "<snake_case>", "error": "<text>" }`.

The receiver checks the headers and the declared body length before it reads the body: 4 MiB for the inbox and other endpoints, 40 MiB for the relay, no `Content-Encoding`, and a shared 128 MiB budget for bodies whose signature isn't checked yet.

An instance may federate when federation is on on both sides, it is `active` in the registry document or an allowed peer, it isn't blocked by the registry or locally, and its protocol is 2 or higher.

A refused sender gets `403` with a message that names the reason: federation is off, the receiver has no current registry document, the sender is blocked, the registry lists it as `listed` or `suspended`, it has no key, or its protocol is too old. When the sender isn't in the receiver's copy of the registry at all, or the receiver has no current copy, the code is `unknown_sender` instead of `not_federated`, and the receiver fetches the registry document again, at most once a minute. Instances fetch it every 5 minutes, so a newly approved instance can be unknown to others for that long.

## Endpoints

All are under `https://<instance>/federation/v2` and need a signed request.

| Method and path | Use |
| --- | --- |
| `POST /relay` | Body `{ "actor": "@u@sender", "method", "path", "query", "body", "files"?, "authorship"? }`. The host runs the call against its own `/api/v9` as the actor's shadow and answers `{ "status", "body", "headers" }` with ids translated. `path` uses canonical ids. `files` carries multipart uploads as base64, 25 MiB in total. `authorship` is the signed statement for a message, edit or forum post, see [Message authorship](#message-authorship). |
| `POST /inbox` | Body `{ "events": [{ "id", "event", "data", "guild_id"?, "channel_id"?, "recipients": ["@u@receiver"] }] }`, at most 100 events. The receiver applies mirror changes, then emits each event to its recipients. `id` is a string of at most 64 characters, unique per sender. The receiver keeps the ids it saw for 48 hours and skips an event whose id it already applied, so a retried batch doesn't apply twice. |
| `POST /join` | Body `{ "actor", "code", "profile" }`. Joins the actor to a server through an invite and answers the server snapshot. |
| `GET /guilds/<canonical>/snapshot?actor=` | The server as the actor sees it: guild, channels, roles, emojis, stickers, members, the actor's member. |
| `GET /users/<canonical>` and `GET /users/lookup?username=` | Public profile of one of the instance's own users, with `badges`, see [Profile badges](#profile-badges). |
| `POST /voice/state` | Body `{ "actor", "guild_id", "channel_id", "leave", "self_mute", "self_deaf", "self_video", "session", "profile" }` with canonical ids. The host applies gateway op 4 for the actor's shadow and answers `{ "voice_state" }`. `guild_id` is null for a DM call. `leave` true, or `channel_id` null in a server, leaves the call. See [Voice](#voice). |
| `POST /voice/stream` | Body `{ "actor", "operation", "session", "stream", "paused", "profile" }`. The host runs gateway op 18, 19, 20 or 22 for the actor's shadow. See [Go Live](#go-live). |
| `GET /voice?v=<version>` | Websocket upgrade, signed like any request with an empty body. The host's voice gateway for the sender's shadows. |
| `GET /users/<canonical>/e2ee?channel=<canonical>` | The user's encryption keys in the shape of `POST /api/v9/e2ee/keys/query`: identity key, backup key and devices with their signed prekeys. Answered only when the user shares a private channel or a non-blocked relationship with a user of the sender, or when the user's request to `GET /channels/<id>` for the hinted `channel` succeeds on the sender as the host. Otherwise `403` with `not_shared`. Device ids are never translated. |
| `POST /move` | Body `{ "statement": <move statement envelope> }`, signed with the key in the statement by the instance it moves to. The sender's trust isn't checked, because the receiver doesn't know the new id yet. The receiver checks that `statement.to` is the sender, that the request verifies against `statement.public_key` and that the sender's well-known document serves that key, then checks the move as in [Instance moves](#instance-moves). It answers `{ "status": "applied" | "unverified" | "refused" | "pending" | "unknown", "detail" }`, `400` for a malformed statement or one sent by another id, and `422` when the sender's well-known document can't be read or serves another key. |
| `GET /media/<path>` | Never used. Media goes through the public CDN paths of the host, fetched by the home instance. |

The `profile` sent with a join or a relay is the actor's `username`, `global_name`, `avatar`, `avatar_decoration_data`, `banner`, `accent_color`, `pronouns`, `bio` and `public_flags`. The receiver updates the shadow from it.

## Profile badges

The public profile carries `badges`, a list of at most 12 entries in the order the home shows them:

```json
{ "id": "pride-transgender", "description": "Transgender", "icon": "https://meow.example/badge-icons/pride_transgender.png", "pride_flag": "transgender" }
```

- `id` is at most 64 characters of letters, digits, `_`, `.`, `:` and `-`. The home writes badges its admins gave as `badge-<id>`, its staff role badge as `role-<role id>` and pride flags as `pride-<flag id>`, so they never collide with the ids receivers use themselves.
- `description` is at most 100 characters.
- `icon` is an absolute `https` URL, or `http` on `localhost`, `127.0.0.1` or `[::1]`, of the form `<instance address>/badge-icons/<hash>.png` on the home's own address.
- `pride_flag` is set on pride badges and holds the flag id from the pride catalog, such as `transgender`.
- `staff` is `true` on the staff badge and on staff role badges.
- `link` is never sent, and receivers ignore it.

`badges` is added after id translation, so its ids are never rewritten. Receivers take it only from `GET /users/<canonical>`, `GET /users/lookup` and the `profile` of a join or relay from the user's own home. They keep at most 12 valid entries from the first 64, drop the reserved ids, links and icons that aren't on the home's address, strip hidden characters, and store what's left on the shadow. A profile without `badges` leaves the stored list alone, so instances that don't send it keep working and their users show no remote badges. Receivers refresh the list at most once a minute per user, when someone opens the profile. `GET /api/v9/users/<id>/remote-badges` on the receiver answers `{ "instance", "badges": [{ "id", "kind", "description", "label", "icon_url" }] }`, where `kind` is `pride`, `staff` or `badge`, staff badges have no `icon_url`, pride badges point at the receiver's own flag art and other badges at its media proxy.

## Rules the host applies

- A server takes members from other instances only when its owner turned on "Show on other instances". Joining needs a valid invite. Discovery verification doesn't matter for joining.
- A relay path must be one a URL parser leaves unchanged, with no `.` or `..` segment in any encoding and no backslash. It may only reach routes under `/guilds/<id>` and `/channels/<id>` minus a deny list (webhooks, integrations, templates, vanity URL, server deletion, application commands, followers and a few more), `GET /invites/<code>`, `DELETE /users/@me/guilds/<id>`, `GET /users/<id>` and `/profile`, and `POST /reporting/...`. Anything else is `403` with `not_federated`, and the authentication middleware refuses shadow tokens on any other route.
- A relay into a server that turned the switch off, or that the actor isn't a member of (except for joins and invite lookups), is refused with `403` and `code` `not_federated`.
- Local and registry blocks apply to shadows: a blocked user's shadow is suspended and a blocked instance's relays and events are refused.
- Events go out per receiving instance with only the recipients who can see them. Message, reaction and typing events are filtered by `VIEW_CHANNEL` for each remote member.
- Events wait in a database table per receiving instance and go out in the order they were queued, at most 100 per request. A batch is removed only after a 2xx answer. Delivery retries with backoff from 1 second up to 5 minutes for 24 hours, then drops the event, logs it and marks the instance unreachable on the admin page. A 4xx answer other than 408 and 429 drops the batch. At most 10,000 events wait per instance, and the oldest go first.

## Events

- `GUILD_CREATE` sent to a new member carries the same snapshot as `/join`, with `members` and `member` inside the guild object. Hidden channels are left out of snapshots and of channel events.
- `RELATIONSHIP_ADD` with type 3 or 1 and `RELATIONSHIP_REMOVE` are sent by the instance of the user who acted, to the instance of the other user. The receiver only accepts them when `data.id` is a user of the sender, refuses a friend event without a pending outgoing request, and stores both directions.
- `PRESENCE_UPDATE` is sent by the subject's home instance to every instance that has a user sharing a server, a private channel or a relationship with the subject, with empty `recipients`. The receiver stores it for 30 minutes and broadcasts it like a local presence.
- A DM or group DM lives on the instance of the user who created it. Its `CHANNEL_CREATE` and messages go to each recipient's home instance, and the home keeps a mirror channel with the same recipients.
- `VOICE_STATE_UPDATE` goes to every instance with a member who can see the channel. Remote servers send the voice states of visible channels in `voice_states` in the snapshot and in `GUILD_CREATE`. `VOICE_SERVER_UPDATE` goes only to the home instance of the user it is for. In a DM, voice states and `CALL_CREATE`, `CALL_UPDATE` and `CALL_DELETE` go to the home of each recipient. `STREAM_*` events carry `meowcord_stream` instead of `stream_key`, see [Go Live](#go-live).
- On the home, a `MESSAGE_CREATE` from the host raises `mention_count` in the read states of the local recipients it mentions, through the same rules as a local message: user mentions, roles the member has unless `suppress_roles` is on, and `@everyone` or `@here` when the host set `mention_everyone` and the member hasn't turned on `suppress_everyone`. Every message counts in a DM. The home sends web push to the event's recipients with the same mute and notification level checks.
- Private channels with a user of another instance are encrypted from the start, and their messages carry version 2 envelopes. The host requires `encrypted.v` 2 there and 1 everywhere else, checks that `mid` on an edit is the canonical id of the message, and translates `keys[].user_id` and `backup[].user_id` from canonical to local ids for its recipient and device checks. `walkIds` never enters `encrypted`, so the envelope reaches every instance byte for byte. Inside a version 2 payload the sender writes `<@id>`, `<@!id>`, `<@&id>`, `<#id>`, `<:name:id>`, `<a:name:id>` and `stickers[].id` with canonical ids, and readers map them back with `GET /api/v9/federation/objects?canonical=`. A canonical id the reader's instance can't map is shown as plain text, never as another local object.
- `E2EE_DEVICES_UPDATE` and `E2EE_IDENTITY_UPDATE` about a local user are sent to every instance with a user sharing a private channel or a relationship, as `{ "user_id" }` with empty `recipients`. The receiver accepts them only when the user belongs to the sender, drops its cached keys and emits the event to its users. `CHANNEL_E2EE_UPDATE` follows the channel's other events and sets `e2ee_enabled_at` on the mirror.
- The receiver caches remote keys in `federated_e2ee_keys` for 10 minutes. It checks that each device id is the SHA-256 hash of the signing key cut to 16 bytes, verifies each signed prekey and drops a device that fails, and lists a device whose identity signature over the home snowflake fails as `pending`.

## Rules the home applies

- Its own automod runs on what its users send to other instances before the relay, with the same actions as for local messages.
- Mirrors take only ids that name the sender. A server membership for a local user is created only after that user asked to join. A private channel takes only local users who are friends with, have a pending request with, or share a server with a user of the sender. Events go only to recipients in the server or channel. User objects of a third instance never update its shadows, which get a placeholder until a profile fetch from their own home.
- A mirrored DM keeps `e2ee_enabled_at` and its type once set, and the home answers `E2EE_REQUIRED` itself to a plaintext message or edit for a private channel on another instance.
- Rate limits apply per local user as usual, and the relay adds a per-host limit.
- Remote media (avatars, banners, icons, emojis, stickers, attachments, embeds) is fetched by the home instance. Absolute URLs on a known instance are rewritten to `/federation-media/<instance id>/<path>` on the home CDN, and CDN paths for shadow ids fall back to the remote file. The client never contacts another instance.
- Calls hosted on other instances run through a TURN relay on the home instance with `iceTransportPolicy: "relay"`, so the host's SFU only sees the home's address. See [Voice](#voice).

## Message authorship

The host stores and serves every message, so without a signature from the author's home a malicious host could forge a message, an edit or a history entry in the name of a user of another instance. The author's home instance therefore signs an authorship statement for every message and edit its users send to another instance, and every receiver checks that statement before it shows the message under that author's name. Messages by the host's own users need no statement, because the host speaks for them anyway.

### Statement

A statement is the string `base64url(payload).base64url(signature)`. The signature is Ed25519 over the UTF-8 bytes of the JSON payload, made with the home's federation key, the same key that signs its requests. A statement is at most 16 KiB. The payload is:

```json
{
    "type": "message_authorship",
    "v": 1,
    "author": "@<user>@<home>",
    "channel": "@<channel>@<host>",
    "thread": false,
    "message": null,
    "nonce": "<nonce>",
    "at": "2026-10-13T18:00:00.000Z",
    "content": "<base64url SHA-256>",
    "attachments": [{ "filename": "cat.png", "description": null, "size": 1234, "sha256": "<base64url SHA-256>" }]
}
```

`content` is the SHA-256 of the canonical JSON of the authored fields. Canonical JSON sorts object keys and leaves out undefined values. The authored fields are:

- `content`, with `\r\n` and `\r` turned into `\n` and the ends trimmed.
- `embeds`, only the rich ones, each as `title`, `description`, `url`, the author's `name`, the footer's `text`, and `fields` as `[name, value]` pairs. Link previews aren't covered, because the host generates them.
- `stickers`, the sorted, deduplicated ids from `sticker_ids`, `sticker_items` and `stickers`.
- `reference`, `{ message_id, type }` from `message_reference`, or null.
- `poll`, `{ question, answers, multiselect }` with the texts of the question and answers, or null.

Ids inside the authored fields are canonical, so the digest is the same on every instance. `attachments` lists each file with the filename the host will store, which is spaces turned into underscores and everything outside `a-z A-Z 0-9 . _ -` removed, its description, its size and the SHA-256 of its bytes. For a file uploaded through `/federation-upload` the home takes the size and hash from what it forwarded, and both are null when it no longer remembers the upload. It remembers uploads for 24 hours, at most 20,000.

### Signing before the host picks an id

The home signs before the host has created the message, so the payload of a new message has `message: null` and names the client's `nonce`. When the client sent no nonce the home sets one. The home sends the statement in the `authorship` field of the relay request, and the host checks it against the sender's key before it runs the call: the author must be the relay's actor, the channel and the message must match the relay path, `thread` must be true only for `POST /channels/<id>/threads`, and `at` must be within 10 minutes of the host's clock. A statement that fails is refused with `400` and `bad_authorship`. A relay without a statement still runs, so an older home keeps working, and its messages show as unverified.

The host passes the statement to its own route in the `x-meowcord-authorship` header, which the route only reads on a relayed loopback call, and stores it in `messages.authorship`. It adds the stored statement as `meowcord_authorship` to every message object it sends out: inbox events, relay answers for message lists, single messages, search, pins, threads and forum posts, and every `referenced_message` inside them.

A receiver binds a statement with `message: null` to a message id through time and nonce. The id's snowflake timestamp must be within 10 minutes of `at`, the message's nonce, when it carries one, must equal the statement's, and each receiver remembers which message id a signature was first seen on, for 20,000 signatures, and refuses it on a different id. A forum post or a thread started with a message uses `thread: true` and names the parent channel. The host checks the parent channel against the relay path. A message object doesn't carry the parent, so the receiver instead requires the message id to equal its channel id, which only holds for the first message of a thread.

### Edits

An edit is signed with `message` set to the message's canonical id. Before it signs, the home fetches the current message from the host through the relay and checks the current statement. When the current version is unverified, and isn't older than the home's cutoff, the home answers `409` with `unverified_message` and signs nothing, so a host can't get a forged message countersigned by the author's next edit. Otherwise the home signs the edited fields merged over the current message, and keeps the hashes of attachments the edit keeps. A receiver accepts an edit statement only when `at` isn't more than 10 minutes before the message's creation and isn't in the future. The host still accepts the edit route only from the message's author.

Deletes need no statement. The host decides what stays in its conversations, and a delete can't put words in anyone's mouth.

### What the receiver checks

For each message object in an inbox event or a relay answer, including referenced messages, the receiver:

1. Skips messages whose author belongs to the host, and messages whose type is a host statement: every system type, such as joins, pins, boosts, thread starts, calls, automod alerts and poll results. Bots, webhooks and interaction replies are users of the host, so they are host messages too.
2. Checks the statement against the key of the author's home: the receiver's own key for its own users, otherwise the key from the registry or the allowed peer. The author, channel, message or nonce, time window, content digest and attachments must all match.
3. Matches attachments as a multiset on filename, description and size, with a null size matching any size. The hash is recorded but not compared, because the host serves resized variants of images.
4. Marks the message with `meowcord_authorship_state`: `verified`, `unverified`, or `legacy` for a message without a statement whose id is older than the receiver's cutoff.

Link preview embeds are dropped from a message from another instance when its content has no `http://` or `https://` link, so a host can't attach text to a message through a fake preview.

An unverified `MESSAGE_CREATE` or `MESSAGE_UPDATE` is dropped and logged. So is a `MESSAGE_CREATE` whose data isn't a message, and a `MESSAGE_UPDATE` without an author that changes authored fields. A legacy message never counts for a new `MESSAGE_CREATE`. In history, search, pins and references an unverified message stays in place, so the conversation still reads, but its author becomes the placeholder user `1000000000000001` named Unverified author, and its member and interaction data are removed.

### Cutoff

The first time an instance starts with this code it writes the current time to the `federation_state` row with id `authorship`. Messages from before that time came from hosts that didn't sign, so they show as `legacy` with their real author. Messages after it need a statement. A host can still backdate a forged snowflake to before the cutoff, which is a known gap, listed in the threat model.

### Compatibility

The protocol stays at version 2. An old host doesn't store or send statements, so its messages by users of other instances show as unverified after the cutoff, with the placeholder author in history and new events dropped. An old home sends no statement, with the same result for its users' messages. Old receivers ignore the `meowcord_authorship` field.

## Voice

A user joins a call hosted on another instance through the home instance only. Neither the client nor its address ever reaches the host. This covers voice channels of remote servers, DMs and group DMs that live on another instance, and Go Live streams in both.

1. The client sends gateway op 4 for a mirror guild or a mirror DM. The home doesn't apply it locally. It sends `POST /voice/state` to the host with `session` set to the first 32 hex characters of `sha256("meowcord-voice:" + home session id)`, so the host never learns the real session id. The host applies the update for the shadow with the same checks as for a local user. For a DM, `guild_id` is null and `channel_id` is the canonical DM id, and the host checks that the shadow is a recipient. When the shadow doesn't open a voice connection within 60 seconds, the host drops the voice state.
2. The host forwards the shadow's `VOICE_STATE_UPDATE` and `VOICE_SERVER_UPDATE` through `/inbox`. The home matches the hashed session to its own row, stores the host's voice token there and gives the client a `VOICE_SERVER_UPDATE` whose endpoint is `<home host>/federated-voice`.
3. The client opens its voice websocket at `/federated-voice` on the home. The home checks the identify or resume against its own voice state row by server id, session, token and user, then opens `GET /federation/v2/voice` on the host as a signed websocket upgrade and passes the messages through in order. Ids are translated in both directions like in any other payload, and `ssrc` values are passed unchanged. The identify carries the hashed session. When `PUBLIC_FETCH_PROXY` is set, the upgrade goes through that proxy like every other outbound request.
4. The host accepts a federated voice connection only for a shadow of the signing instance: a voice state in that guild or DM, or an unused Go Live stream session. Resume only continues a session opened by the same instance.
5. When the host's op 2 READY arrives, the home adds `meowcord_relay` to it: `{ "urls", "username", "credential", "expires_at" }` for the TURN relay in the home's SFU. The username is `<expiry>:<host SFU IPv4>:<random tag>` and the credential is `base64(HMAC-SHA1(secret, username))`, the TURN REST scheme. The relay only lets that credential reach the IP in the username. A source address is bound to a username only after an allocation on it succeeded with a valid message integrity, so a forged request can't claim an address for a credential it doesn't hold. The home closes the connection with 4000 when it can't offer a relay, so a call never falls back to a direct connection.
6. The client patch `80-federated-voice.js` sees the `/federated-voice` socket and creates every `RTCPeerConnection` during that call with the relay as the only ICE server and `iceTransportPolicy: "relay"`. Calls on the user's own instance keep their configuration.

### DAVE

Calls across instances keep DAVE, protocol version 1, like any other call. MLS credentials and the per-sender key ratchets are bound to a 64-bit user id, and every instance has its own local id for the same user, so the instances agree on one id per user and on one group id per call:

- A user's DAVE id is the snowflake of their canonical id, which is their id on their home instance. For a local user that is their own id. For a shadow it is the snowflake part of the canonical id stored in `federated_objects`.
- The group id is the channel id on the host: the voice channel or DM id, or the stream id minus one for Go Live.
- The host computes the DAVE id of every voice connection on identify and refuses one whose id it can't resolve. It checks the identity in each MLS key package against that id, and refuses a key package whose id is already used by another member of the call.
- The host adds `meowcord_dave: [{ "user_id", "dave" }]` to op 11 CLIENTS_CONNECT, and `meowcord_dave: { "channel_id", "group" }` to op 4 SESSION_DESCRIPTION on a federated connection. The home translates `user_id` and `channel_id` like any id and passes `dave` and `group` unchanged.
- The client patch `80-federated-voice.js` keeps a map from local id to DAVE id and from local channel id to group id. The `FosscordFederation` plugin wraps the libdave session so that it gets the DAVE ids and the group id, and the client's code above it keeps its local ids. Calls with only local users have identical ids on both sides, so nothing changes for them.

### Go Live

Gateway ops 18, 19, 20 and 22 for a stream in a mirror guild or a mirror DM go to the host as `POST /voice/stream`:

```json
{ "actor": "@u@home", "operation": "create" | "watch" | "delete" | "paused", "session": "<hashed session>", "stream": { "guild_id", "channel_id", "user_id" }, "paused": false, "profile": {} }
```

The ids in `stream` are canonical and `user_id` is the stream's owner. The host runs the op for the shadow with the checks it applies to a local user, and only the owner may create a stream. `STREAM_CREATE`, `STREAM_SERVER_UPDATE`, `STREAM_UPDATE` and `STREAM_DELETE` go back through `/inbox` to the home of each user they are for, or to every instance with a member who can see the channel for a stream that ended. A stream key holds ids inside a string, so on the wire `stream_key` is replaced with `meowcord_stream: { "guild_id", "channel_id", "user_id" }` and the receiver rebuilds the key from its own ids. The home remembers the token of each `STREAM_SERVER_UPDATE` for 10 minutes, points the endpoint at `/federated-voice` and lets that token through the voice proxy for the same user. The stream connection then runs like a call, with the relay and DAVE.

### DM and group DM calls

A DM or group DM lives on the instance of the user who created it, and so does its call. `CALL_CREATE`, `CALL_UPDATE` and `CALL_DELETE` follow the channel's other events to each recipient's home, with `ringing`, `participants` and the keys of `ongoing_rings` translated. The home keeps the last call payload per mirror DM in memory and serves it for gateway op 13 and to a client that connects during the call. Voice states in a DM are forwarded to the home of each recipient, like messages.

### Restarts

When a home restarts in the middle of a call hosted elsewhere, it keeps the voice states of its own users and of shadows in mirror guilds and mirror DMs. It only clears the states, streams and calls it hosts. The client's gateway reconnects and sends op 4 for the same channel with a new session. The home sends it to the host as a new session, the host gives the shadow a new token and `VOICE_SERVER_UPDATE`, and the client reconnects its voice websocket through the proxy and allocates a new relay.

### Moderation

A host's server mute, server deafen, move and disconnect act on the shadow's voice state like on a local member. The host's SFU stops forwarding the shadow's audio when muted and stops sending audio to it when deafened. The resulting `VOICE_STATE_UPDATE` reaches the home and the client. A move also sends a new `VOICE_SERVER_UPDATE` with a new token, and the client reconnects through the proxy. A disconnect sends a voice state with `channel_id` null, and the home clears its own row.

## Client endpoints on the home instance

| Method and path | Use |
| --- | --- |
| `GET /api/v9/federation/invites/<instance id>/<code>` | Invite preview from another instance. |
| `POST /api/v9/federation/invites/<instance id>/<code>` | Join through it. Answers like `POST /invites/<code>`, plus `guild_id` and `meowcord_guild`, the `GUILD_CREATE` payload sent to the gateway, see [Joining](#joining). |
| `GET /api/v9/federation/users/lookup?handle=name@instance` | Resolve a remote user for friend requests and DMs. Answers a user object with a local id. |
| `GET /api/v9/federation/objects?ids=<local ids>&canonical=<canonical ids>` | Canonical ids for local ids, and local ids for canonical ids, at most 100 of each, in one object keyed by the id asked for. A canonical id that has no local id yet gets one when its instance federates with this one, the same rule as for incoming payloads. Canonical ids of other instances are left out. |

The invite route also accepts `https://<instance>/invite/<code>` pasted into the client's join dialog, through the `FosscordFederation` plugin.

## Joining

The home answers `POST /api/v9/federation/invites/<instance id>/<code>` within 28 seconds. Its request to the host's `/join` times out after 20 seconds, and every request to another instance goes through `fetchPublicUrl` with a deadline that ends the request even when a proxy connection stalls. When the host answers `unknown_sender`, the home asks once more after 3 seconds, since the host is fetching the registry document by then. A host on an older build answers `not_federated` with "This instance doesn't federate with the sender" in that case, and the home explains it as the registry delay.

A failed join answers `{ "code", "message", "meowcord_code" }`. Errors from the host's invite route, such as an unknown, used up or expired invite (`10006`), a ban (`40007`) or paused invites, keep their status and Discord code, except that a `401` from the host becomes `403` so the client doesn't sign out. The other codes are:

| `meowcord_code` | Status | Meaning |
| --- | --- | --- |
| `not_federated` | 403 | This instance or the host doesn't federate with the other, and the message says why. |
| `unknown_sender` | 403 | The host doesn't have this instance in its copy of the registry yet. |
| `host_timeout` | 504 | The host didn't answer within 20 seconds. |
| `host_unreachable` | 502 | The connection to the host failed: DNS, refused, reset, TLS, or the outbound proxy couldn't reach it. |
| `proxy_error` | 502 | The outbound proxy refused the connection. |
| `host_bad_response` | 502 | The host answered with something that isn't JSON, like a proxy's error page. |
| `host_error` | 502 | The host answered a 5xx or an unexpected status. |
| `mirror_failed` | 502 | The host let the user in, but copying the server failed. The home removes the partial copy, and joining again is safe. |
| `join_timeout` | 504 | The whole join took longer than 28 seconds. The copy continues and the server shows up when it's done. |
| `internal` | 500 | Anything else, logged on the home. |

When the host answers that the join waits for approval, the answer has `meowcord_pending: true` and no `guild_id`. The client shows a notice instead of opening the server.

On the host, the loopback call to its own `/api/v9` that runs the join or a relay times out after 15 seconds.
