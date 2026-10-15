# Federation plan

This is a plan. Phase 1, the registry and the shared directory, is built and described in [features/federation.md](../features/federation.md). The rest isn't built yet. The plan describes how Meowcord instances could let people discover servers on other instances and chat in them, with DMs, group DMs and friends across instances, without copying the parts of Matrix and ActivityPub that make them slow, leaky and hard to moderate.

## What we want

- People find verified servers on their own instance and on other approved instances, in one Discovery view.
- People join a server on another instance and use it like a local one: read, send, react, get pinged, see members.
- DMs, group DMs and friend requests work between people on different instances.
- No other instance ever learns a user's IP address. That covers messages, media, avatars, emojis, stickers and voice.
- By default an instance only talks to instances on our approved list, and only lists servers that their owner turned on for global discovery and an admin verified. We can block an instance, server or user for every instance within minutes.
- The stock Discord client keeps working, with small Equicord additions for instance badges and global discovery.

## What we accept giving up

- It isn't fully decentralized. We run the registry that says which instances are approved and what is blocked. Instances keep working when the registry is down, but nobody new can join and no new block goes out until it's back.
- A server lives on one instance. If that instance goes down, its servers are down for everyone, the same as when Discord has an outage. There is no replication.
- The admins of the instance that hosts a server can read that server's unencrypted messages, the same as today.

## Why Matrix and ActivityPub hurt, and what we do instead

| Problem there | Cause | What we do |
| --- | --- | --- |
| Matrix room joins take minutes and rooms split | Every server keeps a full copy of the room state and has to merge conflicting histories | One instance owns each server, DM and group DM. Others ask it, they don't copy it. There is nothing to merge |
| ActivityPub delivery storms | A post is pushed to every follower's inbox separately | Instances keep one connection to each other and the host sends each event once per instance, not once per user |
| Spam and harassment from instances nobody vetted | Anyone can stand up a server and start talking to everyone | An allow list we curate, signed blocklists and per-instance rate limits from the first release |
| Moderation is a fight between thousands of admins | No shared authority | We are the shared authority for the list and emergency blocks. Instance admins still moderate their own servers |
| Clients have to understand federation | Identity and addresses leak into every client | The user's own instance relays everything, so the client still thinks it talks to one server |
| Servers learn users' IPs from media | Clients fetch remote media directly | The home instance proxies all remote media |

## Words used here

- **Registry**: the service we run that publishes the signed list of approved instances, blocklists and the global discovery index.
- **Home instance**: where a user's account lives.
- **Host instance**: where a server, DM or group DM lives.
- **Remote user**: a user whose home is another instance, seen from a host.

## Architecture

### Registry

A Cloudflare Worker with D1 in `extra/registry`, publishing one signed JSON document. [registry.md](../self-hosting/registry.md) describes the running service. Its admin pages sit behind hrtID.

- `instances.md` becomes `instances.json`, and the markdown file is generated from it. Approving an instance in the registry and merging the PR are the same act.
- The document lists each approved instance: id, domain, display name, the instance's public signing key, minimum protocol version, and its state (`active`, `suspended` or `blocked`).
- It lists blocked servers and users as `instance:id` pairs, with a reason and a date.
- It lists the global discovery index (see below).
- It carries a sequence number and an expiry. We sign it with an Ed25519 key kept in Proton Pass, and the public key is pinned in the server code. Instances refuse a document with a lower sequence number than the one they have, so nobody can roll a block back by replaying an old file.
- Instances fetch it every 5 minutes through `fetchPublicUrl`, so through WARP. If the registry is unreachable, they keep the last good document until it expires, 7 days after signing, and then stop federating until they get a new one.

Approval needs: a moderation contact, captcha on, a minimum protocol version, and the instance's key published at `/.well-known/meowcord`. We can't check that a fork runs our automod, so approval is a trust decision and suspension is the answer to abuse.

### Instance identity and server-to-server requests

- Each instance makes an Ed25519 key pair on first start, stored outside the database like the E2EE master key, and publishes the public half at `/.well-known/meowcord` with its protocol version and domain.
- Every request between instances is an HTTPS request signed with HTTP Message Signatures (RFC 9421), covering method, path, body digest, a timestamp and a nonce. The receiver checks the signature against the key in the registry, not the one served live, so a hijacked domain can't speak for the instance.
- An instance is trusted to say who its own users are, and nothing else. A request "user 123 of instance A sends this message" is accepted only from instance A. A bad instance can make its own users misbehave, and the fix for that is suspending the instance.
- Instances reach each other through WARP, so a host doesn't learn a home instance's real IP either.

