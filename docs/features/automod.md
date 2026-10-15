# Instance automod

Automod is a set of instance-wide rules that the server applies to messages, names and signups. It runs before anything is saved, logs every action to the `automod_actions` table and shows that log on the Automod page of the admin dashboard at `/admin/#/automod`. The page needs the `MANAGE_USERS` right, the same as Reports.

## Slur auto-ban

When a user posts the hard-R n-word, the server does the following:

1. It refuses the message or name with error code `200000` for messages and a `NAME_NOT_ALLOWED` field error for names.
2. It sets `users.suspended_until` to now plus `automod.slurs.suspendDays` (7 by default), deletes the user's sessions and emits `SB_SESSION_REMOVE`, so open clients sign out. Login and the token check refuse the account until that time passes, then it can sign in again without anyone lifting anything.
3. It records a Hateful Conduct violation issued by the official account, with the Temporary Ban and Message Removal actions. The user sees it on their Account Standing page, and it stays there for `automod.slurs.violationDays` (90 by default).
4. When `automod.slurs.deleteAllMessages` is on, which is the default, it deletes every message the user ever sent, in batches of 500, and emits `MESSAGE_DELETE_BULK` for each channel. The count is written to the log entry when it finishes.
5. It writes a log entry with the rule, where it happened and an excerpt with the matched word masked.

The rule checks new messages and edits in servers, DMs and group DMs, poll questions and answers, and thread, channel and server names on create and rename. Webhook messages, interaction responses and system accounts are skipped.

The matcher is in `src/util/util/SlurMatcher.ts`. It builds the term from a pattern of letter classes, not a stored string. Before matching it applies NFKC, lowercases, strips combining marks, zero-width and other format characters and Hangul fillers, maps Cyrillic, Greek and other look-alike letters and regional indicator emoji to Latin letters, and shortens runs of three or more of the same character to two. The pattern then accepts leetspeak (`1`, `!`, `|`, `3`, `@`, `6`, `9`, `q`), repeated letters and up to four separators between letters. It does not match Niger, Nigeria, Nigerian, Nigerien, snigger, niggard or niggardly. The soft-A spelling only counts when `automod.slurs.includeSoftA` is on, and it then gets the same action. A 20,000 character adversarial input takes under 500 ms in the tests.

Turning `automod.slurs.enabled` off disables the rule for messages and names. Usernames that match the blocked name words are still refused.

`automod.slurs.action` is `suspend` by default, which does all of the above. It can also be `log`, `delete`, `timeout`, `hold` or `disable`, which refuse the message and take that action instead, the same as the spam rules below. Only `suspend` records a violation and wipes messages.

## Word lists

`automod.wordLists` holds extra lists. Each list has a `name`, `terms` (up to 500), an `action` and `suspendDays`:

| Action    | What happens                                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `log`     | The match is logged and the message goes through.                                                                                     |
| `delete`  | The message is refused and logged. The account is untouched.                                                                          |
| `timeout` | The message is refused and the account is timed out in that server, or muted on the instance outside a server, like the spam rules. |
| `hold`    | The message is refused and the account goes back to waiting for approval, like the spam rules.                                      |
| `suspend` | The message is refused, the account is suspended for `suspendDays` and a violation is recorded. The user's other messages are kept. |
| `disable` | The message is refused and the account is disabled, like the spam rules.                                                            |
| `name`    | Only usernames, display names, nicknames and server, channel and thread names are refused. Messages pass.                           |

Every list also applies to names. A term matches as a whole word with the same folding and leetspeak as the slur rule, so `ass` matches "@$$" and "a s s" but not "class". A `*` at the start or end of a term allows longer words on that side, so `scam*` matches "scammer".

`automod.allowList` holds words automod never acts on. The matcher removes them from the folded text before it looks for anything else. "Not a match" in the log adds the matched text to this list.

## Names

Registration, username, display name and server nickname changes check the slur rule and the word lists first, then the blocked name words in `user.identityBlockedTerms` that [identity-moderation.md](identity-moderation.md) describes. A refused name returns a `NAME_NOT_ALLOWED` field error on the field that was edited, and the attempt is logged with action `block`. Names never suspend anyone, because a person who types a name gets the error before anything is saved.

The Automod page can scan existing accounts for usernames and display names the rules would refuse, 10,000 accounts per click, and disable the ones you select. Disabling also signs them out everywhere. Operators can't be disabled by someone without the operator right, and nobody can disable themselves there.

## Join reasons and approval

`register.joinReason.required` adds a required "Why do you want to join?" answer to signup. `register.joinReason.minLength` (20 by default) and `register.joinReason.maxLength` (1000) bound it. The FosscordJoinReason plugin adds the textarea to the stock signup form when the server sends `GLOBAL_ENV.REGISTER_JOIN_REASON`, which it does when the reason is required or approval is on. The answer is stored in `users.join_reason`, checked against automod, and shown in Join requests on the Automod page and in the admin user drawer.

`register.requireApproval` holds every new account for a moderator. Registration creates the account with `join_status = "pending"` and answers with an `ACCOUNT_PENDING_APPROVAL` field error instead of a token, so the stock client stays on the form and the plugin shows "Your account was created. A moderator needs to approve it before you can log in, so try logging in later." Login and the token check refuse pending and rejected accounts with a field error under the email and password inputs. This approach was picked over a limited session because the stock client already shows login field errors, while a limited session would need every route and the gateway to be restricted.

Join requests flag answers that look low effort:

- **Too short**: fewer than 4 words or 20 characters.
- **Repeated characters**: a run of four of the same character, a short chunk repeated, one character over 40% of the text, or fewer than half the words being unique.
- **Keyboard mash**: a run of five keys along a keyboard row, a word over 24 characters, or mostly Latin letters with under 20% vowels.
- **Same as other signups**: the same normalized answer from two or more other accounts in the last 7 days.

