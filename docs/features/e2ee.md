# End-to-end encrypted messages

DMs and group DMs encrypt new messages and attachments by default. Ordinary password signup and login create or unlock the encrypted key backup in the background; users can start chatting without an encryption setup step. Private-channel encryption is required, including for bot, application and webhook message sends; there is no private plaintext opt-out. DMs and group DMs with users of other instances are encrypted the same way, see [Conversations with users of other instances](#conversations-with-users-of-other-instances). The server defaults `limits.e2ee.trustServerByDefault` to `true`. Guild text channels remain outside this implementation, and earlier plaintext messages stay plaintext.

## Protocol

Encryption identity, device, prekey, reset, backup and escrow mutations serialize on the account row in PostgreSQL and in a write transaction in SQLite. Each mutation reads the current encryption state after taking the lock and commits its related writes together. Reset also compares the password hash under the lock with the hash that admitted the request, so a password change invalidates an earlier reset attempt.

The MVP uses a sealed box per recipient device. For every message the sending client:

1. generates a random 256-bit content key and encrypts the payload once with AES-256-GCM,
2. wraps the content key to each recipient device's signed X25519 prekey with HPKE base mode (DHKEM X25519, HKDF-SHA256, AES-256-GCM),
3. signs the envelope with its Ed25519 device key.

Everything runs on WebCrypto with non-extractable keys in IndexedDB. HPKE comes from `@hpke/core` and `@hpke/dhkem-x25519` (MIT). If they refuse non-extractable keys, HPKE base mode is about 100 lines on top of WebCrypto and gets checked against the RFC 9180 test vectors.

The MVP has no per-message forward secrecy. Weekly prekey rotation with old private prekeys deleted after 30 days gives a coarse version of it. The upgrade path is MLS (RFC 9420) through `ts-mls` (MIT, pure TypeScript) behind envelope version 2, used first for group DMs and then guild channels. The MVP's identity and device keys become the MLS credentials, so verification carries over. We skip a Signal-style double ratchet because guild channels would need a second protocol anyway.

## Keys

- User identity key, Ed25519, one per user. It signs device records, and safety numbers are computed over it, so verifying a contact once covers all their devices.
- Device signing key, Ed25519, one per browser profile.
- Signed prekey, X25519, rotated every 7 days.

A new device registers as pending. Peers only encrypt to it once the identity key signs it. The new device gets the identity key from the key backup, unlocked by the account password, by a recovery code, or by another device approving it over the gateway. The next section covers all three.

The server ties each device to the session that registered it, and the client re-links its stored device to the current session every time it loads. Logging a session out, whether from that browser, from Logged-in Devices or through a password change, revokes the devices that no longer belong to a live session, so senders stop wrapping keys to them.

The server rejects a send with `409 E2EE_DEVICE_MISMATCH` when the envelope skips an active device of any recipient, including the sender's own other devices. The client then refetches keys and re-encrypts before the UI sees a failure. This check catches incomplete recipient lists. The server stores ciphertext and sealed backups. In default trusted-server mode it also receives the backup secret over authenticated HTTPS and stores it encrypted under a separate server recovery master key. The server can recover message keys in this mode; this is server-assisted encryption, not protection from the server operator.

Safety numbers use Signal's numeric fingerprint, 60 digits compared by voice or in person. Nothing can scan a code yet, so the dialog shows no QR code. In the default trusted-server mode, a contact's directory identity can change without a review dialog. The client keeps previously accepted public keys for historical signatures and clears the verified mark when an unsigned identity change is accepted. Device identity signatures, signed prekeys, backup signatures and message signatures are still checked; an invalid device signature is never accepted.

Settings > Encryption offers **Require safety checks in this browser** as an advanced, per-browser option. This restores explicit review of unsigned contact identity changes and manual browser approval. A changed identity blocks sending until reviewed, and the draft stays in the composer. Signed rotations from an already trusted identity keep the verified state in either mode. Disabling the server's `trustServerByDefault` setting also enables strict behavior.

Marking a contact as verified, removing the mark and accepting a changed safety number follow the user to their other browsers. Each browser keeps a list of contacts with the identity key it trusts, the verified flag and the time it changed. The list is sealed with AES-256-GCM under a key that HKDF derives from the backup secret, and stored in the backup row with its own version. A browser that changes an entry merges it into the stored list, the newer change per contact wins, and the server tells the user's other sessions with `E2EE_TRUST_UPDATE` so they merge it too. In strict operation without previously published server recovery, the server cannot read or forge this list. Default server-assisted recovery gives the operator access to the backup secret and therefore this list. A browser that meets a contact for the first time through the list trusts the key another of the user's browsers saw, instead of trusting whatever the server serves first. A reset makes a new backup secret, so it starts the list over.

## Key backup and new devices

Every browser profile and origin is its own device. Without a backup, a new device can't sign itself and can't read anything sent before it existed. The key backup fixes both, and it's on by default.

The device that holds the identity key creates a random 32-byte backup secret and an X25519 backup keypair. The server stores one `E2eeKeyBackup` row per user:

- the identity private key and the backup private key, each sealed with AES-256-GCM under a key derived from the backup secret with HKDF,
- the backup public key, signed by the identity key so peers can check it,
- the backup secret itself, sealed under a key derived from the password or the recovery code, with the KDF name, its parameters and a random 16-byte salt,
- a version number, so two devices can't overwrite each other's changes.

Content keys reach the backup in two ways. History backfill revalidates stored envelopes and recovers their content keys even when the rendered plaintext is already cached, so creating a backup after rendering history still uploads those keys. Every new envelope carries a `backup` list with the content key sealed to each member's backup public key, covered by the envelope signature. For older messages, a device that can read a message uploads its content key sealed to its own backup key into `E2eeBackupKey`, one row per user and message id. The sealed key is bound to the user, the message id and the envelope signature, so an edit invalidates the old row. When a device first gets the backup key it walks the history of every encrypted conversation once and uploads what's missing.

### Password mode

This is the default. The client patch hooks `POST /auth/login`, `POST /auth/register` and `PATCH /users/@me` in the HTTP client, so it sees the password before it leaves the browser and uses it only after the server accepts it. It derives a 32-byte key with Argon2id from `hash-wasm` (64 MiB, 3 iterations, parallelism 1) and the salt in the backup row. The password is sent to the normal account authentication endpoint. The password wrapper itself is produced in the browser; default trusted-server mode separately publishes a signed recovery copy of the backup secret.

- After the first login, the device creates the identity and the backup in one go.
- A device that holds the identity but never saw the password, such as a session from before the backup existed or a QR login, doesn't create a backup without a sealed secret. Default mode keeps background linking active without opening a dialog. Settings > Encryption retains a password field that checks `POST /users/@me/e2ee/password` before creating or sealing the backup; strict mode also shows the explicit composer notice.
- On a new browser, logging in fetches the backup, unseals the secret, restores the identity key, signs the new device and decrypts the history. There are no prompts. Until the backup opens, the tab keeps the password in `sessionStorage`, sealed with AES-GCM under a non-extractable key stored in IndexedDB, for at most 10 minutes. A reload right after the login response still unlocks the browser, and the entry is deleted once the backup opens or the password is used.
- If the identity was made on a browser that never saw the password and no backup exists yet, a password login on another browser can't restore it. When the user has no encrypted conversations there is nothing to lose, so that browser resets encryption with the password it just saw, becomes the identity holder and creates the backup. The old browser finds its device revoked and later unlocks from the backup like any other.
- A password change reseals the backup secret under the new password with a fresh salt. The backup keypair stays, so no content key needs resealing. If the browser doing the change doesn't hold the secret, it unseals it with the old password first.
- If a device holds the secret and logs in with a password that doesn't open the backup, it reseals the backup with that password, since the login just proved it's correct.

Users from before the backup existed have an identity key that WebCrypto created as non-extractable, so it can't be put in a backup. On the next login the device holding it creates a new identity key, signs a rotation statement with the old one, re-signs all devices that the old key had signed, and then creates the backup. Peers accept a rotation signed by the identity key they already trust without a safety number warning and keep the verified state. Other devices of the same user follow the rotation the same way.

### Recovery-code mode

In Settings > Encryption the backup can switch to a recovery code: 32 characters from Crockford's base32 alphabet, about 160 bits, shown once as a grid of four-character groups. The code only replaces the password lock after the user clicks "I saved it", and the dialog can't be closed with Escape or a backdrop click while the code is on screen. The secret is then sealed under HKDF-SHA256 of the code, and the password no longer opens it. A new browser doesn't interrupt the user after login. Default mode can restore a published server recovery copy using the current account password, even when the local wrapper uses a recovery code. It also tries linking through another authenticated, unlocked browser without an approval dialog. If no recovery copy or browser can supply the secret, the draft remains in the composer and the required account-password prompt cannot reconstruct missing keys; the client never resets historical keys or sends plaintext to work around missing keys. Strict safety mode exposes the Unlock notice and recovery dialog. The Encryption settings retain manual recovery controls in either mode. Switching back to the password asks for it and checks it with `POST /users/@me/e2ee/password` before resealing, which works for accounts without an email.

### Server-assisted password recovery

An unlocked browser in default trusted-server mode publishes its backup secret with an identity signature bound to its user, device, current backup version and secret digest. The server requires an active device owned by the current session, validates the signature, decrypts both backup key boxes and derives their public keys from the private seeds before storing anything. Recovery requires both account authentication and the current account password. The response is never cached. Identity changes invalidate the stored binding; reset and account deletion remove it.

Authenticated browsers check recovery readiness through `GET /users/@me/e2ee/backup/escrow`. This returns public identity metadata and readiness, never the recovery secret or ciphertext. An existing valid recovery copy is reused across reloads, and concurrent publications are coalesced. Logout or identity changes cancel pending publication. Startup resolves the authenticated user through REST without waiting for the gateway to finish connecting. An anonymous 401 during login discovery rejects that probe without ending the encryption session. Only a 401 from a request started for the current initialized user stops encryption handling; a late anonymous response cannot disable a newly authenticated browser.

The recovery master key is generated once in `.e2ee-recovery.key` alongside `CONFIG_PATH`, with private file permissions. Docker stores it in the persistent state volume. Operators can instead set `E2EE_RECOVERY_KEY_FILE` or provide a 32-byte base64url/hex `E2EE_RECOVERY_MASTER_KEY`. Back up this key separately from the database. Missing or invalid master keys fail closed; existing recovery rows prevent automatic replacement of a lost key. Never serve the key file from a public assets directory.

This mechanism preserves existing keys rather than resetting history. It cannot reconstruct secrets already lost before a browser published recovery. Keep a recovery code or an unlocked browser for those accounts.

### Resetting encryption

When the recovery code is lost and no other browser can approve a new one, the unlock dialog and the settings page offer "Reset encryption". After a warning and the account password, the browser generates a new identity key and calls `POST /users/@me/e2ee/reset` with the password and the new public key. The server checks the password, revokes every device, deletes the backup and the stored message keys and stores the new identity in one request, so another online device can't race it with an identity of its own. The browser wipes its local keys, signs a new device and creates a new password-mode backup. The user's own browsers can't read the old messages anymore and show them as "Sent before encryption was reset" with no button, since no device or backup can bring those keys back. Other browsers of the user need approval again, and they ask for it on their own as soon as they find their device revoked. Contacts in strict safety mode see a safety number change; default mode accepts the new directory identity after validating its signed device records. Both keep reading what they already received: the revoked devices stay on the server with their `revoked_at`, and a client still accepts a revoked device's signature for a message sent before that time, as long as the device was signed by an identity key it trusted for that user before. Each client remembers the identity keys it trusted earlier for every contact and for its own account.

The tabs of one browser share IndexedDB, so a tab that wipes or resets its keys tells the others over the `BroadcastChannel`, and they reload their state. Key setup runs under a Web Lock per user, so two tabs never register two devices at once.

### Approving from another device

A locked device sends `E2EE_LINK_REQUEST` through `POST /users/@me/e2ee/link`, which the server relays to the user's own sessions only. The exchange commits to the new device's ephemeral key before the approver reveals its own, so the server can't grind a matching code:

1. The new device sends a request with its name and the SHA-256 of an ephemeral X25519 public key.
2. Each online device that holds the backup secret answers with its own ephemeral public key. The server only relays answers, approvals, denials and invites from active devices. Tabs of one browser share the device, so only one of them answers: the tabs elect a leader with the Web Locks API and talk over a `BroadcastChannel`. The leader does the key exchange and the other tabs show the same prompt and code, forwarding Approve and Deny to it. A tab whose session the server no longer accepts gives up the leader lock, so a follower's request is never stuck behind it.
3. The new device collects answers for 1.2 seconds, up to four, then reveals its public key to each of them and ignores later answers, so the server can't pick an approver key after seeing the requester's. Each approver checks the key against the commitment.
4. In strict safety mode, every approver shows "New login on Mac OS X • Chrome" with the time the browser signed in and its location, Approve and Deny, and a six-digit code computed from the request id and both public keys. Browsers are named from the session's operating system and browser, the same way Logged-in Devices names them, and fall back to the name the browser registered with. The new device lists one code per approver under the approver's name. When two devices have the same name, the name gets the time the device was added, with seconds if the minutes match.
5. In default mode, an unlocked browser automatically approves only a requesting device that the server associates with a currently signed-in session of the same account and that is not revoked. It still checks the ephemeral-key commitment and uses the same encrypted exchange. No approval dialog or comparison code is shown. In strict mode the user chooses Approve or Deny. Approve seals the backup secret with AES-GCM under HKDF of the X25519 shared secret. The new device unseals it and continues as if it had entered the password. Deny revokes the pending device and signs its session out, the same way Remove does, so the denied browser shows the denial on the login page and can only ask again after someone signs in there again. The first Approve or Deny wins, and the other approvers close their prompt as soon as they see it.

The new device repeats its request every 10 seconds for 5 minutes while nobody has answered, so a device that comes online later still gets the prompt. If every approver it is comparing codes with stops being active, it starts a new request. It sends one request per browser, from the leader tab, when it loads locked and when it becomes locked mid-session, unless the user snoozed the unlock dialog. When it unlocks another way, the user clicks "Not now" or the tab closes, it sends a `cancel` stage, a keepalive `fetch` on `pagehide` in the last case, and the prompt disappears on every other device.

A pending device in Settings > Encryption > Your devices has an Approve button on every unlocked browser. It sends an `invite` stage to that device, which then starts a request as if the user had clicked "Ask for approval" there.

### Devices

Every device row remembers the session that registered it, and `GET /users/@me/e2ee?device_id=` updates it when the same browser signs in again. The state endpoint adds the session's last activity and location to the user's own devices. Removing a device in the settings asks for confirmation, revokes it and logs its session out. A browser that finds its own device revoked deletes its identity key, backup secret, device key and prekeys, so it has to go through the password, the recovery code or an approval again. Logging out with User Settings > Log Out deletes the same keys right away, so a shared machine doesn't keep the secret that opens the backup. Pending devices are revoked once their session is gone or after 7 days.

The settings are in User Settings, under Encryption, next to Data & Privacy, and also open from the safety numbers dialog.

### What the user sees

Normal private chats have a quiet encryption status in the header and no lock attached to each successfully decrypted message. New conversations do not require a Turn On action. Password login unlocks the backup automatically; a signed-in browser can link another authenticated browser in the background. Default mode does not open encryption setup, safety-review, approval or recovery dialogs automatically. If background unlock cannot finish, the browser requires the account password in a simple prompt with no skip or plaintext bypass. The header status uses a dim, neutral color.

While keys are loading, messages show "Decrypting…" or "Preparing private chat…" and fill in when keys arrive. Sending waits for bootstrap and validated recipient devices. If preparation cannot finish, the draft remains in the composer with a short status message and, when this browser needs authentication, a required account-password prompt; nothing is sent as plaintext. An account password cannot open a recovery-code-only backup by itself. When no other unlocked browser can supply its keys, the prompt explains that limitation and leaves history intact; manual recovery stays in advanced settings. Missing historical keys and failed ciphertext remain clearly marked. Lost history is never silently reset. Manual recovery and destructive reset controls remain available in Encryption settings, with password checks and confirmation.

The advanced strict safety option restores Unlock controls and explicit contact verification and browser approval. Enabling encryption explicitly on an older conversation still posts its system notice; previous plaintext messages are not rewritten. Forwarding, polls and unsupported attachment flows stay disabled in encrypted conversations because the server rejects plaintext or incompatible payloads there.

## Message format

Encrypted messages carry a new `encrypted` field. `content` holds a fallback string the server writes itself, so mentions, search and push notifications never see plaintext.

```json
{
  "content": "🔒 Encrypted message",
  "nonce": "...",
  "flags": 4,
  "encrypted": {
    "v": 1,
    "alg": "x25519-hpke-aes256gcm-ed25519",
    "sender_device": "...",
    "iv": "...",
    "ct": "...",
    "keys": [
      { "user_id": "...", "device_id": "...", "prekey_id": 3, "enc": "...", "wrapped": "..." }
    ],
    "sig": "..."
  }
}
```

The AEAD additional data binds the channel id, the sender, the sender device and the nonce, so a ciphertext can't be moved to another channel or replayed. Version 1 binds local ids. Version 2, used when a member or the channel belongs to another instance, binds canonical `@id@instance` ids instead, see below. Encrypted messages never get link embeds. Reactions, pins, typing, read states and reply structure stay in plaintext.

The encrypted payload is JSON with `content` and, when the message has them, `attachments` and `stickers`. Polls and clips aren't encrypted, so the attach menu disables "Create Poll" and clips in an encrypted DM and the server rejects them there.

### Mentions

The server can't read who a message mentions, so the sending browser lists them. Before encrypting, it collects every `<@id>` in the text outside code blocks that names another member of the conversation and puts those ids in the envelope's `mentions` field, in plaintext. Version 2 envelopes list canonical ids. The list is part of what the sender signs, after `backup`, as `{ "mentions": [...] }` with the ids sorted, and an envelope without mentions signs exactly what it signed before.

The server accepts at most 100 ids, with no duplicates and no empty list. Every id has to be a current member of the conversation other than the sender, or the send fails with `E2EE_INVALID_ENVELOPE`. `allowed_mentions` still applies, so a reply that turns pings off mentions nobody. The server then fills `mentions` on the message the same way it does for plaintext, which gives the mentioned member the mention entry, the push notification in a muted conversation and the mention in the message object every client receives.

After decrypting, the reader's browser keeps only the entries of `mentions` that the decrypted text names, plus the author of a replied-to message, and sets `mention_everyone` when the text has `@everyone` or `@here`. Discord's client then highlights the row like any other mention. A sender who lists someone the text doesn't name can still trigger that person's push notification, the same as writing the mention in the text, but the row isn't highlighted for them.

This puts who was mentioned in the server's metadata, next to who sent what and when. The server already knows every member of a DM or group DM and counts every message there as a mention for unread badges, so the list only adds which of those members the sender named. Leaving the list out would cost the highlight in other browsers and the push notification in a muted group.

### Attachments

Files go through Discord's normal cloud upload flow, and the client rewrites each step in the HTTP client hook:

1. `POST /channels/:id/attachments` gets a random `.bin` file name, the ciphertext size, `application/octet-stream` as the content type and no `X-Discord-Original-MD5` header. The client remembers the upload by its `upload_url` and `upload_filename`.
2. The `PUT` to the upload URL carries the file encrypted with a fresh AES-256-GCM key and nonce. The file is cut into 64 KiB chunks, each sealed with the nonce XORed with the chunk index and an AAD that names the index and marks the last chunk, so chunks can't be reordered or dropped. Before encrypting, the client reads the width and height of images and the size and duration of videos.
3. The message send replaces each attachment with `{ id, filename, uploaded_filename }`, where `filename` is the `.bin` name. The real file name, content type, size, dimensions, alt text, spoiler flag, voice message duration and waveform, and the key and nonce go into the encrypted payload. Stickers move from `sticker_ids` into the payload as `{ id, name, format_type }`.

The server only accepts attachments in an encrypted channel when the stored name matches `[a-z0-9]+.bin`, the content type is `application/octet-stream`, there are no dimensions and the request carries no alt text, title, waveform, duration, spoiler or clip fields. It answers anything else with `E2EE_PLAINTEXT_ATTACHMENT`.

After decrypting a message, the client matches each payload entry to the server attachment with the same `.bin` name and rewrites the attachment with the real metadata and a virtual URL, `/e2ee/attachments/<channel>/<attachment>/<name>`, as both `url` and `proxy_url`. A service worker registered at `/e2ee-sw.js` with root scope answers those URLs. On a miss it asks the open tabs over a `MessageChannel` for the real CDN URL and the key, downloads the ciphertext, decrypts it and keeps up to 256 MiB of plaintext in memory. It ignores the query strings Discord appends, answers `Range` requests so videos and voice messages can seek, and serves only images, video, audio and PDF with their own type. Text types are served as `text/plain`, everything else as an `application/octet-stream` download, and every response carries `nosniff` and a sandboxing CSP, so a hostile file can't run script on the instance's origin. Discord asks for video thumbnails with `?format=`, and the worker answers those with the first frame, which the tab that asked renders on a canvas. Encryption waits for the worker to control the page, for up to 8 seconds, before it reports ready. The server answers `/e2ee/attachments/*` with a 404, so a page without the worker shows a broken file instead of the app.

Edits keep the attachments of the decrypted original in the new payload. Removing one attachment sends a `PATCH` with only the kept attachment ids and `.bin` names and re-encrypts the payload without the removed entry. A message whose decrypted content is empty, such as a sticker or a voice message, is refreshed through Vencord's `updateMessage` after a local `MESSAGE_UPDATE`, because Discord's partial message update ignores empty content and sticker changes.

Search in an encrypted DM never reaches the server. The client answers `GET /channels/:id/messages/search` and `POST /channels/:id/messages/search/tabs` itself from the decrypted copies of the last 1000 messages, matching every word of the query and the author filter.

## Group membership

### Members without keys

A member who has never signed in since encryption existed has no device and no key backup, and nothing sent to them can ever be opened by them. A member whose devices are all signed out still has a key backup, and the envelope's `backup` list lets them read the message after their next login. Before each send the browser looks up every member's keys and decides:

- When every other member of the conversation has neither an active device nor a key backup, nobody else could read the message. The browser refuses the send, keeps the draft and shows an error that names them. In a DM this is the only case.
- When only some members are in that state, the message goes to everyone else, and a warning names the members who can't read it. The envelope skips their keys and the server accepts it, since it only requires keys for active devices.

Before this rule a single member without keys stopped every send into a group with "Preparing private chat…" and no reason, and one member who signed out everywhere was enough to do it.

### Members who left a group

The content key of every message is wrapped to every member's devices when it is sent, so a member who stays can still open the messages of someone who left. Opening one needs the sender's device keys to check the signature, and those come from `POST /e2ee/keys/query`. When a member leaves a DM or group DM, or is removed, a trigger on `recipients` records them in `former_recipients` with the channel, the host instance for a mirror and the time. The directory answers for a former member to anyone who is a member of that channel now. A stranger, or someone who only shares a different conversation, still gets nothing. Someone added after the member left also gets their keys. That only lets them check the signatures of messages they can already see and can't open. The migration that adds the table fills it from the authors of encrypted messages who are no longer members.

Across instances the member's home answers the key request when the asking instance hosts a group the member left, or when one of the asking instance's users is still in that group on the home's mirror. The asking instance sends the left group as its channel hint when the user has no current conversation there. When the home refuses with 403, an instance keeps its cached copy of a former member's keys instead of deleting it, so old messages keep verifying. One case is still open as ENC-022: a third instance that never cached the keys, asking a home whose last local member has left the group, gets nothing, because the home deleted its mirror.

## Client integration

A small loader in `assets/client_patches/10-e2ee-loader.js` pushes a fake chunk into `webpackChunkdiscord_app` to get the bundle's module require, then finds modules by shape and never by numeric id, since ids change every build:

- the Flux dispatcher, through `addInterceptor`, for history, pins, search and mention loads,
- the gateway socket's `getDispatchHandler`, wrapping the `preload` step of `MESSAGE_CREATE` and `MESSAGE_UPDATE`. The socket only flushes events whose preload has finished, so async decryption can't reorder messages, and notifications see plaintext,
- the HTTP client object with `get`, `post`, `put`, `patch` and `del`, to decrypt REST responses,
- the message queue's `drain`, to encrypt sends and edits.

The heavy code is bundled with `Bun.build` (`scripts/build-e2ee.js`) into `assets/public/e2ee/e2ee.js`. The `fosscordE2ee` Vencord plugin connects it to Discord's own UI: a pre-send hook that keeps a refused message in the composer, the attach menu changes, a message re-render hook for decrypted messages, and the Encryption page in User Settings. When the loader can't find a hook it shows an "E2EE unavailable in this client build" banner and refuses to send in encrypted channels. It never falls back to plaintext. `scripts/e2ee-anchors.js` checks the anchor strings after every `bun run generate:client`.

The UI supplies a quiet private-chat header status and an Encryption page in User Settings for key backup, recovery, device management and the advanced strict safety option. Healthy decrypted messages have no extra lock decoration. Default mode prepares private chats automatically; explicit verification and review dialogs remain available when requested or when strict safety checks are enabled.

If the server rate limits device registration, the browser doesn't fail closed for good. Encrypted conversations show a notice that names the wait, and setup retries by itself once the limit expires.

The client plugin derives its settings layout nodes from Equicord's entry builder. Private send and edit preparation failures use `showToast` with the current `failure` type; the guard still cancels sending after waiting 20 seconds for the encryption bridge. Guild sends and the bridge's cancellation decision are preserved.

## Server work

- Entities `E2eeIdentity` and `E2eeDevice`, a channel encryption state, and a nullable `encrypted` jsonb column on messages, plus a migration.
- Routes under `users/@me/e2ee` for the identity, devices and prekeys, `POST /e2ee/keys/query` limited to users who share a channel or relationship or who left a channel the caller is in, and `PUT /channels/:id/e2ee`.
- `handleMessage` validates envelopes. It checks the shape, a size limit of `limits.e2ee.maxEnvelopeBytes` (64 KiB by default), that the sender device belongs to the sender and isn't revoked, and that no recipient device is missing. Then it forces the fallback content, empty embeds and the suppress-embeds flag. It also rejects plaintext sends into encrypted channels, and rejects forwards, polls, plaintext stickers, attachments that aren't opaque `.bin` files, and components there.
- Gateway events `E2EE_DEVICES_UPDATE`, `E2EE_IDENTITY_UPDATE`, `E2EE_TRUST_UPDATE`, `CHANNEL_E2EE_UPDATE` and `E2EE_LINK_REQUEST`/`E2EE_LINK_RESPONSE`.
- `POST /users/@me/e2ee/password` to check the account password and `POST /users/@me/e2ee/reset` to start over with a new identity. `PUT /channels/:id/e2ee` answers `E2EE_RECIPIENT_NO_DEVICES` with the `user_ids` that have no active device, so the client can name them.
- Rate limits for key queries, device registration, prekey rotation, password checks and resets. Registration counts only new device ids, `limits.e2ee.deviceRegistrationsPerHour` (30 by default), and re-signing an existing device has its own limit, `deviceUpdatesPerHour` (60). Key queries follow `keyQueriesPerMinute` (60). Operators can change these and the pending device lifetime from the admin dashboard's Site settings, and the new values apply without a restart. The generic `/users/@me` write limit skips the e2ee routes, which all have their own.
- `E2eeKeyBackup` and `E2eeBackupKey`, with `GET`, `PUT` and `PATCH /users/@me/e2ee/backup`, `POST /users/@me/e2ee/backup/keys`, `POST /users/@me/e2ee/backup/keys/query` and `PUT /users/@me/e2ee/backup/trust`, which replaces the sealed verification list when the request names its current version. All of them only touch the caller's own rows. Uploads are capped at 100 keys a request and only accepted for encrypted messages in the caller's channels. `PUT /users/@me/e2ee/identity` accepts a rotation when it's signed by the current identity key.

## Conversations with users of other instances

A DM or group DM that includes someone from another [federated](federation.md) instance is encrypted from its first message, like any other private chat. The instance where the conversation was created hosts it and stores the ciphertext. Every other member's instance, their home, keeps a mirror and relays their requests to the host.

The host can't turn encryption off. A home keeps `e2ee_enabled_at` and the type of a mirrored DM once it has them, starts a new mirror encrypted when the host leaves the field out, and answers `E2EE_REQUIRED` (90002) itself when a member's client tries to relay a message or an edit without `encrypted`. The plaintext never leaves the home.

### Version 2 envelopes

Local ids differ on each instance, so a signature over them would not verify on the other side. A version 2 envelope has `"v": 2` and signs canonical ids: the channel, the sender, `mid` on an edit, and `user_id` in `keys[]` and `backup[]` are all `@snowflake@instance`. Device ids are hashes of the device's signing key, the same on every instance, and are never translated. The client asks `GET /federation/objects` for the canonical ids, and the signed payload and the AES-GCM additional data use them in place of the local ids. Conversations with only local members keep version 1, byte for byte.

The server takes version 2 in a federated conversation and version 1 everywhere else, and answers `E2EE_INVALID_ENVELOPE` (90003) to the other one. On a version 2 edit, `mid` must be the canonical id of the edited message. It translates `keys[].user_id` and `backup[].user_id` to local ids for the recipient and device checks, which work as in version 1: every active device of every member needs a key, or the server answers `E2EE_DEVICE_MISMATCH`. The relay copies `encrypted` between instances without touching it, so the bytes the sender signed are the bytes every member receives.

The payload inside a version 2 envelope uses canonical ids too. Before encrypting, the browser rewrites user, role and channel mentions, custom emojis and sticker ids from local ids to `@snowflake@instance`, and after decrypting a version 2 message it asks `GET /federation/objects?canonical=` for the local ids on its own instance. A mention whose canonical id the reader's instance can't map is shown as `@snowflake@instance` text, so it never points at the wrong person. Replies and message references sit outside the envelope, and the relay translates them like any other id. The host translates canonical mentions back to its own ids in the text of a verified report.

Identity statements stay per user. A device statement and a rotation statement sign the user's snowflake on their home instance, so the client checks a remote contact's devices against the snowflake in that contact's canonical id, not against the local shadow id.

### Key directory

`POST /e2ee/keys/query` answers for remote members too. When it lists a shadow user, the instance asks the user's home with a signed `GET /federation/v2/users/<canonical id>/e2ee` and caches the answer for 10 minutes. The home answers only to an instance that shares a DM, a group DM or a friendship with the user, or one the host confirms as the host of a conversation the user is in. Before caching, the asking instance checks that each device id is the hash of its signing key and that each signed prekey verifies, and drops the device otherwise. A device whose identity signature doesn't verify is listed as pending, so no client encrypts to it. The home forwards `E2EE_DEVICES_UPDATE` and `E2EE_IDENTITY_UPDATE` for its users, and the other instance drops its cached copy and passes the event on to its own clients. Adding a remote member to an encrypted group DM fails with `E2EE_RECIPIENT_NO_DEVICES` (90007) when their instance doesn't return an active device.

### Backups and history

Each member's content key is wrapped to their own backup key, which is listed in the directory with their identity. A member reads history on a new browser through their own instance: the mirror relays `GET /channels/<id>/messages` to the host, and the key backup at `/users/@me/e2ee/backup/keys` accepts the local ids of mirrored messages, so a browser that logs in with the password decrypts the whole conversation without another device online.

### Safety numbers and strict mode

Safety numbers for a remote contact are computed over the contact's home snowflake and their identity key, and each side computes the same 60 digits as the other. In default mode a browser accepts identity changes from the directory, which for a remote contact means trusting both the user's own instance and the contact's home. Strict safety mode pins the identity key, blocks sending when it changes and shows the safety number for comparison, so neither instance can swap a key without the user seeing it.

### What each instance sees

The host stores the ciphertext, the attachments and the metadata of the conversation: who is in it, who sent what and when, sizes, reactions and read state. Each home sees the same metadata for its own members' view, because events and history pass through it, and it caches attachment ciphertext in its media proxy. No instance gets a content key, except when a member reports a message.

## Reporting encrypted messages

The server can't read an encrypted message, so a report on one would only show the fallback text. When a user reports a message in an encrypted channel, the client hook on `POST /reporting/message` and `POST /reporting/first_dm` adds `e2ee_content_key`, the 32-byte content key of that one message, which the reporter's browser already holds from decrypting it. It also adds `e2ee_context_keys`, the keys of the encrypted messages it can read in the 50 messages around the reported one, so the report can show the conversation. No other key leaves the browser, and the server never stores a key.

It looks up the sender's device, checks that the device belongs to the message's author and wasn't removed before the message was sent, verifies the Ed25519 signature over the stored envelope, and then decrypts the stored ciphertext with the key and the same additional data the client uses. The report snapshot keeps the decrypted text, up to 4000 characters, and up to 10 file names from the payload. The encrypted files themselves aren't shown. A reporter can't change what the message says, because the text comes from the ciphertext the sender signed and the server stored, and a wrong key fails the AES-GCM check.

The admin dashboard marks the report "Verified encrypted text" when all of this passes. A report without a key, with a key that doesn't open the message, or with a signature that doesn't verify is stored as "Encrypted, not verified" with the reason, and shows the fallback text. The server checks each context message the same way and saves the text only for the ones that pass. `scripts/tests/encrypted-report.test.cjs` covers these cases, and `e2ee-test.mjs` reports a message through the real client and checks the stored text.

A report about a message in a conversation hosted on another instance goes to the host through the home relay, which translates the ids in `e2ee_context_keys`. The host verifies a version 2 envelope with the canonical ids of the channel, the author and the message, and looks up the author's devices in the key directory when the author is remote.

Instance automod only reads plaintext. It skips encrypted messages and only acts on one when a report carries a copy whose signature verifies, as [automod.md](automod.md#encrypted-messages) describes.

## What it doesn't protect

The server ships the client JavaScript, so a malicious operator can ship a client that leaks keys. That is the limit of any E2EE on the web. Publishing the patch bundle hash and a pinning extension or desktop wrapper reduce it. Metadata is visible to the server: who talks to whom, when, sizes, reactions, read state and which members a message mentions. For files that includes the number of attachments, each ciphertext size, which is the file size plus 16 bytes per 64 KiB, and the voice message flag. Sticker images still load from the instance's CDN, so the server sees which sticker a client renders. In a conversation with users of other instances, the host and every member's home see this metadata. Default mode trusts the server key directory, including later identity changes and the server's claim that a requesting browser is signed in to the same account. A compromised server could substitute identities or authorize a device link; default mode does not independently prove those claims to the user. Strict safety mode adds contact pinning, safety-number comparison and explicit approval instead. Trusted-server mode escrows the backup secret encrypted at rest under a master key kept outside the database. The strict browser option skips recovery upload and retrieval; it does not delete an escrow previously published by another trusted browser. Disabling server trust prevents recovery endpoints from accepting or returning secrets. Discord's own analytics and Sentry code runs in the same page, so their payloads need auditing to keep plaintext out.

Password mode trades some of that protection for convenience. Whoever holds a copy of the database has the salt and the sealed secret, so they can guess passwords offline, at the cost of one 64 MiB Argon2id run per guess. A weak or reused password makes the encryption about as strong as that password. Recovery-code mode avoids this, because 160 random bits can't be guessed, but losing the code and every signed-in device means losing the history. The backup secret also sits in each unlocked browser's IndexedDB, so malware with access to the profile can read it there.

## Phases

0. Spikes: hook proof of concept with armored content, and a WebCrypto/HPKE proof of concept across Chrome, Firefox and Safari.
1. MVP for DMs and group DMs: server data, server API, message pipeline, client crypto core, client hooks, client UI.
2. Device linking and encrypted attachments, stickers and voice messages. Done.
3. Key backup with password and recovery-code modes, device approval and history on new devices. Done.
4. Hardening: React-level UI patches, bundle hash pinning, analytics audit, fuzzing, a cross-browser test matrix.
5. MLS for group DMs, then opt-in encrypted guild channels.

## Testing

Development setup seeds an empty private DM and posts sample messages only in the test server. Browsers establish encryption before sending private messages, and the seed script never attempts plaintext delivery. Run the browser suite against an isolated database named explicitly by `E2EE_TEST_DATABASE_NAME`:

```sh
PORT=<port> E2EE_TEST_DATABASE_NAME=<db> bun scripts/dev/e2ee-test.mjs
```

The harness registers disposable accounts and refuses an unexpected database before writing. One phase builds a group DM with a member who sends a message and leaves, then checks that a member who was never their friend reads it, that a mention is listed in the envelope and on the message and is highlighted for the member it names, that a send goes through with a warning after a member with no keys joins, and that a DM with that member refuses the send. `scripts/tests/e2ee-former-members.test.cjs`, `e2ee-mentions.test.cjs` and `e2ee-unreadable-members.test.cjs` cover the same rules without a browser.

`scripts/dev/federation-e2ee-test.mjs` starts two instances on their own new databases and runs the same browser flows across them: a DM both ways with edits, an encrypted image from each side, a text file from the member whose home relays it, mentions inside encrypted text in both directions, safety numbers in strict mode, a group DM with members on both instances, history after a password login on a fresh browser and a report the host verifies. It drops its databases and browser profiles at the end.

```sh
CHROME_PATH=<browser> bun scripts/dev/federation-e2ee-test.mjs
``` It never clears global rate limits. It restores password-backed access before removing its browser profiles, and keeps the profiles when restoration fails. [setup.md](../self-hosting/setup.md) covers the development setup.