### Home relay

The client only ever talks to its home instance. When a user acts in a remote server, the home instance forwards the call to the host instance, signed, naming the user. The host checks permissions as for a local member and answers. The home instance translates the answer and returns it.

- One login and one gateway connection, as today.
- The host never sees the user's IP, token or client.
- The home instance can apply its own automod and rate limits to what its users send to other instances, which protects the instance's standing on the list.

Gateway events go the other way. Each pair of instances keeps one signed websocket open. A host sends an event once to each home instance that has a user who should see it, with the list of those users, after it has checked channel permissions. The home instance hands it to the matching local sessions.

### Ids

Ids are snowflakes built from a timestamp and a 5-bit worker id and a 5-bit process id (`src/util/util/Snowflake.ts`). Two instances can create the same id, and a malicious instance can do it on purpose to hijack an object on another instance.

Every object has one canonical id, written `@id@instance`, for example `@1559204248149852286@meow.example`. That is the only form used between instances, in the registry, in blocklists, in reports, in E2EE signatures and in anything stored about remote objects. It can't clash, because the instance part is checked against the signature on the request that carried it.

The Discord client can't take it directly. It reads the creation time out of the id, sorts messages and channels by comparing ids as numbers, and puts ids in URLs like `/channels/<server>/<channel>`. So the home instance never hands a canonical id to the client. It gives every remote object (user, server, channel, role, message, emoji, sticker, attachment) a local id, and a `federated_objects` table maps the canonical id and the kind of object to it. Local objects keep their plain snowflakes, and their canonical id is the snowflake plus the instance's own domain. Every payload crossing the boundary is rewritten in both directions:

- Id fields, found from the request and response schemas in `src/schemas`, which we already generate `assets/schemas.json` from.
- Mentions and custom emoji in message text: `<@id>`, `<@&id>`, `<#id>`, `<:name:id>`.
- Media URLs, rewritten to the home instance's media proxy.

We looked at giving each instance its own range of worker ids instead, so ids would never clash. It doesn't work for every object that already exists, it leaves 1024 values to split between instances and processes, and it still needs a check on every id. One rewrite path is simpler to get right and to fuzz.

The client sees remote users as normal users with a badge and a `name@instance` handle, through an Equicord plugin. Adding a friend accepts `name@instance`.

### Where conversations live

- **Servers** live on the instance that created them.
- **DMs** live on the instance of the person who opened them. If the other person's instance gets blocked, the DM becomes read-only for both.
- **Group DMs** live on the creator's instance, with the 25 member limit applied by the host.
- **Friends** are stored on both home instances. A request is one signed call, and either side can remove it.
- **Presence and typing** go through the same event connection, limited to people who share a server, DM or friendship.

### Media and IP privacy

- All remote media (attachments, avatars, banners, emojis, stickers, embeds) is fetched by the home instance through its `/federation-media/<instance>/<path>` CDN route with size limits and caching, through `fetchPublicUrl`. Uploads into remote channels go to the home's `/federation-upload/...` route, which forwards them to the host. [features/federation.md](../features/federation.md#media-from-other-instances) describes what is built.
- Link previews are made by the host, as today, and their media goes through the home proxy like any other remote media.
- Voice and video in remote servers go through the home instance. Connecting a client straight to the host's SFU would leak the user's IP, so the home proxies the voice websocket to the host and the client sends media only through a TURN relay in the home's SFU. The host's SFU sees the relay's address. [features/federation.md](../features/federation.md#voice-across-instances) describes what is built.

### Moderation

This ships with the first chat release, not after.

- **Registry blocks** apply within 5 minutes everywhere. A blocked instance's websocket is closed and its media proxy stops. Its users disappear from remote member lists and their messages show as hidden.
- **Instance admins** can block any instance, server or user on top of the registry, and can't unblock what the registry blocks.
- **Host automod** runs on everything posted in its servers, remote users included, the same as for local users.
- **Home automod** also checks what its users send out, so a user who says the slur on another instance gets the same suspension at home.
- **Rate limits** at the host apply per remote instance and per remote user, and there's an admin setting for the minimum account age before a remote user can post.
- **Reports** on remote content go to the host's admins with the usual verified snapshot. The host can forward one to the reported user's home admins, and a home can forward to us for a registry block.
- **Bans**: a host can ban a remote user from a server or from the whole instance. Server bans work as today.
- **Global discovery** lists a server only when its owner turned it on, the host instance's admin verified it, and we haven't blocked it. The host instance publishes its list, the registry gathers the lists into the index, and we can remove a server from the index at any time.