Moderators can approve or reject in bulk. Rejecting signs the accounts out. The admin users list has filters for suspended accounts, accounts waiting for approval and accounts that gave a reason.

## Sign-in and signup limits

These sit on top of the route rate limits, which allow 2 successful registrations per IP every 12 hours and 5 login attempts per IP per minute by default.

- `automod.registration.maxAccountsPerIpPerDay` counts every account created from one IP over 24 hours, including pending ones, which the route limiter misses because they answer with an error. It is off at 0. A blocked signup returns `TOO_MANY_REGISTRATIONS` and is logged with rule `ip_limit`. Signups with a registration token skip it.
- `automod.login.maxFailedAttemptsPerAccount` (10) and `automod.login.lockoutMinutes` (15) lock an account for one address after that many wrong passwords from that address, counting an IPv6 /64 as one address. Someone guessing from their own address only locks themselves out. After 10 times that many wrong passwords from all addresses together, the account is also locked for every address it has never signed in from, while addresses with one of its sessions, or the one it registered from, can still sign in. The lock returns `ACCOUNT_LOGIN_LOCKED` before the password is compared, and a successful sign-in clears the count for that address. Set the attempts to 0 to turn it off.

### Accounts per address

`src/api/util/utility/ipAccountCaps.ts` caps how many accounts one address can have. An IPv4 address counts on its own, and `::ffff:` mapped addresses count as the IPv4 address. An IPv6 address counts together with every address in its /64, because one home or phone usually gets a whole /64. Both caps are off at 0.

- `automod.registration.maxAccountsPerIp` counts accounts whose `registration_ip` is in the group and that aren't deleted or disabled. Accounts waiting for approval and rejected accounts count. When the count has reached the cap, the signup fails with a `TOO_MANY_ACCOUNTS_ON_IP` field error on the username and email. Signups with a registration token skip it, like the daily limit.
- `automod.login.maxAccountsPerIp` counts other accounts with a session whose `last_seen_ip` is in the group and that was used in the last `automod.login.sessionActiveDays` (30) days. A sign-in fails with a `TOO_MANY_ACCOUNTS_ON_IP` field error on the login and password when that count has reached the cap. The account's own sessions don't count, so someone who is already signed in from the address can sign in again. A new session only gets an address once its token is used for a request, so a session that was never used doesn't count. This cap is off by default because schools, offices and mobile carriers put many people behind one address.

Staff, meaning operators and accounts with a staff role, never count toward either cap and can always sign in. The daily signup limit also skips Cloudflare, private and allow-listed addresses, the same as the caps. `automod.ipAllowList` holds addresses and CIDR ranges, such as `192.0.2.0/24` or `2001:db8::/48`, that both caps skip. Refusals are logged with rule `ip_account_limit`, source `registration` or `login` and a term like "3 accounts on 2001:db8:1:2::/64, limit 3", at most once every 10 minutes per address and account.

The Automod page has a lookup that lists who counts toward both caps for one address, and links to Users, IP addresses, which lists every address with its account count.

## Spam rules

`src/util/util/SpamDetector.ts` checks every message create, every content edit and every new thread across the instance, before the server's own AutoMod rules run. It counts in memory with sliding windows, so a message costs no database query. `src/api/util/utility/spamGuard.ts` enforces what it finds. Accounts from other instances post through the same routes, so the rules cover them too. System accounts and accounts with the `BYPASS_RATE_LIMITS` right are skipped.

| Rule                                 | Trips when                                                                                                                                  | Default action |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `everyone_spam`                      | An account tries @everyone or @here twice without the permission, or pings it 4 times with the permission, within 10 minutes.              | timeout        |
| `mention_spam`                       | One message mentions 10 users or roles, or an account mentions 20 within 60 seconds.                                                        | timeout        |
| `flood`                              | An account sends 15 messages within 10 seconds, or posts in 5 channels within 30 seconds.                                                   | timeout        |
| `duplicate`                          | One account posts the same text of 30 or more characters in 3 channels, or 5 accounts post it, within 2 minutes.                           | delete         |
| `link_spam`                          | An account younger than 7 days posts 2 invites or 4 other links within 5 minutes.                                                          | delete         |
| `new_account_burst`                  | 4 accounts younger than 1 day post the same text of 10 or more characters within 5 minutes.                                                | suspend        |
| `duplicate_attachment`               | 3 accounts younger than 7 days post the same file, or one such account posts it in 3 channels, within 10 minutes. Files under 256 bytes are skipped. | delete         |
| `dm_spam`                            | An account opens DMs with 10 people, sends 10 friend requests, or sends the same DM text of 8 or more characters into 4 DM channels within 10 minutes. | timeout        |
| `scam_link`                          | A message links to a scam or phishing site. See Scam and phishing links below.                                                              | delete         |

Members who can manage the server never count toward permitted @everyone pings, mention spam or the channel limit of the flood rule, and @everyone in a DM is ignored. Server moderators also skip the one account in several channels part of the repeated content rule, so an announcement posted in 3 channels passes. Edits count only toward the @everyone and mention rules. "The same text" is compared after NFKC folding, lowercasing, removing invisible characters, mentions, numbers and punctuation, reducing links to their host, joining spaced out letters and collapsing repeated letters. A message that is only links keeps the full link instead, so 5 people sharing different YouTube videos don't match. Two texts with the same set of 3 or more words of 3 or more letters also match. An end-to-end encrypted message counts only toward the flood rule and the file rules, because the server sees the `🔒 Encrypted message` placeholder instead of its text. The placeholder never counts as text, even on a message that arrives without the encrypted flag.

These cases are left alone on purpose, because they used to catch ordinary people:

- Links to the domains in `automod.spam.ignoreLinkDomains` (tenor.com, giphy.com and klipy.com by default) and to this instance's own hosts don't count toward link spam and aren't compared as repeated content. Invites always count.
- `@everyone` inside an email address like `someone@here.com` and mentions inside code spans and code blocks don't count.
- Plain text with no link, invite or mention only counts as repeated content or a new account burst when it shows up in 2 or more channels, or when the accounts posted it more times than there are accounts. A server's verification phrase or "hi" typed once by each new member in one channel passes, and a raid that repeats it still trips.
- The flood rule's channel limit counts channels in one server, so saying hi in 5 servers joined from Discovery, or replying to 5 DMs, passes.
- The same DM text rule skips DMs to friends, so "happy new year" to 4 friends passes.
- Accounts from other instances are aged by their `created_at` on their home instance, not by when this instance first saw them.

Repeated files are compared by SHA-256. The message route hashes uploaded files in memory while it handles them, and the CDN writes `cloud_attachments.content_hash` when a file uploaded through the attachment flow arrives, so nothing reads a file again later. Only the hash stays in memory for the window.

DM opens count new DM channels with people who aren't friends, and each group DM recipient counts once. Friend requests count outgoing requests that aren't accepting one. The same DM text rule only sees DMs the server can read. Local DMs are end-to-end encrypted by default, so it covers DMs with accounts on other instances and plaintext DMs. Accounts younger than `automod.spam.dms.newAccountHours` (72) can also only open `newAccountDmsPerHour` (5) new DMs an hour, and the next one gets Discord's error 40003, "Opening direct messages too fast", with HTTP 429. That limit is logged with rule `dm_spam` once every 10 minutes per account.

Each rule has `enabled`, `action`, its thresholds, its windows and `exemptAccountAgeDays`. Accounts older than that age skip the rule, and 0 checks everyone. For `new_account_burst` the age works the other way: only accounts younger than it count.

The actions, from weakest to strongest:

- `log` writes the automod log and lets the message through.
- `delete` refuses the message with error 200000 and deletes the earlier messages that counted toward the rule with one `MESSAGE_DELETE_BULK` per channel.
- `timeout` also sets the member's `communication_disabled_until` in that server for `automod.spam.timeoutMinutes` (60). Server owners are never timed out in their own server, and the message is only deleted. Spam in DMs mutes the account on the whole instance instead, stored in `rate_limits` as `spam-mute:<id>` so a restart keeps it.
- `hold` also puts a local account back to `join_status = "pending"` and signs it out, so it waits in Join requests like a held signup until a moderator approves or rejects it.
- `suspend` also sets `suspended_until` for `automod.spam.suspendHours` (24).
- `disable` also disables the account.

Every hit records a strike in `rate_limits` as `spam-strikes:<id>`. After `escalateAfterStrikes` (3) strikes within `strikeWindowHours` (24), each further hit moves the action one step up, stopping at suspend. Timeout and hold both step up to suspend. When the account is from another instance, suspend and disable also add a user `FederationBlock`, the same block as the Federation admin page, so that instance can no longer relay it here. Undo in the log lifts timeouts, instance mutes, suspensions, disables and these federation blocks.

## Scam and phishing links

`src/util/util/ScamLinks.ts` reads every link in a message, including bare ones like `discord-gift.ru/x` with a common top level domain, and `src/api/util/utility/scamGuard.ts` runs it inside the spam check on message create, edit and thread creation. A hit refuses the message with error 200000 and "Your message was blocked because it links to a site that looks like a scam or phishing page.", is logged with rule `scam_link` and the reason as the term, and gets `automod.scam.action` (`delete` by default) like the spam rules. Bots are skipped.