### E2EE

Private channels with users of other instances use version 2 envelopes. Version 1 signatures cover local user and channel ids, and those differ on each instance. Version 2 signs canonical `@id@instance` ids, and the client maps between those and local ids through `GET /api/v9/federation/objects`, in both directions. Each instance fetches the keys of remote users from their home with a signed request and caches them, and the home forwards device and identity changes. Default mode then trusts both home instances' key directories, and strict mode with safety numbers works as it does for local contacts. [e2ee.md](../features/e2ee.md#conversations-with-users-of-other-instances) describes the format and what each instance sees. Encrypted message text can't be rewritten by the server, so the sender's browser writes mentions, channel links, custom emojis and sticker ids inside a version 2 payload as canonical ids, and each reader's browser turns them back into its own instance's ids.

### Versioning

The protocol has a version number in `/.well-known/meowcord` and in the registry. The registry states the minimum version. An instance below it is suspended for federation automatically until it updates, and its local features keep working.

## Phases

Each phase ends with something people can use, and each has its own probe that runs two or three local instances against a local registry.

1. **Registry and directory**, specified in [federation-protocol.md](federation-protocol.md).
   - `instances.json`, the registry Worker, instance keys and `/.well-known/meowcord`.
   - The "show in global discovery" switch for server owners and the admin verify step.
   - An "Other instances" section in Discovery that links out to their invite pages. No chat yet.

   Phase 1 state: built on the instance side. `federation.key`, `/.well-known/meowcord` and its signed discovery list, the registry client with signature, version, sequence and expiry checks, daily announces, the owner switch in Server Settings, the Other instances tab in Discovery and the Federation admin page all work. `scripts/tests/federation-protocol.test.cjs` covers the protocol rules. The registry Worker runs at `meowcord-registry.tiag.workers.dev` and lists the 17 instances from `instances.json`, and a fresh local instance accepted its signed document and showed all 17 in Discovery on 2026-10-12. On 2026-10-13 `federation-probe.mjs --public` ran two instances behind Cloudflare quick tunnels with `security.allowPrivateNetworkRequests` off, and both announced themselves from their public HTTPS addresses to a local registry that checked the signature and the well-known document. Announcing to the real registry from a public address is still untested, because test instances shouldn't enter its review queue.
2. **Remote servers, text only.**
   - Signed requests, the instance websocket and the id rewrite.
   - Joining a remote server from global discovery or an invite, then reading, sending, editing, deleting, reacting, mentions and member lists.
   - The media proxy, plus every moderation item above.

   Phase 2 state: the media proxy is built. `src/api/util/utility/federationMedia.ts` rewrites media URLs, fetches and caches remote files, signs and forwards uploads, and takes the remote id lookup from the core through `setRemoteLookup`. `scripts/tests/federation-media.test.cjs` covers it. Two local instances on ports 3111 and 3112 fetched an avatar, an attachment and a byte range, and forwarded a cloud upload through `/federation-media` and `/federation-upload` on 2026-10-12. The relay rewrites remote media in every payload it translates and hands out home upload URLs for attachments in remote channels.

   The rest of phase 2 is built too: the `federated_objects` table and id translation, signed requests with a nonce cache and per instance rate limits, shadow users that can't sign in, the host relay at `/federation/v2/relay`, the home relay middleware for mirror servers and channels, event forwarding with a queue per instance, the inbox, joining through `/federation/v2/join`, leaving, blocks and reports. `scripts/tests/federation-ids.test.cjs` covers the id rules. `scripts/dev/federation-probe.mjs` runs two instances on ports 3101 and 3102 against a local registry and passed all 74 checks on 2026-10-12, covering joins, history, sends, edits, deletes, reactions, mentions, typing, member lists, member requests, READY, leaving, reports and blocking.
3. **People across instances.** Friends, DMs, group DMs, presence, typing and profiles.

   Phase 3 state: built. Handle lookup, friend requests in both directions, DMs and group DMs hosted on the creator's instance, presence, typing and profile fetches pass in the same probe. Events for other instances wait in the `federation_outbox` table, in order per receiving instance, and survive a restart of either side. Each event carries an id and the receiver applies an id only once. Mentions in messages from other instances raise the home's read state mention counts and send web push like local messages. On 2026-10-13 the probe passed 128 checks, including a stop of the receiving instance, a restart of the sender with 3 queued messages that then arrived in order, a repeated inbox event applied once, and user, role, `@everyone` and suppressed `@everyone` mentions.
4. **E2EE across instances.** Version 2 envelopes and key directory relay.

   Phase 4 state: built. DMs and group DMs with users of other instances are encrypted by default with version 2 envelopes, and the server refuses plaintext and version 1 there. `GET /federation/v2/users/<canonical>/e2ee` serves keys between instances, `federated_e2ee_keys` caches them for 10 minutes, and forwarded `E2EE_DEVICES_UPDATE` and `E2EE_IDENTITY_UPDATE` events clear the cache. The key backup accepts mirrored message ids, reports of version 2 envelopes are verified on the host, and safety numbers of remote contacts use their home ids. On 2026-10-12 `federation-probe.mjs` passed 106 checks with encrypted DMs, group DMs, edits, new devices, reports and backup keys, and `scripts/dev/federation-e2ee-test.mjs` passed in Brave with the real client on two instances: a DM both ways with edits, an encrypted image, matching safety numbers in strict mode, a group DM with members on both instances, history on a fresh browser after a password login, and a report the host verified. Since 2026-10-13 mentions inside encrypted text travel as canonical ids, and the browser test also checks them both ways, plus an encrypted image and a text file that the member on the other instance sends through `/federation-upload` on their home. Both worked without server changes.
5. **Voice and video.** The home proxies the voice gateway and relays media through TURN.

   Phase 5 state: built. Gateway op 4 for a mirror guild or a mirror DM goes to the host as `POST /federation/v2/voice/state`, the host's VOICE_STATE_UPDATE and VOICE_SERVER_UPDATE come back through the inbox, and snapshots and `GUILD_CREATE` carry `voice_states`. The client's voice websocket goes to `/federated-voice` on the home, which checks the token and forwards to the host's `/federation/v2/voice` as a signed upgrade, through `PUBLIC_FETCH_PROXY` when one is set, translating ids both ways. The SFU runs a TURN relay (`extra/pion-sfu/turn.go`) with REST credentials bound to the host SFU's address, and binds a source address to a credential only after an authenticated allocation. `assets/client_patches/80-federated-voice.js` forces `iceTransportPolicy: "relay"` for those calls only. DAVE stays on: each user's DAVE id is their id on their home instance and the group is the host's channel id, the host checks key packages against those ids, and the `FosscordFederation` plugin maps ids around the libdave session. Go Live ops go to the host as `POST /federation/v2/voice/stream` and stream events come back with `meowcord_stream` in place of the stream key. DM and group DM calls run on the instance that hosts the conversation, with `CALL_*` events following the channel. A restarting home keeps voice states of calls hosted elsewhere, and the client reconnects with a new session. `scripts/tests/federation-voice.test.cjs` covers credentials, the client patch, DAVE ids and call payloads, `extra/pion-sfu/turn_test.go` covers the relay, and `scripts/dev/federation-voice-probe.mjs` runs two instances with the SFU and a browser per user. It passed all 126 checks on 2026-10-13: audio and camera video both ways with DAVE version 1, Go Live from each side with the viewer decoding frames, a DM call hosted on one instance and a group DM call with three people hosted on the other, a restart of the home mid-call with audio flowing both ways afterwards, server mute and deafen stopping audio at the host's SFU, a move to another channel and a disconnect. In every case the host SFU only received the remote user's media from a port in the home's relay range. Each instance's relay range is `FED_RELAY_SPAN` ports, 20 by default, starting at `FED_RELAY_PORTS`, so a span of 10 fits the whole probe in 3600 to 3640 next to `FED_TURN_A` and `FED_TURN_B`. Since 2026-10-13 the TURN relay refuses private peers, so the probe sets `TURN_ALLOW_PRIVATE_PEERS` for its localhost instances.

Phase 1 takes about a week. Phase 2 is the big one, a few weeks, and most of it is the id rewrite and its tests.

## Testing on public addresses