| Kind        | Catches                                                                                                                                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lookalike` | A domain that isn't the real one for Discord, Steam, Epic Games, Roblox, MetaMask, Coinbase, Binance and other wallets but uses the brand: one typo away for names of 6 to 9 letters, two for longer ones (`discrod.com`, `steamcommunlty.com`), the brand next to a bait word (`discord-gift.ru`, `steam-gift.xyz`), or the real domain inside a longer one (`discord.com.login-verify.ru`). |
| `homoglyph` | A domain that spells a brand with look-alike letters, written in Unicode or punycode (`xn--dscord-pvf.com`).                                                                                                                  |
| `gift_bait` | Text offering free Nitro, skins or gifts next to a link to another site.                                                                                                                                                      |
| `qr_login`  | A link to `/ra/` on Discord or this instance, which is the QR code login page, and text asking people to scan a QR code to claim something.                                                                                    |
| `ip_logger` | Grabify, iplogger.org and similar sites.                                                                                                                                                                                      |
| `shortener` | bit.ly, tinyurl.com and other shorteners from accounts younger than `automod.scam.shortenerAccountAgeDays` (7).                                                                                                              |
| `listed`    | A domain in `automod.scam.extraDomains` or in the remote list.                                                                                                                                                                |

Links to the real sites, to this instance's own hosts and to fan sites like discord.js.org, steamdb.info and nitrotype.com pass. Short brand words like "steam" and "epic" only count next to a bait word. `automod.scam.allowDomains` lets a domain through when it is a false positive. `lookalikes`, `giftBait`, `qrLogin` and `ipLoggers` turn each kind off.

`automod.scam.remoteListUrl` is off by default. When it is set, the server fetches it through the public fetch path every `remoteListRefreshMinutes` (360) and when the address changes, never per message, and reads up to 8 MB. The list can be plain text with one domain per line, a hosts file, a JSON array or a JSON object with a `domains` array. Entries for the brands' real domains are dropped. The Automod page shows how many domains it loaded and the last error, and can fetch it right away.

The older `guild.safety.harmfulLinkDomains` check in `src/api/util/utility/automod.ts` still runs first. It refuses a short list of known Discord and Steam typo domains with error 200000 and doesn't write the automod log.

## Signup scoring

`src/util/util/SignupSignals.ts` gives every signup a score, and `src/api/util/utility/signupGuard.ts` acts on it before the captcha is spent.

| Signal            | Points | When                                                                                                                                                                       |
| ----------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `disposable_email` | 40     | The email domain or one of its parents is on the bundled list of about 150 disposable mail services in `src/util/util/DisposableEmailDomains.ts`, and not on `allowedEmailDomains`. |
| `similar_names`   | 30     | 3 or more signups in the last 30 minutes have the same username stem, which is the name without leading and trailing digits and separators, or the same first 6 letters. |
| `same_password`   | 30     | 2 or more signups in the last 30 minutes used the same password.                                                                                                          |
| `fast_captcha`    | 25     | The Cap captcha was solved in under 1500 ms, measured from the challenge's issue time to the solve.                                                                     |

A score of `logScore` (20) or more writes the log with rule `signup_bot` and action `log`. `holdScore` (60) or more creates the account with `join_status = "pending"`, the same as manual approval, and logs action `hold`. `refuseScore` is off at 0. When it is set, a signup at or above it fails with a `SIGNUP_REFUSED` field error. A threshold of 0 turns that step off. A domain on `deniedEmailDomains` always fails with `EMAIL_DOMAIN_NOT_ALLOWED` and is logged with action `block`.

Passwords are compared as the first 16 hex characters of an HMAC-SHA256 with a key the server makes at startup. The key and the recent signups live only in memory, at most 5,000 signups, so nothing about passwords is stored and a restart clears it. Signups with a registration token skip scoring.

## New account quarantine

`automod.quarantine.enabled` is off by default. When it is on, accounts younger than `hours` (24) can't post links other than to this instance's own hosts, upload files, send embeds, use @everyone or @here, or mention more than `maxMentions` (2) people in one message, and they can only start `maxDms` (3) new DMs. Each of the first four is a setting. The check runs on message create, edit and thread creation, on DM creation, and on messages that local accounts relay to other instances.

A refused message gets HTTP 400 with:

```json
{
    "code": 200000,
    "message": "New accounts on this instance can't post links for their first 24 hours. This lifts on Tue, 14 Oct 2026 12:00:00 GMT, or sooner if a moderator clears your account.",
    "restriction": "NEW_ACCOUNT_RESTRICTED",
    "reason": "links",
    "ends_at": "2026-10-14T12:00:00.000Z"
}
```

`reason` is `links`, `attachments`, `embeds`, `mentions` or `dms`. The DM limit answers with HTTP 429 and code 40003 instead. The client shows code 200000 as the automod notice with the message. Refusals are logged with rule `quarantine` once every 10 minutes per account and reason. Bots, system accounts, accounts from other instances and accounts with `BYPASS_RATE_LIMITS` are never quarantined. Accounts from other instances are quarantined by their own instance, which runs the check before it relays their messages.

The Automod page lists the accounts in quarantine and clears the selected ones early. Clearing writes a `quarantine-clear:<id>` row to `rate_limits` that lasts until the quarantine would have ended, and each API process caches it for up to 60 seconds. Undo on a quarantine log entry also clears the account.

## Server verification levels and the explicit media filter

The server applies each server's own `verification_level` to messages, threads and reactions. The levels are Discord's:

| Level | Needs                                              |
| ----- | -------------------------------------------------- |
| 1     | A verified email.                                  |
| 2     | Level 1 and an account older than 5 minutes.       |
| 3     | Level 2 and membership longer than 10 minutes.     |
| 4     | Level 3 and a phone number, when `automod.verification.requirePhoneForHighest` is on. |

The owner, bots, members with any role and members with the bypass verification flag skip it. A refusal gets HTTP 403 with Discord's code 50009, a message that says what is missing and when it lifts, `restriction: "GUILD_VERIFICATION_LEVEL"` and `reason`. Refusals are logged with rule `verification_level` once an hour per server, account and reason. `automod.verification.enforce` turns it off for the whole instance. The phone requirement is off by default because the instance has no SMS provider, so level 4 then works like level 3.

The explicit media filter uses each server's `explicit_content_filter`: 1 checks members without roles and 2 checks everyone. NSFW channels are never checked. There is no image classifier, so the filter marks a file as explicit when its name, title or description has a word from `automod.explicitContent.terms` as a whole word, when its SHA-256 is in `automod.explicitContent.blockedHashes`, or for every image and video when `flagAllMedia` is on, which is off by default. A marked file gets the `CONTAINS_EXPLICIT_MEDIA` attachment flag (16), so the client blurs it. The message is still delivered. Name and hash matches are logged with rule `explicit_content` and action `flag`. `automod.explicitContent.enabled` turns the filter off.

## Federation

Accounts from other instances post through the same routes, so every message rule covers them and the action applies to their shadow account here. When one of them trips a rule that refuses or acts, and `automod.federation.reportToHome` is on, the server also sends a signed `POST /federation/v2/reports` to their home instance with the account's canonical id, the rule, the action, the masked excerpt, the detail and the server name. It sends at most one report per account and rule an hour.

The home instance accepts it when `automod.federation.acceptReports` is on, the account is a local one that isn't deleted, and the sender has sent fewer than `reportsPerHourPerInstance` (120) reports in the last hour. It files a report with type `federated_automod`, no reporter, the reason "Automod on <instance>: <rule>, <action>" and the excerpt as the reported content, and it shows in the Reports queue as "Automod on another instance". A second report from the same instance about the same account and rule while one is open from the last 24 hours returns the open one instead.

## Raid detection

`src/api/util/utility/safety.ts` watches each server.

- A join raid is 15 joins within 120 seconds, 8 joins from accounts younger than 24 hours, or 10 joins through one invite. All three numbers grow with the server: they are multiplied by the larger of 1, 0.5% of its members divided by 15, and three times its usual joins per window divided by 15. The usual join rate is a running count of joins that fades over 6 hours. A server of 20,000 members needs about 100 joins in 120 seconds, and a server that usually gets 12 joins a window needs about 36. It sets `raid_detected_at`, pauses invites for 60 minutes through `invites_disabled_until` unless invites are already paused for longer, and adds later joiners to the same incident.
- A DM raid is 10 members starting DMs with other members within 300 seconds. Members who can kick, ban, time out or manage the server don't count, so moderators messaging members don't pause DMs. It sets `dm_spam_detected_at` and `dms_disabled_until` for 60 minutes.
- A mention raid is 3 accounts tripping `mention_spam` or `everyone_spam` in one server within 300 seconds. It sends `AUTO_MODERATION_MENTION_RAID_DETECTION`, and Discord's "clear" button ends it.

Every raid posts Discord's raid alert to the safety alerts channel when the server has one, at most once an hour per kind, and writes the automod log. Discord's "Pause invites" and "Disable DMs" buttons call `PUT /guilds/:id/incident-actions`, which sets or clears the same fields. Joins through an invite and through registration with an invite are refused while invites are paused, and new DMs between members are refused while DMs are paused. "Report false alarm" clears the alert and ends the incident.

Spam hits and raids are grouped into incidents in the `raid_incidents` table, one per server and kind. An incident is live until 10 minutes pass without a new event, or until someone ends it. Raids in progress and mention raids are reloaded from that table after a restart.

## Rule switches, dry runs and exemptions

`automod.policies` holds one entry for each of 20 rules: `everyoneSpam`, `mentionSpam`, `flood`, `duplicate`, `linkSpam`, `newAccountBurst`, `duplicateAttachment`, `dmSpam`, `scamLink`, `slurs`, `wordLists`, `quarantine`, `verificationLevel`, `ipAccountLimit`, `ipLimit`, `signupBot`, `explicitContent`, `joinRaid`, `mentionRaid` and `dmRaid`. `src/util/util/AutomodPolicy.ts` maps each one to the rule names it writes in the log. Each entry has these fields:

| Field                  | Default                         | Meaning                                                                                              |
| ---------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `enabled`              | true                            | The switch for rules that have no `enabled` of their own: word lists, accounts per address, the daily signup limit and the 3 raid rules. The others keep their own switch. |
| `dryRun`               | false                           | Log what the rule would do with `would_action` set and the action `log`, and act on nobody.          |
| `exemptStaff`          | true for spam and raid rules    | Skip operators and accounts with a staff role.                                                       |
| `exemptBots`           | true for spam, scam, quarantine and verification | Skip bot accounts.                                                                  |
| `exemptVerifiedEmail`  | false                           | Skip accounts with a verified email. Accounts from other instances never count as verified.         |
| `exemptAccountAgeDays` | 0                               | Skip accounts older than this many days, 0 checks everyone. The spam rules keep their own age setting instead. |
| `exemptUserIds`        | `[]`                            | User IDs to skip, up to 500.                                                                         |
| `exemptGuildIds`       | `[]`                            | Server IDs to skip, up to 500.                                                                       |

The defaults match what automod did before the policies existed, so an upgrade changes nothing. In a dry run the message goes through, nothing is deleted, no strike or incident is recorded, and raid rules log one `raid_alert` an hour per server instead of pausing invites or DMs. A dry run of signup scoring logs the hold or refusal it would have made and lets the account in.

`GET /api/v9/admin/automod/rules` lists every rule with its switch, action, policy and what it caught over `days` (7): hits, dry runs, hits a moderator undid or marked as a false positive, and confirmed hits. `PATCH /api/v9/admin/automod/rules/:key` changes one rule and needs `MANAGE_USERS`. It takes the policy fields plus `action` for rules that have one, refuses an action the rule doesn't support and refuses list entries that aren't IDs.

## Appeals

An account that can't sign in because it is suspended, held for review or disabled by staff or automod gets a sign-in error that ends with "To see why or send an appeal, go to <instance>/appeal." The page at `/appeal` asks for the email or username and password and calls `POST /api/v9/auth/appeal`. When the account has two-factor authentication, the route answers `{ mfa: true, ticket, totp, backup, webauthn }` like sign-in does and shows nothing else until the page sends the ticket back with an authenticator code, a backup code or a security key assertion. A verified request gets an `appeal_ticket` that is good for 30 minutes, so sending the appeal doesn't ask for a code again. That route checks the password the same way sign-in does, counts wrong passwords toward the account lock and shares the sign-in rate limit. Without `message` it returns the restriction, the reason built from the newest automod action behind it, when it ends and any appeal already sent. With `message`, up to 1,000 characters, it sends the appeal.

Each account can send one appeal per restriction. The restriction is keyed by the automod action behind it, or by the suspension end when a moderator set it by hand, so a later suspension can be appealed again. Sending the same message twice, such as a retry on a slow connection, returns the first appeal. A different second message gets an `APPEAL_ALREADY_SENT` field error. Accounts from other instances can't use the page, because their password lives on their home instance.

Appeals are stored in `automod_appeals` and listed in the Appeals section of the Automod page. Accepting one lifts the restriction, approves a held account, re-enables a disabled one, marks the automod action behind it as a false positive and overturns its violation. Denying keeps the restriction. The person sees the decision the next time they open the page. Two moderators deciding the same appeal at once can't both act on it, because the first decision claims the row.

## Server AutoMod rules

`src/api/util/utility/automod.ts` enforces Discord's AutoMod rules on message create and edit: keyword, keyword preset, spam, mention spam and member profile rules. A match blocks the message with the rule's custom message, posts the `auto_moderation_message` alert to the alert channel and times the member out when the rule says so. The spam rule reads the same in-memory counters as the instance spam rules.

## Encrypted messages

Automod only sees plaintext. Encrypted DM messages carry ciphertext, and the `content` the server stores for them is a fallback the server writes itself, so the message rule skips them. Nothing in automod changes the encryption protocol.

When someone reports an encrypted message and the report carries that message's key, the server decrypts it and checks the sender's signature as [e2ee.md](e2ee.md#reporting-encrypted-messages) describes. If the signature verifies, `automod.slurs.actOnVerifiedReports` is on and the text has the slur, the server deletes the reported message and applies the slur action with source `report`. Word lists don't act on reports. An unverified copy never triggers anything.

## Admin page

The Automod page has these sections:

- Counts of actions in the last 24 hours and 7 days by rule, accounts waiting for approval, accounts suspended right now, appeals waiting and live incidents.
- The review queue, which lists everything automod did in the last 24 hours that nobody has undone or confirmed yet, leaving out log-only entries. Confirm marks the entry confirmed. Undo reverses it like Undo in the log. False positive reverses it the same way in one click and records it as a false positive.
- Appeals, with tabs for waiting, accepted and denied appeals. Each row shows the account, the restriction, the reason the person saw, their message, and Accept and lift or Deny.
- Rules, a table of all 20 rules with their state (on, off or dry run), action, exemptions and the hits, dry runs and false positives of the last 7 days. Edit opens a drawer with the switch, the action, dry run and the exemptions the rule supports. See catches filters the log to that rule's last 7 days. Confirming a held signup rejects the account and signs it out, and undoing one approves it. A confirmed entry can't be undone from the queue.
- Rule stats for the last 30 days: hits, log-only hits, dry runs, confirmed, undone, false positives and not a match per rule, and the false positive rate, which is undone hits divided by confirmed plus undone hits. It stays empty for a rule until someone reviews one of its hits.
- Raids, which refreshes every 15 seconds. It lists live incidents, the incidents of the last 7 days 10 per page and the 25 accounts caught most often by spam and raid rules this week. Opening an incident shows every account in it. Delete messages, Suspend, Disable and Ban IP addresses act on the selected accounts, or on all of them when none are selected, after a confirmation that names the count. Each run is written to the automod log with source `admin` and to the incident's history.
- Spam rules and Raid detection forms with every setting from the sections above.
- The log, newest first, 25 per page, filtered by rule, action, dry runs only, reversed state and user ID or username. Each row shows the time, the user, the rule or word list, where it happened, the action with the suspension end and wiped message count, or a Dry run badge with what the rule would have done, and the masked excerpt. Rows have Open user, Undo, False positive and Not a match. False positive asks for no confirmation. Undo lifts the suspension if it is still the one this entry set, marks the violation as invalidated and marks the entry reversed. Not a match does the same and adds the matched text to the allow list. Deleted messages stay deleted.
- Join requests with status tabs, low-effort badges and bulk approve and reject.
- A test box that runs text through the word lists, names, scam links for new and older accounts, mention counts, the quarantine and explicit file names, and optionally checks an email, a username against recent signups and an address against the allow list, without acting on anyone.
- Separate forms for scam links with the remote list status, the quarantine with its account list, server verification and explicit media, the slur rule, word lists, the allow list, blocked name words, signups, signup scoring, accounts per address with the address lookup, sign-in protection and federation. Each one saves only its own section through `PATCH /api/v9/admin/automod/settings`.
- The name scan with bulk disable.

The admin user drawer shows the join reason with approve and reject buttons for pending accounts, and a Lift suspension button while a suspension is active. `PATCH /admin/users/:id` accepts `suspended_until` (a date, or `null` to lift) and `join_status`.

## API

All routes are under `/api/v9/admin/automod` and need `MANAGE_USERS`.

| Route                                      | Use                                                                                       |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `GET /`                                    | Settings, counts, pending and suspended account totals.                                   |
| `PATCH /settings`                          | Save one or more of `slurs`, `wordLists`, `allowList`, `identityBlockedTerms`, `registration`, `login`, `spam`, `raids`, `scam`, `signup`, `quarantine`, `verification`, `explicitContent`, `federation`, `ipAllowList`. |
| `POST /test`                               | `{ text, email?, username?, ip? }`, returns what each rule would do.                      |
| `GET /actions`                             | The log. Query `rule`, `action`, `user_id`, `reversed=yes or no`, `review=yes`, `dry_run=yes`, `days`, `limit`, `offset`. `review=yes` is the review queue. Rows carry `would_action` for dry runs. |
| `POST /actions/:id/reverse`                | `{ reversal: "undo", "not_a_match" or "false_positive" }`.                                  |
| `GET /rules`, `PATCH /rules/:key`          | Every rule with its policy and counts over `days` (7), and change one rule. See Rule switches. |
| `GET /appeals`                             | Appeals by `status` (`pending` by default, `accepted`, `denied`, `all`), `limit`, `offset`. |
| `POST /appeals/:id`                        | `{ decision: "accept" or "deny" }`. Needs `MODERATE_USERS`.                                |
| `POST /actions/:id/confirm`                | Confirm an entry. Confirming a hold rejects the account.                                  |
| `GET /stats`                               | Hits, dry runs and reviews per rule over `days` (30), and `pending_appeals`.              |
| `GET /quarantine`, `POST /quarantine`      | Accounts in quarantine, and `{ user_ids }` to clear them early.                           |
| `GET /scam-list`, `POST /scam-list`        | The remote scam list status, and fetch it now.                                            |
| `GET /ip-caps`                             | `ip` query, returns the address group, whether it is exempt, and the accounts counted toward each cap. |
| `GET /join-requests`, `POST /join-requests` | List by `status` (`pending`, `approved`, `rejected`, `low_effort`, `all`), and approve or reject `user_ids`. |
| `GET /names`, `POST /names/disable`        | Scan names after an id, and disable `user_ids`.                                           |
| `GET /raids`                               | Live incidents, recent incidents (`limit`, `offset`, `days`) and top offenders.           |
| `GET /raids/:id`                           | One incident with every account and how often automod acted on each.                     |
| `POST /raids/:id/action`                   | `{ action, user_ids?, reason? }` with `delete_messages`, `suspend`, `disable` or `ban_ip`. |
| `POST /raids/:id/end`                      | End the incident.                                                                         |

`PATCH /settings` also takes `spam` and `raids`. `delete_messages` needs `MANAGE_MESSAGES` as well. The bulk actions skip your own account and, unless you are an operator, operators. `ban_ip` bans the registration and session IP addresses of local accounts through `InstanceBan`, skips your own address and addresses already banned, signs the accounts out, and blocks accounts from other instances from federating.

## Config keys

| Key                                         | Default | Meaning                                                    |
| ------------------------------------------- | ------- | ---------------------------------------------------------- |
| `automod.slurs.enabled`                     | true    | The slur rule.                                             |
| `automod.slurs.action`                      | suspend | What a match does.                                         |
| `automod.slurs.includeSoftA`                | false   | Also act on the soft-A spelling.                           |
| `automod.slurs.suspendDays`                 | 7       | Suspension length.                                         |
| `automod.slurs.deleteAllMessages`           | true    | Wipe the user's messages.                                  |
| `automod.slurs.violationDays`               | 90      | How long the violation shows on Account Standing.          |
| `automod.slurs.actOnVerifiedReports`        | true    | Act on signature-verified encrypted reports.               |
| `automod.wordLists`                         | `[]`    | Extra lists with their own action.                         |
| `automod.allowList`                         | `[]`    | Words automod never acts on.                               |
| `automod.registration.maxAccountsPerIpPerDay` | 0     | Accounts per IP per day, 0 is off.                         |
| `automod.registration.maxAccountsPerIp`     | 0       | Live accounts registered from one address or IPv6 /64, 0 is off. |
| `automod.login.maxFailedAttemptsPerAccount` | 10      | Wrong passwords from one address before it locks, 0 is off. |
| `automod.login.lockoutMinutes`              | 15      | Lock length.                                               |
| `automod.login.maxAccountsPerIp`            | 0       | Other accounts signed in from one address or IPv6 /64, 0 is off. |
| `automod.login.sessionActiveDays`           | 30      | How recently a session must be used to count.              |
| `automod.ipAllowList`                       | `[]`    | Addresses and CIDR ranges both caps skip.                  |
| `automod.scam.enabled`                      | true    | Scam and phishing links, with `action` `delete`.           |
| `automod.scam.lookalikes`, `giftBait`, `qrLogin`, `ipLoggers` | true | Each kind of scam check.                  |
| `automod.scam.shortenerAccountAgeDays`      | 7       | Block shorteners from accounts younger than this, 0 is off. |
| `automod.scam.extraDomains`, `allowDomains` | `[]`    | Domains to always stop or always let through.              |
| `automod.scam.remoteListUrl`                | `""`    | Optional remote domain list, off when empty.               |
| `automod.scam.remoteListRefreshMinutes`     | 360     | How often to fetch it, at least 15.                        |
| `automod.spam.attachments`                  | on      | Repeated files, with `channelLimit` 3, `accountLimit` 3, `minBytes` 256, `windowSeconds` 600 and `exemptAccountAgeDays` 7. |
| `automod.spam.dms`                          | on      | DM and friend request spam, with `openLimit` 10, `friendRequestLimit` 10, `sameContentLimit` 4, `minLength` 8, `windowSeconds` 600, `newAccountHours` 72 and `newAccountDmsPerHour` 5. |
| `automod.signup.enabled`                    | true    | Signup scoring.                                            |
| `automod.signup.logScore`, `holdScore`, `refuseScore` | 20, 60, 0 | Thresholds, 0 is off.                            |
| `automod.signup.windowMinutes`              | 30      | How far back similar names and passwords count.            |
| `automod.signup.*Weight`, `*Limit`, `fastCaptchaMs` | see Signup scoring | Points and limits per signal.               |
| `automod.signup.deniedEmailDomains`, `allowedEmailDomains` | `[]` | Domains to refuse, and domains that aren't disposable. |
| `automod.quarantine.enabled`                | false   | The new account quarantine.                                |
| `automod.quarantine.hours`                  | 24      | How long it lasts.                                         |
| `automod.quarantine.allowLinks`, `allowAttachments`, `allowEmbeds` | false | What quarantined accounts may still do.     |
| `automod.quarantine.maxMentions`, `maxDms`  | 2, 3    | Mentions per message and new DMs during the quarantine.    |
| `automod.verification.enforce`              | true    | Apply server verification levels.                          |
| `automod.verification.requirePhoneForHighest` | false | Ask for a phone number at level 4.                         |
| `automod.explicitContent.enabled`           | true    | The explicit media filter.                                 |
| `automod.explicitContent.flagAllMedia`      | false   | Mark every image and video where the filter applies.       |
| `automod.explicitContent.terms`, `blockedHashes` | 11 words, `[]` | File name words and SHA-256 hashes that mark a file. |
| `automod.federation.reportToHome`           | true    | Report hits on accounts from other instances to their home instance. |
| `automod.federation.acceptReports`          | true    | Take those reports from other instances.                   |
| `automod.federation.reportsPerHourPerInstance` | 120  | Reports taken from one instance per hour.                  |
| `register.joinReason.required`              | false   | Ask why the person wants to join.                          |
| `register.joinReason.minLength`             | 20      | Shortest answer.                                           |
| `register.joinReason.maxLength`             | 1000    | Longest answer.                                            |
| `register.requireApproval`                  | false   | Hold new accounts for a moderator.                         |
| `automod.spam.<rule>`                       | on      | `everyone`, `mentions`, `flood`, `duplicates`, `links` and `burst`, with the thresholds and actions in Spam rules. |
| `automod.spam.ignoreLinkDomains`            | tenor.com, giphy.com, klipy.com | Link domains the spam rules ignore. |
| `automod.policies.<rule>`                   | see Rule switches | Switch, dry run and exemptions per rule.         |
| `automod.spam.timeoutMinutes`               | 60      | Timeout and instance mute length.                          |
| `automod.spam.suspendHours`                 | 24      | Suspension length.                                         |
| `automod.spam.escalateAfterStrikes`         | 3       | Strikes before the action steps up, 0 is off.              |
| `automod.spam.strikeWindowHours`            | 24      | How long a strike counts.                                  |
| `guild.safety.raidJoinThreshold`            | 15      | Joins in `raidJoinWindowSeconds` (120) before scaling, 0 is off. |
| `guild.safety.raidNewAccountJoinThreshold`  | 8       | Joins from accounts younger than `raidNewAccountHours` (24). |
| `guild.safety.raidInviteJoinThreshold`      | 10      | Joins through one invite.                                  |
| `guild.safety.raidPauseInvitesMinutes`      | 60      | Invite pause after a join raid, 0 only alerts.             |
| `guild.safety.dmRaidThreshold`              | 10      | Members starting DMs in `dmRaidWindowSeconds` (300).       |
| `guild.safety.dmRaidPauseDmsMinutes`        | 60      | DM pause after a DM raid, 0 only alerts.                   |
| `guild.safety.mentionRaidThreshold`         | 3       | Mention spammers in `mentionRaidWindowSeconds` (300).      |

The database stores `automod.wordLists`, `automod.allowList`, `automod.ipAllowList`, `automod.spam.ignoreLinkDomains`, every policy's `exemptUserIds` and `exemptGuildIds` and the domain, word and hash lists above as whole lists, so removing an entry removes it.

The `1792809163527-AutomodReview` migration adds `automod_actions.confirmed_at`, `automod_actions.confirmed_by`, an index on `automod_actions (rule, created_at)` for the stats, and `cloud_attachments.content_hash`. `1793004718526-AutomodDryRun` adds `automod_actions.would_action`, and `1793012395748-AutomodAppeals` creates `automod_appeals` with a unique index on the account and restriction.

## Testing

`bun test scripts/tests/instance-automod.test.cjs` covers the matcher with true and false positives, the soft-A switch, adversarial input timing, word lists and stars, the allow list, excerpt masking, join reason signals, config defaults, the migrations and the admin tab registration. `scripts/tests/identity-moderation.test.cjs` covers names and the hook that logs blocked names.

`bun test scripts/tests/spam-detection.test.cjs` covers each spam rule at its threshold edges, account age exemptions, moderators with the @everyone permission, accounts from other instances, escalation, enforcement, the raid checks, incident grouping and the migrations.

`bun test scripts/tests/automod-rules.test.cjs` covers the scam matcher with real scam domains and false positives on github.com, discord.com/channels, the instance's own links, the brands' real sites and fan sites, edit distance edges, the remote list parser, repeated files across accounts and channels with older accounts reposting, DM opens and friend requests at their limits, the same DM text, signup scoring at each threshold, email domain lists, quarantine at its window edge, verification levels, the explicit media filter, address grouping and CIDR ranges, both address caps with operators and the allow list, the migration and the route wiring.

`bun test scripts/tests/automod-policies.test.cjs` covers the policy defaults, every exemption kind, dry runs of word lists, the quarantine and signup scoring, word lists that time out or hold, the slur action, the rules routes and the dry run migration. `bun test scripts/tests/automod-appeals.test.cjs` covers which restriction applies, the reason text, one appeal per restriction with retries, accepting and denying, a second decision on the same appeal, the migration, the rate limit and the sign-in error text. The tests whose names start with "false positive:" in `spam-detection.test.cjs` and `automod-rules.test.cjs` cover each case in the list under Spam rules.

`PORT=3800 AUTOMOD_PROBE_DATABASE=<db> bun scripts/dev/automod-probe.mjs` runs against a server on a database you created and refuses any other. It registers an admin and 7 accounts, then checks a scam link and real links, the same file from three accounts through both upload paths and the stored hash, DM opens and friend requests, the new account DM limit, a held signup confirmed and another undone from the review queue, a denied email domain, the quarantine and clearing it, a server verification level, the explicit media filter, the test box, rule stats, a scam rule in dry run and with an exempt server, a suspended account that sends an appeal from the appeal page and gets it accepted, and both address caps with the allow list and a staff sign-in. The caps run from a public address sent in `X-Forwarded-For`, because loopback and private addresses never count toward them. It restores the settings when it ends. `scripts/dev/federation-probe.mjs` checks that a scam link from an account on the other instance is refused, logged and filed as a report on its home instance.

`PORT=3300 RAID_PROBE_DATABASE=<db> bun scripts/dev/raid-probe.mjs` runs against a server on a database you created and refuses any other. It registers an admin and 9 raiders, then checks a join raid through one invite, Discord's pause and resume invite buttons, the disable DMs button, a mention raid and its clear button, an @everyone wave, a flood across 5 channels, a server keyword rule, and the admin raid routes including an IP ban. It restores the spam and raid settings when it ends.