`scripts/dev/federation-attack-probe.mjs` runs one real instance and an in-process rogue instance that is an allowed peer with its own key, and tries every attack in the threat model of [federation.md](../features/federation.md#threat-model): forged and replayed requests, oversized and compressed bodies, relay path traversal, forced joins, emoji and channel hijacks, DM injection, profile and presence spoofing, an encryption downgrade, hostile media, private TURN peers, the quotas and forged message authorship. For authorship it adds a third instance with its own key and has the rogue host forge a message by a local user, a history entry, a message by the third instance's user, a replayed statement and a stale edit, and checks that a genuine message from the rogue's own user still shows. It prints `pass` for each one blocked. It uses ports from `ATTACK_PORT_BASE` (3600 by default) to 5 above it, the database `ATTACK_DB` and the directory `ATTACK_DIR`, refuses an existing database unless it gets `--fresh`, and `--drop` drops it at the end. On 2026-10-13 it passed 60 checks, and `federation-probe.mjs` passed 182, including messages, files, uploads through `/federation-upload` and edits that come back signed under their author's name.

`scripts/dev/federation-probe.mjs` runs two instances and a signed test registry on localhost. Pick free ports and databases you own through `FED_REGISTRY_PORT`, `FED_PORT_A`, `FED_PORT_B`, `FED_DB_A`, `FED_DB_B` and `FED_DIR`. Each instance also opens a voice port at its own port plus `FED_VOICE_PORT_OFFSET`, 1000 by default. `--fresh` recreates the databases and `--drop` drops them at the end.

Without `--public` the probe also runs a fake host on `FED_PORT_FAKE`, by default the registry port plus 10, which instance B lists as a peer. It answers `/federation/v2/join` slowly, with HTML, with 5xx errors, with the refusals of older and newer hosts, with a snapshot that breaks the mirror halfway, or not at all, and the probe checks that B answers each within its deadline with the right `meowcord_code`. The probe then joins A's server through a vanity code, a used up, an expired and an unknown invite, while invites are paused, as a banned user, as a member already, and while A doesn't know B. `--only-join` stops after these checks, which takes about a minute.

`--public` puts the registry and both instances behind Cloudflare quick tunnels, so instances talk to each other over real HTTPS through `fetchPublicUrl` with `security.allowPrivateNetworkRequests` off. It needs `cloudflared` (`brew install cloudflared`) and no Cloudflare account. The probe starts three `cloudflared tunnel --url http://localhost:<port>` processes, reads their `trycloudflare.com` addresses, writes each instance's `federation.key` ahead of time so the registry document can list both instances as `active` with their keys, and turns announcing on, so each instance announces itself to the test registry. It only contacts its own tunnels and stops them at the end.

```sh
FED_REGISTRY_PORT=3401 FED_PORT_A=3402 FED_PORT_B=3403 FED_DB_A=fed_a FED_DB_B=fed_b \
  bun scripts/dev/federation-probe.mjs --fresh --drop --public
```

Outgoing fetches go direct by default. Set `FED_FETCH_PROXY=socks5://127.0.0.1:<port>` to send them through a local WARP SOCKS proxy, which becomes the instances' `PUBLIC_FETCH_PROXY`. The 2026-10-13 run had no local WARP proxy, so that path is still untested.

The first public run showed every request between instances taking about 10 seconds. The Mac had no working IPv6 route, Cloudflare answers with two IPv6 and two IPv4 addresses, and each IPv6 connect failed after about 4 seconds before `fetchPublicUrl` tried IPv4. `fetchPublicUrl` now alternates address families and remembers the family that worked for each host for 10 minutes, so only the first request to a host pays for a broken family.

## Decisions

- We approve instances, and each approved instance's admins verify their own servers for global discovery. We can still remove or block any server or instance in an emergency. An instance can also turn federation off.
- Admins can federate with instances that aren't on our list. It is off by default.
- A server only accepts members from other instances when its owner turned on "Show on other instances". Verification only decides whether it appears in Discovery, so an opted-in server that nobody verified can still be joined through an invite link once phase 2 ships.
- The registry runs on a workers.dev address for now. Every instance announces itself to it by default so we can review instances that never opened a pull request.

## Open questions

- Do we want account moves between instances? Canonical `@id@instance` ids keep that possible, because a move only has to update the mapping.
- Should a host be able to see which home instance a remote user's request came through when that user is on a blocked instance's list? This matters for appeals.
