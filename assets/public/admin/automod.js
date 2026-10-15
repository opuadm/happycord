"use strict";

const AUTOMOD_RULES = [
  ["hard_r", "Slur (hard R)"],
  ["soft_a", "Slur (soft A)"],
  ["word", "Word list"],
  ["name_blocklist", "Blocked name word"],
  ["ip_limit", "Per-IP signup limit"],
  ["everyone_spam", "@everyone spam"],
  ["mention_spam", "Mass mentions"],
  ["flood", "Message flood"],
  ["duplicate", "Repeated content"],
  ["link_spam", "Link and invite spam"],
  ["new_account_burst", "New account burst"],
  ["join_raid", "Join raid"],
  ["mention_raid", "Mention raid"],
  ["dm_raid", "DM raid"],
  ["scam_link", "Scam or phishing link"],
  ["duplicate_attachment", "Repeated file"],
  ["dm_spam", "DM and friend request spam"],
  ["signup_bot", "Signup bot signals"],
  ["quarantine", "New account quarantine"],
  ["verification_level", "Server verification level"],
  ["explicit_content", "Explicit media filter"],
  ["ip_account_limit", "Accounts per address"],
];
const RAID_RULES = new Set(["everyone_spam", "mention_spam", "flood", "duplicate", "link_spam", "new_account_burst", "join_raid", "mention_raid", "dm_raid", "duplicate_attachment", "dm_spam", "scam_link"]);
const NO_ALLOW_RULES = new Set(["ip_limit", "ip_account_limit", "signup_bot", "quarantine", "verification_level", "explicit_content"]);
const AUTOMOD_ACTIONS = [
  ["suspend", "Suspended"],
  ["delete", "Message deleted"],
  ["block", "Blocked"],
  ["log", "Logged"],
  ["timeout", "Timed out"],
  ["disable", "Disabled"],
  ["federation_block", "Blocked from federating"],
  ["ban", "IP banned"],
  ["hold", "Held for approval"],
  ["flag", "Flagged"],
];
const SPAM_ACTIONS = [
  ["log", "Log only"],
  ["delete", "Delete the messages"],
  ["timeout", "Delete and time out"],
  ["hold", "Delete and hold the account for review"],
  ["suspend", "Delete and suspend the account"],
  ["disable", "Delete and disable the account"],
];
const SPAM_RULES = [
  {
    key: "everyone",
    title: "@everyone and @here spam",
    about:
      "Counts @everyone and @here pings per account. Attempts without the permission count against a lower limit than pings that go through. Members who can manage the server and pings in DMs are never counted.",
    fields: [
      ["unpermittedLimit", "Attempts without permission", "Act when an account reaches this many.", 1, 1000],
      ["permittedLimit", "Pings with permission", "Act when an account reaches this many.", 1, 1000],
      ["windowSeconds", "Counted over", "Seconds", 1, 86400],
    ],
  },
  {
    key: "mentions",
    title: "Mass mentions",
    about: "Counts user and role mentions in one message and across messages. Members who can manage the server are exempt.",
    fields: [
      ["messageLimit", "Mentions in one message", "", 1, 1000],
      ["windowLimit", "Mentions across messages", "Inside the window.", 1, 10000],
      ["windowSeconds", "Window", "Seconds", 1, 86400],
    ],
  },
  {
    key: "flood",
    title: "Message flood",
    about: "Stops an account that sends many messages quickly or posts in many channels in a short time. Members who can manage the server skip the channel limit.",
    fields: [
      ["messageLimit", "Messages", "Inside the message window.", 2, 1000],
      ["windowSeconds", "Message window", "Seconds", 1, 86400],
      ["channelLimit", "Channels", "Inside the channel window.", 2, 1000],
      ["channelWindowSeconds", "Channel window", "Seconds", 1, 86400],
    ],
  },
  {
    key: "duplicates",
    title: "Repeated content",
    about:
      "Catches the same or nearly the same text posted in many channels by one account, or by many accounts at once. Comparing ignores case, spacing, numbers, look-alike letters and the path of links.",
    fields: [
      ["minLength", "Shortest text checked", "Characters", 1, 2000],
      ["channelLimit", "Channels for one account", "", 2, 1000],
      ["accountLimit", "Accounts sending the same text", "", 2, 1000],
      ["windowSeconds", "Window", "Seconds", 1, 86400],
    ],
  },
  {
    key: "links",
    title: "Link and invite spam",
    about: "Limits how many invites and links an account can post. Accounts older than the exemption age are not checked.",
    fields: [
      ["inviteLimit", "Invite links", "Inside the window.", 1, 1000],
      ["linkLimit", "Other links", "Inside the window.", 1, 1000],
      ["windowSeconds", "Window", "Seconds", 1, 86400],
    ],
  },
  {
    key: "burst",
    title: "New account burst",
    about: "Catches several new accounts posting the same text inside the window. Only accounts younger than the age below count.",
    fields: [
      ["accountLimit", "Accounts", "", 2, 1000],
      ["minLength", "Shortest text checked", "Characters", 1, 2000],
      ["windowSeconds", "Window", "Seconds", 1, 86400],
    ],
    ageLabel: "Counts accounts younger than",
  },
  {
    key: "attachments",
    title: "Repeated files",
    about:
      "Catches the same file, by its SHA-256 hash, posted in many channels by one account or by many accounts. Files are hashed once when they are uploaded and never read again. Older accounts reposting an image are not counted.",
    fields: [
      ["channelLimit", "Channels for one account", "", 2, 1000],
      ["accountLimit", "Accounts posting the same file", "", 2, 1000],
      ["minBytes", "Smallest file checked", "Bytes. Tiny files like reaction images are skipped.", 0, 104857600],
      ["windowSeconds", "Window", "Seconds", 1, 86400],
    ],
  },
  {
    key: "dms",
    title: "DM and friend request spam",
    about:
      "Catches one account opening many DMs or sending many friend requests in a short time, and the same DM sent to many people. Accounts younger than the new account age can only start a few DMs an hour. Friends are not counted.",
    fields: [
      ["openLimit", "New DMs", "Inside the window. 0 turns this off.", 0, 10000],
      ["friendRequestLimit", "Friend requests", "Inside the window. 0 turns this off.", 0, 10000],
      ["sameContentLimit", "People sent the same DM", "Inside the window. 0 turns this off.", 0, 10000],
      ["minLength", "Shortest DM compared", "Characters", 1, 2000],
      ["windowSeconds", "Window", "Seconds", 1, 86400],
      ["newAccountHours", "New account age", "Hours. 0 turns the first DM limit off.", 0, 8760],
      ["newAccountDmsPerHour", "First DMs per hour for new accounts", "0 turns this off.", 0, 10000],
    ],
  },
];
const RAID_SETTINGS = [
  ["raidJoinThreshold", "Joins that count as a raid", "Joins to one server inside the join window. 0 turns this off.", 0, 100000],
  ["raidJoinWindowSeconds", "Join window", "Seconds", 10, 86400],
  ["raidNewAccountJoinThreshold", "New account joins that count as a raid", "Inside the join window. 0 turns this off.", 0, 100000],
  ["raidNewAccountHours", "New account age", "Hours. Accounts younger than this count as new.", 1, 8760],
  ["raidInviteJoinThreshold", "Joins through one invite", "Inside the join window. 0 turns this off.", 0, 100000],
  ["raidPauseInvitesMinutes", "Pause invites for", "Minutes after a join raid. 0 only raises the alert.", 0, 1440],
  ["dmRaidThreshold", "Members starting DMs with other members", "Accounts inside the DM window. 0 turns this off.", 0, 100000],
  ["dmRaidWindowSeconds", "DM window", "Seconds", 10, 86400],
  ["dmRaidPauseDmsMinutes", "Disable DMs for", "Minutes after a DM raid. 0 only raises the alert.", 0, 1440],
  ["mentionRaidThreshold", "Accounts sending mention spam", "Accounts inside the mention window. 0 turns this off.", 0, 100000],
  ["mentionRaidWindowSeconds", "Mention window", "Seconds", 10, 86400],
];
const INCIDENT_ACTIONS = [
  ["delete_messages", "Delete messages", "Delete every message sent by"],
  ["suspend", "Suspend", "Suspend"],
  ["disable", "Disable", "Disable"],
  ["ban_ip", "Ban IP addresses", "Ban the IP addresses of"],
];
const AUTOMOD_LIST_ACTIONS = [
  ["log", "Log only"],
  ["delete", "Delete the message"],
  ["timeout", "Delete the message and time out the account"],
  ["hold", "Delete the message and hold the account for review"],
  ["suspend", "Delete the message and suspend the account"],
  ["disable", "Delete the message and disable the account"],
  ["name", "Block names only"],
];
const POLICY_RULES = {
  everyoneSpam: ["@everyone and @here spam", "everyone"],
  mentionSpam: ["Mass mentions", "mentions"],
  flood: ["Message flood", "flood"],
  duplicate: ["Repeated content", "duplicates"],
  linkSpam: ["Link and invite spam", "links"],
  newAccountBurst: ["New account burst", "burst"],
  duplicateAttachment: ["Repeated files", "attachments"],
  dmSpam: ["DM and friend request spam", "dms"],
  scamLink: ["Scam and phishing links"],
  slurs: ["Slur auto-ban"],
  wordLists: ["Word lists"],
  quarantine: ["New account quarantine"],
  verificationLevel: ["Server verification level"],
  ipAccountLimit: ["Accounts per address"],
  ipLimit: ["Signups per address per day"],
  signupBot: ["Signup scoring"],
  explicitContent: ["Explicit media filter"],
  joinRaid: ["Join raids"],
  mentionRaid: ["Mention raids"],
  dmRaid: ["DM raids"],
};
const WOULD_ACTIONS = {
  log: "log it",
  delete: "delete the message",
  timeout: "time the account out",
  hold: "hold the account for review",
  suspend: "suspend the account",
  disable: "disable the account",
  block: "block it",
  name: "block the name",
};
const APPEAL_STATUSES = [
  ["pending", "Waiting"],
  ["accepted", "Accepted"],
  ["denied", "Denied"],
  ["all", "All"],
];
const RESTRICTIONS = { suspended: "Suspended", held: "Held for review", disabled: "Disabled" };
const AUTOMOD_SOURCES = {
  message: "Message",
  message_edit: "Message edit",
  thread_name: "Thread name",
  channel_name: "Channel name",
  guild_name: "Server name",
  report: "Verified encrypted report",
  registration: "Signup",
  username: "Username",
  global_name: "Display name",
  nick: "Server nickname",
  guild_join: "Server join",
  direct_message: "Direct message",
  friend_request: "Friend request",
  login: "Sign-in",
  admin: "Admin dashboard",
};
const JOIN_STATUSES = [
  ["pending", "Waiting"],
  ["low_effort", "Looks low effort"],
  ["approved", "Approved"],
  ["rejected", "Rejected"],
  ["all", "All"],
];

const automodState = {
  log: { rule: "", action: "", user: "", reversed: "", dryRun: "", days: 0, offset: 0, limit: 25 },
  appeals: { status: "pending", offset: 0, limit: 25 },
  raids: { offset: 0, limit: 10 },
  join: { status: "pending", offset: 0, limit: 25 },
  names: { after: null, users: [], scanned: 0, done: false },
};

const SCAM_KINDS = {
  lookalike: "Look-alike domain",
  homoglyph: "Look-alike letters",
  gift_bait: "Free Nitro or gift bait",
  qr_login: "QR code login scam",
  ip_logger: "IP logger",
  shortener: "Link shortener from a new account",
  listed: "Listed scam domain",
};
const QUARANTINE_REASONS = {
  links: "links",
  attachments: "files",
  embeds: "embeds",
  mentions: "too many mentions",
  dms: "more new DMs",
};

const ruleLabel = (rule) => AUTOMOD_RULES.find(([key]) => key === rule)?.[1] ?? rule;
const linesOf = (value) =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

const automodWhere = (entry) => {
  if (entry.guild)
    return html`<span>${entry.guild.name ?? "Server"}</span>${entry.channel ? html`<span class="muted"> · #${entry.channel.name ?? entry.channel.id}</span>` : ""}`;
  if (entry.channel)
    return html`<span>${entry.channel.type === 3 ? "Group DM" : entry.channel.type === 1 ? "Direct message" : `#${entry.channel.name ?? entry.channel.id}`}</span>`;
  return html`<span class="muted">${AUTOMOD_SOURCES[entry.source] ?? entry.source}</span>`;
};

const automodActionBadge = (entry) => {
  if (entry.would_action)
    return html`<span class="badge info">Dry run</span><span class="muted automod-sub">Would ${WOULD_ACTIONS[entry.would_action] ?? entry.would_action}</span>`;
  const label = AUTOMOD_ACTIONS.find(([key]) => key === entry.action)?.[1] ?? entry.action;
  const kind = ["suspend", "disable", "ban", "federation_block"].includes(entry.action)
    ? "danger"
    : ["delete", "timeout"].includes(entry.action)
      ? "warn"
      : "info";
  return html`<span class="badge ${kind}">${label}</span>${
    (entry.action === "suspend" || entry.action === "timeout") && entry.suspended_until
      ? html`<span class="muted automod-sub">until ${fmtDate(entry.suspended_until)}</span>`
      : ""
  }${entry.deleted_messages ? html`<span class="muted automod-sub">${fmtNumber(entry.deleted_messages)} messages wiped</span>` : ""}`;
};

async function renderAutomod(view) {
  const overview = await api("/admin/automod");
  const s = overview.settings;
  const access = state.overview.access;
  const countChips = (counts) =>
    AUTOMOD_RULES.filter(([key]) => counts.by_rule[key]).map(
      ([key, label]) => html`<span class="badge">${label}: ${fmtNumber(counts.by_rule[key])}</span>`,
    );
  const toggle = (name, checked, label, hint) =>
    html`<label class="toggle"
      ><input type="checkbox" name="${name}" ${checked ? raw("checked") : ""} /><span
        >${label}${hint ? html`<span class="hint">${hint}</span>` : ""}</span
      ></label
    >`;
  const number = (name, value, label, hint, min, max) =>
    html`<label
      >${label}${hint ? html`<span class="hint">${hint}</span>` : ""}<input
        type="number"
        name="${name}"
        value="${value}"
        min="${min}"
        max="${max}"
        step="1"
        required
    /></label>`;

  mount(
    view,
    html`
      <div class="page-head">
        <div>
          <h1>Automod</h1>
          <p class="muted">
            Instance-wide rules that run on every message, name and signup. Each section saves on its own,
            and everything automod does is logged below.
          </p>
        </div>
      </div>
      <div class="row automod-jump" role="navigation" aria-label="Automod sections">
        <a class="btn small ghost" href="#automod-review" data-jump>Review</a>
        <a class="btn small ghost" href="#automod-appeals" data-jump>Appeals</a>
        <a class="btn small ghost" href="#automod-rules" data-jump>Rules</a>
        <a class="btn small ghost" href="#automod-rule-stats" data-jump>Rule stats</a>
        <a class="btn small ghost" href="#automod-raids" data-jump>Raids</a>
        <a class="btn small ghost" href="#automod-log" data-jump>Log</a>
        <a class="btn small ghost" href="#automod-join" data-jump>Join requests</a>
        <a class="btn small ghost" href="#automod-test" data-jump>Test text</a>
        <a class="btn small ghost" href="#automod-spam" data-jump>Spam rules</a>
        <a class="btn small ghost" href="#automod-scam" data-jump>Scam links</a>
        <a class="btn small ghost" href="#automod-quarantine" data-jump>Quarantine</a>
        <a class="btn small ghost" href="#automod-servers" data-jump>Server checks</a>
        <a class="btn small ghost" href="#automod-raid-settings" data-jump>Raid detection</a>
        <a class="btn small ghost" href="#automod-slurs" data-jump>Slur auto-ban</a>
        <a class="btn small ghost" href="#automod-lists" data-jump>Word lists</a>
        <a class="btn small ghost" href="#automod-names" data-jump>Names</a>
        <a class="btn small ghost" href="#automod-registration" data-jump>Signups</a>
        <a class="btn small ghost" href="#automod-signup-scoring" data-jump>Signup scoring</a>
        <a class="btn small ghost" href="#automod-ip-caps" data-jump>Accounts per address</a>
        <a class="btn small ghost" href="#automod-login" data-jump>Sign-in</a>
        <a class="btn small ghost" href="#automod-federation" data-jump>Federation</a>
      </div>
      <div class="stack">
        <div class="stats automod-stats">
        <div class="card stat">
          <span class="muted">Actions in the last 24 hours</span>
          <div class="value">${fmtNumber(overview.counts.day.total)}</div>
          <div class="badges">${countChips(overview.counts.day)}</div>
        </div>
        <div class="card stat">
          <span class="muted">Actions in the last 7 days</span>
          <div class="value">${fmtNumber(overview.counts.week.total)}</div>
          <div class="badges">${countChips(overview.counts.week)}</div>
        </div>
        <div class="card stat">
          <span class="muted">Accounts waiting for approval</span>
          <div class="value">${fmtNumber(overview.pending_accounts)}</div>
        </div>
        <div class="card stat">
          <span class="muted">Accounts suspended right now</span>
          <div class="value">${fmtNumber(overview.suspended_accounts)}</div>
        </div>
        <div class="card stat">
          <span class="muted">Appeals waiting</span>
          <div class="value" id="automod-appeal-count">…</div>
        </div>
        <div class="card stat">
          <span class="muted">Raid and spam incidents going on</span>
          <div class="value" id="automod-live-count">${fmtNumber(overview.live_incidents)}</div>
        </div>
      </div>

      <section class="card" id="automod-review" aria-labelledby="automod-review-title">
        <div class="automod-section-head">
          <h2 id="automod-review-title">Review queue</h2>
          <button class="btn small" type="button" id="automod-review-refresh">Refresh</button>
        </div>
        <p class="muted">
          Everything automod did in the last 24 hours that nobody has looked at yet, apart from log-only entries.
          Confirm keeps the action and counts it as a correct hit. Undo and False positive both lift what it did,
          and False positive also counts it against the rule in the rule overview. Confirming a held signup rejects
          the account, and undoing it approves the account.
        </p>
        <div class="list-status muted" id="automod-review-status" role="status" aria-live="polite" hidden></div>
        <div id="automod-review-results"><div class="spinner">Loading…</div></div>
      </section>

      <section class="card" id="automod-appeals" aria-labelledby="automod-appeals-title">
        <div class="automod-section-head">
          <h2 id="automod-appeals-title">Appeals</h2>
          <button class="btn small" type="button" id="automod-appeals-refresh">Refresh</button>
        </div>
        <p class="muted">
          Accounts that can't sign in because they are suspended, held for review or disabled can see why at
          <a href="/appeal" target="_blank" rel="noopener">/appeal</a> and send one message per restriction. Accepting
          lifts the restriction and marks the automod action behind it as a false positive. Denying keeps it. The
          account sees the decision the next time it opens the appeal page.
        </p>
        <div class="row" id="automod-appeal-tabs"></div>
        <div class="list-status muted" id="automod-appeals-status" role="status" aria-live="polite" hidden></div>
        <div id="automod-appeals-results"><div class="spinner">Loading…</div></div>
      </section>

      <section class="card" id="automod-rules" aria-labelledby="automod-rules-title">
        <div class="automod-section-head">
          <h2 id="automod-rules-title">Rules</h2>
          <button class="btn small" type="button" id="automod-rules-refresh">Refresh</button>
        </div>
        <p class="muted">
          Every rule with what it caught in the last 7 days. Edit a rule to turn it off, change what it does, run it as
          a dry run that only logs what it would have done, or skip staff, bots, verified emails, older accounts or
          specific users and servers. Thresholds stay in each rule's own section below.
        </p>
        <div class="list-status muted" id="automod-rules-status" role="status" aria-live="polite" hidden></div>
        <div id="automod-rules-results"><div class="spinner">Loading…</div></div>
      </section>

      <section class="card" id="automod-rule-stats" aria-labelledby="automod-rule-stats-title">
        <h2 id="automod-rule-stats-title">Rule stats for the last 30 days</h2>
        <p class="muted">
          Hits per rule and how moderators judged them. The false positive rate is undone hits divided by every hit
          someone confirmed or undid, so it stays empty until a moderator reviews one.
        </p>
        <div id="automod-rule-stats-results"><div class="spinner">Loading…</div></div>
      </section>

      <section class="card" id="automod-raids" aria-labelledby="automod-raids-title">
        <div class="automod-section-head">
          <h2 id="automod-raids-title">Raids</h2>
          <button class="btn small" type="button" id="automod-raids-refresh">Refresh</button>
        </div>
        <p class="muted">
          Spam waves and server raids grouped into incidents. An incident stays live until 10 minutes pass without a
          new event. Open one to act on every account in it at once. This list refreshes every 15 seconds.
        </p>
        <div class="list-status muted" id="automod-raids-status" role="status" aria-live="polite" hidden></div>
        <h3>Going on now</h3>
        <div id="automod-raids-live"><div class="spinner">Loading…</div></div>
        <h3>Recent incidents</h3>
        <div id="automod-raids-recent"></div>
        <h3>Top offenders this week</h3>
        <div id="automod-raids-offenders"></div>
      </section>

      <section class="card" id="automod-log" aria-labelledby="automod-log-title">
        <h2 id="automod-log-title">Automod log</h2>
        <p class="muted">Every message, name and signup automod stopped, newest first. Excerpts hide the matched word.</p>
        <div class="row automod-filters">
          <label
            >Rule<select id="automod-rule">
              ${options([["", "Any rule"], ...AUTOMOD_RULES], automodState.log.rule)}
            </select></label
          >
          <label
            >Action<select id="automod-action">
              ${options([["", "Any action"], ...AUTOMOD_ACTIONS], automodState.log.action)}
            </select></label
          >
          <label
            >Mode<select id="automod-dry-run">
              ${options(
                [
                  ["", "Everything"],
                  ["yes", "Dry runs only"],
                ],
                automodState.log.dryRun,
              )}
            </select></label
          >
          <label
            >Reversed<select id="automod-reversed">
              ${options(
                [
                  ["", "Either"],
                  ["no", "Still in effect"],
                  ["yes", "Reversed"],
                ],
                automodState.log.reversed,
              )}
            </select></label
          >
          <label class="grow"
            >User<input id="automod-user" type="search" placeholder="User ID or username" value="${automodState.log.user}"
          /></label>
        </div>
        <div class="list-status muted" id="automod-log-status" role="status" aria-live="polite" hidden></div>
        <div id="automod-log-results"><div class="spinner">Loading…</div></div>
      </section>

      <section class="card" id="automod-join" aria-labelledby="automod-join-title">
        <h2 id="automod-join-title">Join requests</h2>
        <p class="muted">
          Reasons people gave when they signed up. "Looks low effort" flags answers that are very short, repeat
          characters, look like keyboard mashing or match two or more other signups from the last 7 days.
        </p>
        <div class="row" id="automod-join-tabs"></div>
        ${
          access.moderate
            ? html`<div class="row automod-bulk">
                <button class="btn small primary" type="button" data-join-action="approve" disabled>Approve selected</button>
                <button class="btn small danger" type="button" data-join-action="reject" disabled>Reject selected</button>
                <span class="muted" id="automod-join-selected" aria-live="polite"></span>
              </div>`
            : ""
        }
        <div id="automod-join-results"><div class="spinner">Loading…</div></div>
      </section>

      <section class="card" id="automod-test" aria-labelledby="automod-test-title">
        <h2 id="automod-test-title">Test text</h2>
        <p class="muted">
          Check text against every saved rule without acting on anyone: word lists, names, scam links, mention spam,
          the new account quarantine and explicit file names. Fill in the optional fields to also check a signup email,
          a username against recent signups, or an address against the allow list. Save a rule first to test it.
        </p>
        <label
          >Text to check<textarea id="automod-test-text" rows="3" maxlength="4000" placeholder="Paste a message, a link, a name or a file name"></textarea>
        </label>
        <div class="form-grid" style="margin-top:12px">
          <label>Email<span class="hint">Optional</span><input id="automod-test-email" type="email" maxlength="320" placeholder="someone@example.com" /></label>
          <label>Username<span class="hint">Optional</span><input id="automod-test-username" maxlength="64" placeholder="newuser123" /></label>
          <label>IP address<span class="hint">Optional</span><input id="automod-test-ip" maxlength="64" placeholder="203.0.113.7" /></label>
        </div>
        <div class="row" style="margin-top:12px">
          <button class="btn" type="button" id="automod-test-run">Check text</button>
        </div>
        <div id="automod-test-result" class="automod-test-result" role="status" aria-live="polite"></div>
      </section>

      <form class="card" id="automod-spam" aria-labelledby="automod-spam-title">
        <h2 id="automod-spam-title">Spam rules</h2>
        <p class="muted">
          Instance-wide checks on every message, edit and thread, including from accounts on other instances. The
          message that trips a rule is refused, and any action other than log also deletes the earlier messages that
          counted toward it. Accounts from other instances are blocked from federating instead of suspended or disabled.
        </p>
        <div class="stack">
          ${SPAM_RULES.map(
            (rule) => html`
              <fieldset class="automod-list" data-spam-rule="${rule.key}">
                <legend>${rule.title}</legend>
                <p class="muted automod-about">${rule.about}</p>
                ${toggle("enabled", s.spam[rule.key].enabled, `Check for ${rule.title.toLowerCase()}`)}
                <div class="form-grid" style="margin-top:12px">
                  <label
                    >When it trips<select name="action">
                      ${options(SPAM_ACTIONS, s.spam[rule.key].action)}
                    </select></label
                  >
                  ${rule.fields.map(([key, label, hint, min, max]) => number(key, s.spam[rule.key][key], label, hint, min, max))}
                  ${number(
                    "exemptAccountAgeDays",
                    s.spam[rule.key].exemptAccountAgeDays,
                    rule.ageLabel ?? "Skip accounts older than",
                    rule.ageLabel ? "Days" : "Days. 0 checks every account.",
                    0,
                    3650,
                  )}
                </div>
              </fieldset>
            `,
          )}
        </div>
        <h3>Penalties</h3>
        <div class="form-grid" data-spam-shared>
          ${number("timeoutMinutes", s.spam.timeoutMinutes, "Timeout length", "Minutes. Spam in a server times the account out there. Spam in DMs stops it sending messages anywhere on this instance.", 1, 40320)}
          ${number("suspendHours", s.spam.suspendHours, "Suspension length", "Hours", 1, 8760)}
          ${number("escalateAfterStrikes", s.spam.escalateAfterStrikes, "Step up after this many strikes", "Each further hit moves one step up, from log to delete to timeout to suspend. 0 never steps up.", 0, 100)}
          ${number("strikeWindowHours", s.spam.strikeWindowHours, "Strikes count for", "Hours", 1, 720)}
          <label class="span"
            >Links that never count<span class="hint">One domain per line, subdomains included. Links to these sites don't count toward link spam and aren't compared as repeated content, unless they are invites. GIF sites are here by default, and links to this instance always count as allowed.</span
            ><textarea name="ignoreLinkDomains" rows="3">${(s.spam.ignoreLinkDomains ?? []).join("\n")}</textarea>
          </label>
        </div>
        <div class="form-actions"><button class="btn primary" type="submit">Save spam rules</button></div>
      </form>

      <form class="card" id="automod-scam" aria-labelledby="automod-scam-title">
        <h2 id="automod-scam-title">Scam and phishing links</h2>
        <p class="muted">
          Stops links that pretend to be Discord, Steam, Epic Games, Roblox or crypto wallets: look-alike letters,
          punycode, typos like discrod.com and names like discord-gift.ru. It also catches free Nitro bait, QR code
          login scams and IP loggers, and link shorteners from new accounts. Links to this instance and the real sites
          always pass. Members who can manage the server are not exempt.
        </p>
        <div class="stack">
          ${toggle("enabled", s.scam.enabled, "Check messages for scam links")}
          ${toggle("lookalikes", s.scam.lookalikes, "Look-alike domains", "Typos, look-alike letters, punycode and brand names mixed with words like gift or nitro.")}
          ${toggle("giftBait", s.scam.giftBait, "Free Nitro and gift bait", "Text offering free Nitro, skins or gifts next to a link to another site.")}
          ${toggle("qrLogin", s.scam.qrLogin, "QR code login scams", "Links to the remote auth page and text asking people to scan a QR code to claim something.")}
          ${toggle("ipLoggers", s.scam.ipLoggers, "IP loggers", "Grabify, iplogger.org and similar sites.")}
        </div>
        <div class="form-grid" style="margin-top:16px">
          <label
            >When it trips<select name="action">
              ${options(SPAM_ACTIONS, s.scam.action)}
            </select></label
          >
          ${number("shortenerAccountAgeDays", s.scam.shortenerAccountAgeDays, "Block link shorteners from accounts younger than", "Days. 0 never blocks shorteners.", 0, 3650)}
          <label class="span"
            >Extra scam domains<span class="hint">One per line. Subdomains count too.</span
            ><textarea name="extraDomains" rows="3">${s.scam.extraDomains.join("\n")}</textarea>
          </label>
          <label class="span"
            >Domains that always pass<span class="hint">One per line, for false positives.</span
            ><textarea name="allowDomains" rows="3">${s.scam.allowDomains.join("\n")}</textarea>
          </label>
          <label class="span"
            >Remote scam list<span class="hint"
              >Optional. A plain text or JSON list of domains, fetched on the schedule below and never per message. Leave empty to only use the built-in rules.</span
            ><input name="remoteListUrl" data-text type="url" maxlength="2048" value="${s.scam.remoteListUrl}" placeholder="https://example.com/scam-domains.txt"
          /></label>
          ${number("remoteListRefreshMinutes", s.scam.remoteListRefreshMinutes, "Fetch the list every", "Minutes", 15, 10080)}
        </div>
        <p class="hint muted" id="automod-scam-list-status"></p>
        <div class="form-actions">
          <button class="btn" type="button" id="automod-scam-refresh" ${s.scam.remoteListUrl ? "" : raw("disabled")}>Fetch the list now</button>
          <button class="btn primary" type="submit">Save scam rules</button>
        </div>
      </form>

      <form class="card" id="automod-quarantine" aria-labelledby="automod-quarantine-title">
        <h2 id="automod-quarantine-title">New account quarantine</h2>
        <p class="muted">
          Limits what accounts can do in their first hours. Refused messages get a notice that says what is blocked and
          when the limit ends. Bots, accounts from other instances and accounts with the bypass rate limits right are
          never quarantined. Off by default.
        </p>
        <div class="stack">
          ${toggle("enabled", s.quarantine.enabled, "Quarantine new accounts")}
          ${toggle("allowLinks", s.quarantine.allowLinks, "Let them post links", "Links to this instance are always allowed.")}
          ${toggle("allowAttachments", s.quarantine.allowAttachments, "Let them post files")}
          ${toggle("allowEmbeds", s.quarantine.allowEmbeds, "Let them post embeds")}
        </div>
        <div class="form-grid" style="margin-top:16px">
          ${number("hours", s.quarantine.hours, "Quarantine length", "Hours after the account was created", 1, 8760)}
          ${number("maxMentions", s.quarantine.maxMentions, "Mentions allowed in one message", "@everyone and @here are always blocked.", 0, 100)}
          ${number("maxDms", s.quarantine.maxDms, "New DMs allowed during quarantine", "0 blocks every new DM.", 0, 1000)}
        </div>
        <div class="form-actions"><button class="btn primary" type="submit">Save quarantine</button></div>
        <h3>Accounts in quarantine</h3>
        <div class="row automod-bulk" ${access.moderate ? "" : raw("hidden")}>
          <button class="btn small" type="button" id="automod-quarantine-clear" disabled>Clear selected early</button>
          <span class="muted" id="automod-quarantine-selected" aria-live="polite"></span>
        </div>
        <div id="automod-quarantine-results"><div class="spinner">Loading…</div></div>
      </form>

      <form class="card" id="automod-servers" aria-labelledby="automod-servers-title">
        <h2 id="automod-servers-title">Server verification and explicit media</h2>
        <p class="muted">
          Applies each server's own verification level and explicit media filter from its Safety Setup page.
          Verification levels need a verified email, an account older than 5 minutes, membership longer than 10
          minutes, or a phone number at the highest level. Members with a role skip them. The explicit media filter
          marks matching files as explicit so the client blurs them, and logs a flag. It doesn't delete anything.
        </p>
        <div class="stack">
          ${toggle("enforce", s.verification.enforce, "Enforce server verification levels on messages")}
          ${toggle("requirePhoneForHighest", s.verification.requirePhoneForHighest, "Require a phone number at the highest level", "Off by default, since this instance has no SMS provider. When off, the highest level asks for a verified email like the level below it.")}
          ${toggle("explicitEnabled", s.explicitContent.enabled, "Run the explicit media filter")}
          ${toggle("flagAllMedia", s.explicitContent.flagAllMedia, "Mark every image and video as explicit where the filter applies", "Without an image classifier, this is the only way to blur everything. Off by default.")}
        </div>
        <div class="form-grid" style="margin-top:16px">
          <label class="span"
            >Explicit file name words<span class="hint">One per line. A file whose name, title or description has one of these words is marked.</span
            ><textarea name="terms" rows="3">${s.explicitContent.terms.join("\n")}</textarea>
          </label>
          <label class="span"
            >Blocked file hashes<span class="hint">SHA-256, one per line. Matching uploads are marked.</span
            ><textarea name="blockedHashes" rows="3">${s.explicitContent.blockedHashes.join("\n")}</textarea>
          </label>
        </div>
        <div class="form-actions"><button class="btn primary" type="submit">Save server checks</button></div>
      </form>

      <form class="card" id="automod-raid-settings" aria-labelledby="automod-raid-settings-title">
        <h2 id="automod-raid-settings-title">Raid detection</h2>
        <p class="muted">
          Per-server raid checks. A raid sets the server's raid alert, posts it to the safety alerts channel when the
          server has one, and pauses invites or DMs for the time below. Server owners can lift the pause from Discord's
          raid banner.
        </p>
        <div class="form-grid">
          ${RAID_SETTINGS.map(([key, label, hint, min, max]) => number(key, s.raids[key], label, hint, min, max))}
        </div>
        <div class="form-actions"><button class="btn primary" type="submit">Save raid detection</button></div>
      </form>

      <form class="card" id="automod-slurs" aria-labelledby="automod-slurs-title">
        <h2 id="automod-slurs-title">Slur auto-ban</h2>
        <p class="muted">
          Catches the hard-R slur in messages, edits, polls, thread, channel and server names, including spaced
          out, leetspeak, look-alike letters and full-width spellings. It ignores Niger, Nigeria, Nigerian, snigger
          and niggardly. Encrypted DMs are only checked when someone reports a message.
        </p>
        <div class="stack">
          ${toggle("enabled", s.slurs.enabled, "Turn on the slur auto-ban", "Rejects the message and takes the action below. A suspension also records a violation on the account's Account Standing page.")}
          ${toggle("includeSoftA", s.slurs.includeSoftA, "Also act on the soft-A spelling", "Off by default. When on, the soft-A spelling gets the same suspension.")}
          ${toggle("deleteAllMessages", s.slurs.deleteAllMessages, "Delete all of the user's messages", "Removes every message the account ever sent, in every server and DM, right after the suspension.")}
          ${toggle("actOnVerifiedReports", s.slurs.actOnVerifiedReports, "Act on verified encrypted reports", "When a report of an encrypted message carries a signature-verified copy of the text, the same action runs.")}
        </div>
        <div class="form-grid" style="margin-top:16px">
          <label
            >When it matches<select name="action">
              ${options(SPAM_ACTIONS, s.slurs.action ?? "suspend")}
            </select></label
          >
          ${number("suspendDays", s.slurs.suspendDays, "Suspension length", "Days. The account can't sign in until it ends, then it lifts by itself.", 1, 365)}
          ${number("violationDays", s.slurs.violationDays, "Violation stays on record for", "Days shown on the user's Account Standing page.", 1, 3650)}
        </div>
        <div class="form-actions"><button class="btn primary" type="submit">Save slur auto-ban</button></div>
      </form>

      <form class="card" id="automod-lists" aria-labelledby="automod-lists-title">
        <h2 id="automod-lists-title">Word lists</h2>
        <p class="muted">
          Extra words to stop, each list with its own action. One word or phrase per line. A word matches on its
          own, so "ass" doesn't stop "class". Put <code>*</code> at either end to also match longer words, like
          <code>scam*</code>. Every list also blocks usernames, display names, nicknames and server names.
        </p>
        <div id="automod-list-editor" class="stack"></div>
        <div class="row" style="margin-top:12px">
          <button class="btn" type="button" id="automod-list-add">Add a word list</button>
        </div>
        <div class="form-actions"><button class="btn primary" type="submit">Save word lists</button></div>
      </form>

      <form class="card" id="automod-allow" aria-labelledby="automod-allow-title">
        <h2 id="automod-allow-title">Allow list</h2>
        <p class="muted">
          Words automod should never act on, one per line. "Not a match" in the log adds the matched word here.
        </p>
        <label
          >Allowed words<textarea name="allowList" rows="4">${s.allowList.join("\n")}</textarea>
        </label>
        <div class="form-actions"><button class="btn primary" type="submit">Save allow list</button></div>
      </form>

      <form class="card" id="automod-names" aria-labelledby="automod-names-title">
        <h2 id="automod-names-title">Blocked name words</h2>
        <p class="muted">
          Words nobody can use in a username, display name or server nickname, one per line, letters and numbers
          only. Matching ignores case, spacing and common number swaps. Existing names are kept, so scan for them below.
        </p>
        <label
          >Blocked name words<textarea name="identityBlockedTerms" rows="5">${s.identityBlockedTerms.join("\n")}</textarea>
        </label>
        <div class="form-actions"><button class="btn primary" type="submit">Save blocked name words</button></div>
      </form>

      <section class="card" id="automod-name-scan" aria-labelledby="automod-name-scan-title">
        <h2 id="automod-name-scan-title">Accounts with names that break the rules</h2>
        <p class="muted">Scans existing usernames and display names against the slur rule, the word lists and the blocked name words, 10,000 accounts at a time.</p>
        <div class="row automod-bulk">
          <button class="btn small" type="button" id="automod-name-scan-run">Scan accounts</button>
          <button class="btn small danger" type="button" id="automod-name-disable" disabled ${access.moderate ? "" : raw("hidden")}>Disable selected</button>
          <span class="muted" id="automod-name-status" aria-live="polite"></span>
        </div>
        <div id="automod-name-results"></div>
      </section>

      <form class="card" id="automod-registration" aria-labelledby="automod-registration-title">
        <h2 id="automod-registration-title">Signups</h2>
        <div class="stack">
          ${toggle("joinReasonRequired", s.registration.joinReasonRequired, 'Ask "Why do you want to join?" at signup', "Adds a required answer to the signup form. Moderators see it in Join requests.")}
          ${toggle("requireApproval", s.registration.requireApproval, "Approve new accounts by hand", "New accounts can't sign in until a moderator approves them in Join requests. The signup form tells them to wait.")}
        </div>
        <div class="form-grid" style="margin-top:16px">
          ${number("joinReasonMinLength", s.registration.joinReasonMinLength, "Shortest answer allowed", "Characters, when the question is required.", 1, 1000)}
          ${number("maxAccountsPerIpPerDay", s.registration.maxAccountsPerIpPerDay, "Accounts per IP address per day", "0 turns this limit off. Counts every account created, including ones waiting for approval.", 0, 100000)}
        </div>
        <p class="hint muted">
          The signup rate limit also applies:
          ${fmtNumber(s.registration.rateLimit.count)} successful signups per IP every
          ${fmtDuration(s.registration.rateLimit.window)}${s.registration.rateLimit.enabled ? "" : " (rate limits are off)"}.
          Change it under Site settings, Rate limits.
        </p>
        <div class="form-actions"><button class="btn primary" type="submit">Save signup rules</button></div>
      </form>

      <form class="card" id="automod-signup-scoring" aria-labelledby="automod-signup-scoring-title">
        <h2 id="automod-signup-scoring-title">Signup scoring</h2>
        <p class="muted">
          Each signup gets a score from the signals below. Past the log score it shows in the automod log, past the
          hold score the account waits in Join requests, and past the refuse score the signup fails. A score of 0
          turns that step off. Passwords are compared as a keyed hash in memory while the server runs and are never
          stored.
        </p>
        ${toggle("enabled", s.signup.enabled, "Score signups")}
        <div class="form-grid" style="margin-top:16px">
          ${number("logScore", s.signup.logScore, "Log at", "Score", 0, 1000)}
          ${number("holdScore", s.signup.holdScore, "Hold for approval at", "Score", 0, 1000)}
          ${number("refuseScore", s.signup.refuseScore, "Refuse at", "Score. 0 never refuses.", 0, 1000)}
          ${number("windowMinutes", s.signup.windowMinutes, "Compare with signups from the last", "Minutes", 1, 1440)}
          ${number("disposableEmailWeight", s.signup.disposableEmailWeight, "Disposable email", "Points", 0, 1000)}
          ${number("similarNameWeight", s.signup.similarNameWeight, "Similar usernames", "Points", 0, 1000)}
          ${number("similarNameLimit", s.signup.similarNameLimit, "Similar usernames before it counts", "Recent signups", 2, 1000)}
          ${number("samePasswordWeight", s.signup.samePasswordWeight, "Same password", "Points", 0, 1000)}
          ${number("samePasswordLimit", s.signup.samePasswordLimit, "Same password before it counts", "Recent signups", 2, 1000)}
          ${number("fastCaptchaWeight", s.signup.fastCaptchaWeight, "Captcha solved too fast", "Points", 0, 1000)}
          ${number("fastCaptchaMs", s.signup.fastCaptchaMs, "Too fast means under", "Milliseconds", 0, 60000)}
          <label class="span"
            >Email domains to refuse<span class="hint">One per line. Signups from these always fail.</span
            ><textarea name="deniedEmailDomains" rows="3">${s.signup.deniedEmailDomains.join("\n")}</textarea>
          </label>
          <label class="span"
            >Email domains that aren't disposable<span class="hint">One per line, for domains on the built-in list that you trust.</span
            ><textarea name="allowedEmailDomains" rows="3">${s.signup.allowedEmailDomains.join("\n")}</textarea>
          </label>
        </div>
        <div class="form-actions"><button class="btn primary" type="submit">Save signup scoring</button></div>
      </form>

      <form class="card" id="automod-ip-caps" aria-labelledby="automod-ip-caps-title">
        <h2 id="automod-ip-caps-title">Accounts per address</h2>
        <p class="muted">
          Caps how many accounts one address can have. IPv4 addresses count on their own and IPv6 addresses count per
          /64. Operators, deleted accounts and disabled accounts don't count, and operators can always sign in. The
          sign-in cap is off by default because schools, offices and mobile carriers put many people on one address.
          See every address under <a href="#/users/ips">Users, IP addresses</a>.
        </p>
        <div class="form-grid">
          ${number("registrationMax", s.registration.maxAccountsPerIp, "Accounts registered from one address", "Counts accounts that still exist. 0 turns this off.", 0, 100000)}
          ${number("loginMax", s.login.maxAccountsPerIp, "Other accounts signed in from one address", "A sign-in fails when this many other accounts already have a session there. 0 turns this off.", 0, 100000)}
          ${number("sessionActiveDays", s.login.sessionActiveDays, "Sessions count when used in the last", "Days", 1, 365)}
          <label class="span"
            >Exempt addresses<span class="hint">One address or CIDR range per line, like 192.0.2.0/24 or 2001:db8::/48.</span
            ><textarea name="ipAllowList" rows="3">${(s.ipAllowList ?? []).join("\n")}</textarea>
          </label>
        </div>
        <div class="form-actions"><button class="btn primary" type="submit">Save address limits</button></div>
        ${
          access.users
            ? html`<h3>Who is on an address</h3>
                <div class="row">
                  <label class="grow">Address<input id="automod-ip-lookup" maxlength="64" placeholder="203.0.113.7 or 2001:db8::1" /></label>
                  <button class="btn" type="button" id="automod-ip-lookup-run">Look up</button>
                </div>
                <div id="automod-ip-lookup-result" role="status" aria-live="polite"></div>`
            : ""
        }
      </form>

      <form class="card" id="automod-login" aria-labelledby="automod-login-title">
        <h2 id="automod-login-title">Sign-in protection</h2>
        <p class="muted">Locks an account after repeated wrong passwords, whichever IP addresses they come from. The per-IP sign-in rate limit applies too.</p>
        <div class="form-grid">
          ${number("maxFailedAttemptsPerAccount", s.login.maxFailedAttemptsPerAccount, "Wrong passwords before a lock", "0 turns the lock off.", 0, 1000)}
          ${number("lockoutMinutes", s.login.lockoutMinutes, "Lock length", "Minutes, counted from the first wrong password.", 1, 10080)}
        </div>
        <div class="form-actions"><button class="btn primary" type="submit">Save sign-in protection</button></div>
      </form>

      <form class="card" id="automod-federation" aria-labelledby="automod-federation-title">
        <h2 id="automod-federation-title">Federation</h2>
        <p class="muted">
          Accounts from other instances go through the same rules here, and what automod does to them applies on this
          instance. These settings also tell their home instance, which sees the report in its Reports queue.
        </p>
        <div class="stack">
          ${toggle("reportToHome", s.federation.reportToHome, "Report automod hits to the account's home instance", "At most one report per account and rule an hour. The report carries the rule, the action and the excerpt from the log.")}
          ${toggle("acceptReports", s.federation.acceptReports, "Accept automod reports from other instances", "They show up in Reports as automod reports from that instance.")}
        </div>
        <div class="form-grid" style="margin-top:16px">
          ${number("reportsPerHourPerInstance", s.federation.reportsPerHourPerInstance, "Reports accepted per instance per hour", "0 accepts none.", 0, 100000)}
        </div>
        <div class="form-actions"><button class="btn primary" type="submit">Save federation</button></div>
      </form>
      </div>
    `,
  );

  for (const link of $$("[data-jump]", view))
    link.addEventListener("click", (event) => {
      event.preventDefault();
      document.querySelector(link.getAttribute("href"))?.scrollIntoView({ block: "start" });
    });

  const save = async (form, body, success) => {
    const saved = await act($("button[type=submit]", form), () => api("/admin/automod/settings", { method: "PATCH", body }), success);
    if (saved) Object.assign(s, saved);
    return saved;
  };
  const values = (form) => Object.fromEntries(
    $$("input[name]:not([data-text])", form).map((input) => [input.name, input.type === "checkbox" ? input.checked : Number(input.value)]),
  );
  const field = (form, name) => form.elements[name];

  $("#automod-slurs", view).addEventListener("submit", (event) => {
    event.preventDefault();
    save(event.currentTarget, { slurs: { ...values(event.currentTarget), action: field(event.currentTarget, "action").value } }, "Slur auto-ban saved");
  });
  $("#automod-registration", view).addEventListener("submit", (event) => {
    event.preventDefault();
    save(event.currentTarget, { registration: values(event.currentTarget) }, "Signup rules saved");
  });
  $("#automod-login", view).addEventListener("submit", (event) => {
    event.preventDefault();
    save(event.currentTarget, { login: values(event.currentTarget) }, "Sign-in protection saved");
  });
  $("#automod-spam", view).addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const spam = Object.fromEntries(
      $$("[data-spam-rule]", form).map((fieldset) => [
        fieldset.dataset.spamRule,
        { ...values(fieldset), action: $("select[name=action]", fieldset).value },
      ]),
    );
    save(
      form,
      { spam: { ...spam, ...values($("[data-spam-shared]", form)), ignoreLinkDomains: linesOf(field(form, "ignoreLinkDomains").value) } },
      "Spam rules saved",
    );
  });
  const scamListStatus = (status) => {
    $("#automod-scam-list-status", view).textContent = !status?.url
      ? "No remote list is loaded."
      : `${fmtNumber(status.domains)} domains from ${status.url}${status.fetched_at ? `, fetched ${fmtDate(status.fetched_at)}` : ""}${status.error ? `. The last fetch failed: ${status.error}` : ""}`;
  };
  scamListStatus(s.scamList);
  $("#automod-scam", view).addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const saved = await save(
      form,
      {
        scam: {
          ...values(form),
          action: field(form, "action").value,
          extraDomains: linesOf(field(form, "extraDomains").value),
          allowDomains: linesOf(field(form, "allowDomains").value),
          remoteListUrl: field(form, "remoteListUrl").value.trim(),
        },
      },
      "Scam rules saved",
    );
    if (saved) {
      $("#automod-scam-refresh", view).disabled = !saved.scam.remoteListUrl;
      scamListStatus(saved.scamList);
    }
  });
  $("#automod-scam-refresh", view).addEventListener("click", async (event) => {
    const status = await act(event.currentTarget, () => api("/admin/automod/scam-list", { method: "POST" }));
    if (status) scamListStatus(status);
  });
  $("#automod-quarantine", view).addEventListener("submit", (event) => {
    event.preventDefault();
    save(event.currentTarget, { quarantine: values(event.currentTarget) }, "Quarantine saved").then((saved) => saved && loadQuarantine());
  });
  $("#automod-servers", view).addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const { enforce, requirePhoneForHighest, explicitEnabled, flagAllMedia } = values(form);
    save(
      form,
      {
        verification: { enforce, requirePhoneForHighest },
        explicitContent: {
          enabled: explicitEnabled,
          flagAllMedia,
          terms: linesOf(field(form, "terms").value),
          blockedHashes: linesOf(field(form, "blockedHashes").value),
        },
      },
      "Server checks saved",
    );
  });
  $("#automod-signup-scoring", view).addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    save(
      form,
      {
        signup: {
          ...values(form),
          deniedEmailDomains: linesOf(field(form, "deniedEmailDomains").value),
          allowedEmailDomains: linesOf(field(form, "allowedEmailDomains").value),
        },
      },
      "Signup scoring saved",
    );
  });
  $("#automod-ip-caps", view).addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const { registrationMax, loginMax, sessionActiveDays } = values(form);
    save(
      form,
      {
        registration: { maxAccountsPerIp: registrationMax },
        login: { maxAccountsPerIp: loginMax, sessionActiveDays },
        ipAllowList: linesOf(field(form, "ipAllowList").value),
      },
      "Address limits saved",
    );
  });
  $("#automod-federation", view).addEventListener("submit", (event) => {
    event.preventDefault();
    save(event.currentTarget, { federation: values(event.currentTarget) }, "Federation settings saved");
  });
  const capLine = (label, part, unit) =>
    html`<p>
      <strong>${label}:</strong> ${fmtNumber(part.count)} ${unit}${part.cap ? html`, cap ${fmtNumber(part.cap)}` : html` <span class="muted">(no cap)</span>`}
      ${part.cap && part.count >= part.cap ? html`<span class="badge warn">At the cap</span>` : ""}
    </p>
    ${part.users.length
      ? html`<div class="badges">${part.users.map((u) => html`<button class="btn small ghost" type="button" data-open="${u.id}">${u.username ? `@${u.username}` : u.id}</button>`)}</div>`
      : ""}`;
  $("#automod-ip-lookup", view)?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    $("#automod-ip-lookup-run", view).click();
  });
  $("#automod-ip-lookup-run", view)?.addEventListener("click", async (event) => {
    const ip = $("#automod-ip-lookup", view).value.trim();
    const target = $("#automod-ip-lookup-result", view);
    if (!ip) {
      target.textContent = "Type an address to look up.";
      return;
    }
    const result = await act(event.currentTarget, () => api(`/admin/automod/ip-caps?${new URLSearchParams({ ip })}`));
    if (!result) return;
    mount(
      target,
      html`
        <p class="muted">
          Counted as ${result.group}${result.exempt ? html` <span class="badge ok">Exempt</span>` : ""}.
          <a href="#/users/ips">Open IP addresses</a>
        </p>
        ${capLine("Registered from here", result.registration, result.registration.count === 1 ? "account" : "accounts")}
        ${capLine(`Signed in here in the last ${result.login.active_days} days`, result.login, result.login.count === 1 ? "account" : "accounts")}
      `,
    );
    for (const button of $$("[data-open]", target)) button.addEventListener("click", () => openUser(button.dataset.open));
  });

  const quarantineResults = $("#automod-quarantine-results", view);
  const quarantineClear = $("#automod-quarantine-clear", view);
  const syncQuarantine = () => {
    const count = $$("input[data-quarantine]:checked", quarantineResults).length;
    quarantineClear.disabled = count === 0;
    $("#automod-quarantine-selected", view).textContent = count ? `${fmtNumber(count)} selected` : "";
  };
  const loadQuarantine = async () => {
    const { users } = await api("/admin/automod/quarantine");
    if (!quarantineResults.isConnected) return;
    mount(
      quarantineResults,
      users.length
        ? html`<div class="table-wrap">
            <table>
              <thead>
                <tr>
                  ${access.moderate ? html`<th><span class="visually-hidden">Select</span></th>` : ""}
                  <th>Account</th>
                  <th class="hide-sm">Created</th>
                  <th>Ends</th>
                </tr>
              </thead>
              <tbody>
                ${users.map(
                  (u) => html`<tr>
                    ${access.moderate ? html`<td><input type="checkbox" data-quarantine="${u.id}" aria-label="Select ${userName(u)}" /></td>` : ""}
                    <td><button class="link-button ident" type="button" data-open="${u.id}">${avatar(u)}<span><strong>${userName(u)}</strong><span class="muted">${userTag(u)}</span></span></button></td>
                    <td class="hide-sm">${fmtDate(u.created_at)}</td>
                    <td>${fmtDate(u.ends_at)}</td>
                  </tr>`,
                )}
              </tbody>
            </table>
          </div>`
        : html`<div class="card empty">${s.quarantine.enabled ? "No accounts are in quarantine." : "Quarantine is off."}</div>`,
    );
    for (const box of $$("input[data-quarantine]", quarantineResults)) box.addEventListener("change", syncQuarantine);
    for (const button of $$("[data-open]", quarantineResults)) button.addEventListener("click", () => openUser(button.dataset.open, loadQuarantine));
    syncQuarantine();
  };
  quarantineClear.addEventListener("click", async () => {
    const user_ids = $$("input[data-quarantine]:checked", quarantineResults).map((box) => box.dataset.quarantine);
    const done = await act(quarantineClear, () => api("/admin/automod/quarantine", { method: "POST", body: { user_ids } }), "Quarantine cleared");
    if (done) loadQuarantine();
  });

  const reviewResults = $("#automod-review-results", view);
  const reviewStatus = $("#automod-review-status", view);
  const loadReview = async () => {
    try {
      const { actions } = await api("/admin/automod/actions?review=yes&limit=100");
      if (!reviewResults.isConnected) return;
      reviewStatus.hidden = true;
      mount(
        reviewResults,
        actions.length
          ? html`<div class="table-wrap">
              <table class="automod-log">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>User</th>
                    <th>Rule</th>
                    <th>Action</th>
                    <th class="hide-sm">Detail</th>
                    <th><span class="visually-hidden">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  ${actions.map(
                    (entry) => html`<tr data-id="${entry.id}">
                      <td>${fmtDate(entry.created_at)}</td>
                      <td>
                        ${entry.user
                          ? html`<button class="link-button ident" type="button" data-open="${entry.user_id}">${avatar(entry.user)}<span><strong>${userName(entry.user)}</strong><span class="muted">${userTag(entry.user)}</span></span></button>`
                          : html`<span class="muted">${entry.username ? `@${entry.username}` : "No account"}</span>`}
                      </td>
                      <td>${ruleLabel(entry.rule)}<span class="muted automod-sub">${AUTOMOD_SOURCES[entry.source] ?? entry.source}</span></td>
                      <td>${automodActionBadge(entry)}</td>
                      <td class="hide-sm automod-excerpt">${entry.term ? html`<span>${entry.term}</span>` : ""}${entry.excerpt ? html`<span class="muted automod-sub">${entry.excerpt}</span>` : ""}</td>
                      <td>
                        ${
                          access.moderate
                            ? html`<div class="row automod-row-actions">
                                <button class="btn small primary" type="button" data-review="confirm">Confirm</button>
                                <button class="btn small" type="button" data-review="undo">Undo</button>
                                <button class="btn small ghost" type="button" data-review="false_positive">False positive</button>
                              </div>`
                            : ""
                        }
                      </td>
                    </tr>`,
                  )}
                </tbody>
              </table>
            </div>`
          : html`<div class="card empty">Nothing to review. Automod actions from the last 24 hours show up here until someone confirms or undoes them.</div>`,
      );
      for (const button of $$("[data-open]", reviewResults)) button.addEventListener("click", () => openUser(button.dataset.open, loadReview));
      for (const button of $$("[data-review]", reviewResults))
        button.addEventListener("click", async () => {
          const id = button.closest("tr").dataset.id;
          const choice = button.dataset.review;
          const done = await act(
            button,
            () =>
              choice === "confirm"
                ? api(`/admin/automod/actions/${id}/confirm`, { method: "POST" })
                : api(`/admin/automod/actions/${id}/reverse`, { method: "POST", body: { reversal: choice } }),
            choice === "confirm" ? "Confirmed" : choice === "false_positive" ? "Marked as a false positive and lifted" : "Action undone",
          );
          if (done !== undefined) {
            loadReview();
            loadStats();
            loadRules();
            loadLog();
          }
        });
    } catch (error) {
      if (!view.isConnected || error.status === 499 || error.status === 401) return;
      reviewStatus.hidden = false;
      reviewStatus.textContent = `Couldn't load the review queue: ${error.message ?? error}`;
    }
  };
  $("#automod-review-refresh", view).addEventListener("click", loadReview);

  const statsResults = $("#automod-rule-stats-results", view);
  const loadStats = async () => {
    const { rules, pending_appeals } = await api("/admin/automod/stats");
    if (!statsResults.isConnected) return;
    $("#automod-appeal-count", view).textContent = fmtNumber(pending_appeals);
    const used = rules.filter((row) => row.hits);
    mount(
      statsResults,
      used.length
        ? html`<div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Rule</th>
                  <th>Hits</th>
                  <th class="hide-sm">Log only</th>
                  <th class="hide-sm">Dry run</th>
                  <th>Confirmed</th>
                  <th>Undone</th>
                  <th class="hide-sm">False positive</th>
                  <th class="hide-sm">Not a match</th>
                  <th>False positive rate</th>
                </tr>
              </thead>
              <tbody>
                ${used.map(
                  (row) => html`<tr>
                    <td>${ruleLabel(row.rule)}</td>
                    <td class="automod-num">${fmtNumber(row.hits)}</td>
                    <td class="automod-num hide-sm">${fmtNumber(row.logged)}</td>
                    <td class="automod-num hide-sm">${fmtNumber(row.dry_run)}</td>
                    <td class="automod-num">${fmtNumber(row.confirmed)}</td>
                    <td class="automod-num">${fmtNumber(row.undone)}</td>
                    <td class="automod-num hide-sm">${fmtNumber(row.false_positive)}</td>
                    <td class="automod-num hide-sm">${fmtNumber(row.not_a_match)}</td>
                    <td class="automod-num">${row.false_positive_rate === null ? html`<span class="muted">Not reviewed</span>` : `${Math.round(row.false_positive_rate * 1000) / 10}%`}</td>
                  </tr>`,
                )}
              </tbody>
            </table>
          </div>`
        : html`<div class="card empty">No rule has fired in the last 30 days.</div>`,
    );
  };

  const rulesResults = $("#automod-rules-results", view);
  const rulesStatus = $("#automod-rules-status", view);
  let ruleRows = [];
  const ruleState = (rule) =>
    !rule.enabled
      ? html`<span class="badge">Off</span>`
      : rule.policy.dryRun
        ? html`<span class="badge info">Dry run</span>`
        : html`<span class="badge ok">On</span>`;
  const ruleAction = (rule) =>
    rule.actions ? (SPAM_ACTIONS.find(([key]) => key === rule.action)?.[1] ?? rule.action ?? "Default") : rule.key === "wordLists" ? "Set on each list" : "Built in";
  const exemptionSummary = (rule) => {
    const { policy } = rule;
    const parts = [
      policy.exemptStaff && "staff",
      policy.exemptBots && "bots",
      policy.exemptVerifiedEmail && "verified emails",
      policy.exemptAccountAgeDays > 0 && `accounts over ${fmtNumber(policy.exemptAccountAgeDays)} days old`,
      policy.exemptUserIds.length && plural(policy.exemptUserIds.length, "user"),
      policy.exemptGuildIds.length && plural(policy.exemptGuildIds.length, "server"),
    ].filter(Boolean);
    return parts.length ? `Skips ${parts.join(", ")}` : "Skips nobody";
  };
  const syncRuleForms = (rule) => {
    const spamKey = POLICY_RULES[rule.key]?.[1];
    const holder = spamKey
      ? $(`[data-spam-rule="${spamKey}"]`, view)
      : { scamLink: $("#automod-scam", view), slurs: $("#automod-slurs", view), quarantine: $("#automod-quarantine", view), signupBot: $("#automod-signup-scoring", view) }[rule.key];
    const switchName = { verificationLevel: "enforce", explicitContent: "explicitEnabled" }[rule.key];
    const target = switchName ? $("#automod-servers", view) : holder;
    const box = target && $(`input[name="${switchName ?? "enabled"}"]`, target);
    if (box) box.checked = rule.enabled;
    const select = holder && rule.action && $("select[name=action]", holder);
    if (select) select.value = rule.action;
  };
  const showCatches = (rule) => {
    Object.assign(automodState.log, { rule: rule.log_rules[0], days: 7, dryRun: "", action: "", reversed: "", offset: 0 });
    $("#automod-rule", view).value = automodState.log.rule;
    $("#automod-dry-run", view).value = "";
    $("#automod-action", view).value = "";
    $("#automod-reversed", view).value = "";
    loadLog();
    $("#automod-log", view).scrollIntoView({ block: "start" });
  };
  const openRule = (rule) => {
    const { policy } = rule;
    const shows = (kind) => rule.exemptions.includes(kind);
    const editable = access.manage_users;
    const body = openDrawer(
      POLICY_RULES[rule.key]?.[0] ?? rule.key,
      html`<form class="stack" id="rule-form">
        <p class="muted">
          Caught ${plural(rule.counts.hits, "time")} in the last 7 days${rule.counts.dry_run ? `, ${fmtNumber(rule.counts.dry_run)} of them in dry run` : ""}.
          ${fmtNumber(rule.counts.false_positives)} undone or marked as false positives and ${fmtNumber(rule.counts.confirmed)} confirmed.
        </p>
        ${toggle("enabled", rule.enabled, "Run this rule")}
        ${toggle("dryRun", policy.dryRun, "Dry run", "Logs what the rule would have done, marked as a dry run, and acts on nobody.")}
        ${rule.actions
          ? html`<label
              >When it trips<select name="action">
                ${options(SPAM_ACTIONS.filter(([key]) => rule.actions.includes(key)), rule.action)}
              </select></label
            >`
          : ""}
        ${rule.exemptions.length
          ? html`<h3>Skip</h3>
              <div class="stack">
                ${shows("staff") ? toggle("exemptStaff", policy.exemptStaff, "Skip staff", "Accounts with a staff role or the operator right.") : ""}
                ${shows("bots") ? toggle("exemptBots", policy.exemptBots, "Skip bots") : ""}
                ${shows("verified") ? toggle("exemptVerifiedEmail", policy.exemptVerifiedEmail, "Skip accounts with a verified email", "Accounts from other instances never count as verified here.") : ""}
              </div>
              <div class="form-grid">
                ${shows("age") ? number("exemptAccountAgeDays", policy.exemptAccountAgeDays, "Skip accounts older than", "Days. 0 checks every account.", 0, 3650) : ""}
                ${shows("users")
                  ? html`<label class="span"
                      >Users to skip<span class="hint">User IDs, one per line, up to 500.</span
                      ><textarea name="exemptUserIds" rows="3" inputmode="numeric">${policy.exemptUserIds.join("\n")}</textarea>
                    </label>`
                  : ""}
                ${shows("servers")
                  ? html`<label class="span"
                      >Servers to skip<span class="hint">Server IDs, one per line, up to 500.</span
                      ><textarea name="exemptGuildIds" rows="3" inputmode="numeric">${policy.exemptGuildIds.join("\n")}</textarea>
                    </label>`
                  : ""}
              </div>`
          : html`<p class="muted">This rule runs before there is an account to skip, so it has no exemptions.</p>`}
        <div class="form-actions">
          ${rule.counts.hits ? html`<button class="btn" type="button" id="rule-catches">See catches</button>` : ""}
          ${editable ? html`<button class="btn primary" type="submit">Save rule</button>` : ""}
        </div>
      </form>`,
    );
    if (!body) return;
    const form = $("#rule-form", body);
    if (!editable) for (const control of $$("input, select, textarea", form)) control.disabled = true;
    $("#rule-catches", body)?.addEventListener("click", () => {
      closeDrawer({ discard: true });
      showCatches(rule);
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const elements = form.elements;
      const patch = {
        enabled: elements.enabled.checked,
        dryRun: elements.dryRun.checked,
        ...(elements.action ? { action: elements.action.value } : {}),
        ...(elements.exemptStaff ? { exemptStaff: elements.exemptStaff.checked } : {}),
        ...(elements.exemptBots ? { exemptBots: elements.exemptBots.checked } : {}),
        ...(elements.exemptVerifiedEmail ? { exemptVerifiedEmail: elements.exemptVerifiedEmail.checked } : {}),
        ...(elements.exemptAccountAgeDays ? { exemptAccountAgeDays: Number(elements.exemptAccountAgeDays.value) || 0 } : {}),
        ...(elements.exemptUserIds ? { exemptUserIds: linesOf(elements.exemptUserIds.value) } : {}),
        ...(elements.exemptGuildIds ? { exemptGuildIds: linesOf(elements.exemptGuildIds.value) } : {}),
      };
      const saved = await act($("button[type=submit]", form), () => api(`/admin/automod/rules/${rule.key}`, { method: "PATCH", body: patch }), "Rule saved");
      if (!saved) return;
      syncRuleForms(saved);
      closeDrawer({ discard: true });
      loadRules();
    });
  };
  const loadRules = async () => {
    try {
      const { rules } = await api("/admin/automod/rules?days=7");
      if (!rulesResults.isConnected) return;
      ruleRows = rules;
      rulesStatus.hidden = true;
      mount(
        rulesResults,
        html`<div class="table-wrap">
          <table class="automod-rules">
            <thead>
              <tr>
                <th>Rule</th>
                <th>State</th>
                <th class="hide-sm">When it trips</th>
                <th>Caught</th>
                <th class="hide-sm">Dry run</th>
                <th class="hide-sm">False positives</th>
                <th><span class="visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              ${rules.map(
                (rule) => html`<tr data-rule="${rule.key}">
                  <td>${POLICY_RULES[rule.key]?.[0] ?? rule.key}<span class="muted automod-sub">${exemptionSummary(rule)}</span></td>
                  <td>${ruleState(rule)}</td>
                  <td class="hide-sm">${ruleAction(rule)}</td>
                  <td class="automod-num">${fmtNumber(rule.counts.hits)}<span class="automod-mobile-label"> caught in 7 days</span></td>
                  <td class="automod-num hide-sm">${fmtNumber(rule.counts.dry_run)}</td>
                  <td class="automod-num hide-sm">${fmtNumber(rule.counts.false_positives)}</td>
                  <td>
                    <div class="row automod-row-actions">
                      <button class="btn small" type="button" data-rule-edit>${access.manage_users ? "Edit" : "View"}</button>
                      ${rule.counts.hits ? html`<button class="btn small ghost" type="button" data-rule-catches>See catches</button>` : ""}
                    </div>
                  </td>
                </tr>`,
              )}
            </tbody>
          </table>
        </div>`,
      );
      for (const button of $$("[data-rule-edit]", rulesResults))
        button.addEventListener("click", () => openRule(ruleRows.find((rule) => rule.key === button.closest("tr").dataset.rule)));
      for (const button of $$("[data-rule-catches]", rulesResults))
        button.addEventListener("click", () => showCatches(ruleRows.find((rule) => rule.key === button.closest("tr").dataset.rule)));
    } catch (error) {
      if (!view.isConnected || error.status === 499 || error.status === 401) return;
      rulesStatus.hidden = false;
      rulesStatus.textContent = `Couldn't load the rules: ${error.message ?? error}`;
    }
  };
  $("#automod-rules-refresh", view).addEventListener("click", loadRules);

  const appealResults = $("#automod-appeals-results", view);
  const appealStatus = $("#automod-appeals-status", view);
  const appealTabs = $("#automod-appeal-tabs", view);
  const loadAppeals = async () => {
    const st = automodState.appeals;
    mount(
      appealTabs,
      APPEAL_STATUSES.map(
        ([key, label]) =>
          html`<button class="btn small ${st.status === key ? "primary" : ""}" type="button" data-appeal-status="${key}" aria-pressed="${st.status === key}">${label}</button>`,
      ),
    );
    for (const button of $$("[data-appeal-status]", appealTabs))
      button.addEventListener("click", () => {
        st.status = button.dataset.appealStatus;
        st.offset = 0;
        loadAppeals();
      });
    try {
      const { appeals, total } = await api(`/admin/automod/appeals?${new URLSearchParams({ status: st.status, limit: st.limit, offset: st.offset })}`);
      if (!appealResults.isConnected) return;
      appealStatus.hidden = true;
      mount(
        appealResults,
        appeals.length
          ? html`<div class="table-wrap">
                <table class="automod-appeals">
                  <thead>
                    <tr>
                      <th>Sent</th>
                      <th>Account</th>
                      <th>Restriction</th>
                      <th>Their message</th>
                      <th><span class="visually-hidden">Decision</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    ${appeals.map(
                      (appeal) => html`<tr data-id="${appeal.id}">
                        <td>${fmtDate(appeal.created_at)}</td>
                        <td>
                          ${appeal.user
                            ? html`<button class="link-button ident" type="button" data-open="${appeal.user_id}">${avatar(appeal.user)}<span><strong>${userName(appeal.user)}</strong><span class="muted">${userTag(appeal.user)}</span></span></button>`
                            : html`<span class="muted">${appeal.username ? `@${appeal.username}` : appeal.user_id}</span>`}
                        </td>
                        <td>
                          <span class="badge ${appeal.restriction === "held" ? "warn" : "danger"}">${RESTRICTIONS[appeal.restriction] ?? appeal.restriction}</span>
                          ${appeal.status === "pending" && !appeal.still_restricted ? html`<span class="badge ok automod-sub">Already lifted</span>` : ""}
                          <span class="muted automod-sub">${appeal.reason}</span>
                        </td>
                        <td><p class="automod-appeal-message">${appeal.message}</p></td>
                        <td>
                          ${appeal.status !== "pending"
                            ? html`<span class="badge ${appeal.status === "accepted" ? "ok" : ""}">${appeal.status === "accepted" ? "Accepted" : "Denied"}</span>${appeal.resolved_by ? html`<span class="muted automod-sub">by ${userName(appeal.resolved_by)}, ${fmtDate(appeal.resolved_at)}</span>` : ""}`
                            : access.moderate
                              ? html`<div class="row automod-row-actions">
                                  <button class="btn small primary" type="button" data-appeal-decision="accept">Accept and lift</button>
                                  <button class="btn small" type="button" data-appeal-decision="deny">Deny</button>
                                </div>`
                              : html`<span class="badge warn">Waiting</span>`}
                        </td>
                      </tr>`,
                    )}
                  </tbody>
                </table>
              </div>
              ${pager(total, st)}`
          : html`<div class="card empty">
              ${st.status === "pending" ? "No appeals are waiting. Accounts that can't sign in can send one from the appeal page." : "No appeals here."}
            </div>`,
      );
      for (const button of $$("[data-open]", appealResults)) button.addEventListener("click", () => openUser(button.dataset.open, loadAppeals));
      for (const button of $$("[data-appeal-decision]", appealResults))
        button.addEventListener("click", async () => {
          const decision = button.dataset.appealDecision;
          const done = await act(
            button,
            () => api(`/admin/automod/appeals/${button.closest("tr").dataset.id}`, { method: "POST", body: { decision } }),
            decision === "accept" ? "Appeal accepted and restriction lifted" : "Appeal denied",
          );
          if (done === undefined) return;
          loadAppeals();
          loadStats();
          loadRules();
          loadLog();
        });
      bindPager(appealResults, total, st, loadAppeals);
    } catch (error) {
      if (!view.isConnected || error.status === 499 || error.status === 401) return;
      appealStatus.hidden = false;
      appealStatus.textContent = `Couldn't load appeals: ${error.message ?? error}`;
    }
  };
  $("#automod-appeals-refresh", view).addEventListener("click", loadAppeals);

  $("#automod-raid-settings", view).addEventListener("submit", (event) => {
    event.preventDefault();
    save(event.currentTarget, { raids: values(event.currentTarget) }, "Raid detection saved");
  });
  $("#automod-allow", view).addEventListener("submit", (event) => {
    event.preventDefault();
    save(event.currentTarget, { allowList: linesOf(event.currentTarget.elements.allowList.value) }, "Allow list saved");
  });
  $("#automod-names", view).addEventListener("submit", (event) => {
    event.preventDefault();
    save(
      event.currentTarget,
      { identityBlockedTerms: linesOf(event.currentTarget.elements.identityBlockedTerms.value) },
      "Blocked name words saved",
    );
  });

  const editor = $("#automod-list-editor", view);
  let lists = s.wordLists.map((list) => ({ ...list }));
  const listCard = (list, index) => html`
    <fieldset class="automod-list" data-index="${index}">
      <legend>${list.name || "New word list"}</legend>
      <div class="form-grid">
        <label>Name<input data-field="name" value="${list.name}" maxlength="64" required placeholder="Spam phrases" /></label>
        <label
          >When a word matches<select data-field="action">
            ${options(AUTOMOD_LIST_ACTIONS, list.action)}
          </select></label
        >
        <label ${list.action === "suspend" ? "" : raw("hidden")} data-suspend
          >Suspension length<span class="hint">Days</span
          ><input data-field="suspendDays" type="number" min="1" max="365" step="1" value="${list.suspendDays ?? 7}"
        /></label>
        <label class="span"
          >Words<span class="hint">One per line, up to 500.</span
          ><textarea data-field="terms" rows="4">${list.terms.join("\n")}</textarea>
        </label>
      </div>
      ${access.manage_users ? html`<div class="row"><button class="btn small ghost" type="button" data-remove>Remove this list</button></div>` : ""}
    </fieldset>
  `;
  const readLists = () =>
    $$(".automod-list", editor).map((fieldset, index) => ({
      ...(lists[index]?.id ? { id: lists[index].id } : {}),
      name: $("[data-field=name]", fieldset).value.trim(),
      action: $("[data-field=action]", fieldset).value,
      suspendDays: Number($("[data-field=suspendDays]", fieldset).value) || 7,
      terms: linesOf($("[data-field=terms]", fieldset).value),
    }));
  const drawLists = () => {
    mount(
      editor,
      lists.length
        ? lists.map(listCard)
        : html`<p class="muted">No word lists yet. Add one to stop extra words or phrases.</p>`,
    );
    for (const fieldset of $$(".automod-list", editor)) {
      $("[data-field=action]", fieldset).addEventListener("change", (event) => {
        $("[data-suspend]", fieldset).hidden = event.target.value !== "suspend";
      });
      $("[data-remove]", fieldset)?.addEventListener("click", () => {
        lists = readLists();
        lists.splice(Number(fieldset.dataset.index), 1);
        $("#automod-lists").dataset.dirty = "true";
        drawLists();
      });
    }
  };
  drawLists();
  if (!access.manage_users)
    for (const form of $$("form.card", view)) {
      for (const button of $$(".form-actions button, #automod-list-add", form)) button.hidden = true;
      for (const control of $$("input, select, textarea", form))
        if (!control.closest("#automod-quarantine-results") && control.id !== "automod-ip-lookup") control.disabled = true;
    }
  $("#automod-list-add", view).addEventListener("click", () => {
    lists = [...readLists(), { name: "", action: "delete", suspendDays: 7, terms: [] }];
    drawLists();
    $$(".automod-list [data-field=name]", editor).at(-1)?.focus();
  });
  $("#automod-lists", view).addEventListener("submit", async (event) => {
    event.preventDefault();
    const saved = await save(event.currentTarget, { wordLists: readLists() }, "Word lists saved");
    if (saved) {
      lists = saved.wordLists.map((list) => ({ ...list }));
      drawLists();
    }
  });

  $("#automod-test-run", view).addEventListener("click", async () => {
    const text = $("#automod-test-text", view).value;
    const extra = Object.fromEntries(
      [
        ["email", "#automod-test-email"],
        ["username", "#automod-test-username"],
        ["ip", "#automod-test-ip"],
      ]
        .map(([key, selector]) => [key, $(selector, view).value.trim()])
        .filter(([, value]) => value),
    );
    const target = $("#automod-test-result", view);
    if (!text.trim() && !Object.keys(extra).length) {
      target.textContent = "Type or paste some text to check.";
      return;
    }
    const result = await act($("#automod-test-run", view), () => api("/admin/automod/test", { method: "POST", body: { text, ...extra } }));
    if (!result) return;
    const ruleText = (match) =>
      match.rule === "word" && match.list ? `the "${match.list.name}" word list (${match.term})` : ruleLabel(match.rule);
    mount(
      target,
      html`
        <p>
          ${result.message
            ? html`<span class="badge danger">Message would be stopped</span> by ${ruleText(result.message)}. Automod would
                ${result.message.action}.`
            : html`<span class="badge ok">Messages pass</span> No message rule matches.`}
        </p>
        <p>
          ${result.name
            ? html`<span class="badge warn">Name would be refused</span> by ${ruleText(result.name)}.`
            : html`<span class="badge ok">Names pass</span> No name rule matches.`}
        </p>
        ${result.message || result.name ? html`<p class="muted">Logged as: ${result.excerpt}</p>` : ""}
        <p>
          ${!result.scam.enabled
            ? html`<span class="badge">Scam links off</span>`
            : result.scam.older_account
              ? html`<span class="badge danger">Scam link</span> ${SCAM_KINDS[result.scam.older_account.kind] ?? result.scam.older_account.kind}: ${result.scam.older_account.reason}`
              : result.scam.new_account
                ? html`<span class="badge warn">Scam link from new accounts</span> ${SCAM_KINDS[result.scam.new_account.kind] ?? result.scam.new_account.kind}: ${result.scam.new_account.reason}`
                : html`<span class="badge ok">Links pass</span> No scam rule matches.`}
        </p>
        <p>
          ${result.mentions.over_limit || result.mentions.everyone
            ? html`<span class="badge warn">Mentions</span> ${fmtNumber(result.mentions.count)} mentions${result.mentions.everyone ? " and @everyone or @here" : ""}, the one message limit is ${fmtNumber(result.mentions.limit)}.`
            : html`<span class="badge ok">Mentions pass</span> ${fmtNumber(result.mentions.count)} mentions.`}
        </p>
        <p>
          ${result.quarantine.blocks
            ? html`<span class="badge warn">${result.quarantine.enabled ? "Quarantine blocks it" : "Quarantine would block it"}</span> New accounts can't send ${QUARANTINE_REASONS[result.quarantine.blocks] ?? result.quarantine.blocks} for ${fmtNumber(result.quarantine.hours)} hours${result.quarantine.enabled ? "" : ", once quarantine is on"}.`
            : html`<span class="badge ok">Quarantine passes</span> New accounts can send this.`}
        </p>
        ${result.explicit_file_name ? html`<p><span class="badge warn">Explicit file name</span> A file with this name would be marked explicit.</p>` : ""}
        ${result.email
          ? html`<p>
              ${result.email.denied
                ? html`<span class="badge danger">Email refused</span> ${result.email.domain} is on the refuse list.`
                : result.email.disposable
                  ? html`<span class="badge warn">Disposable email</span> ${result.email.domain} adds ${fmtNumber(s.signup.disposableEmailWeight)} points.`
                  : html`<span class="badge ok">Email passes</span> ${result.email.domain ?? "No domain"}.`}
            </p>`
          : ""}
        ${result.username
          ? html`<p>
              ${result.username.similar_recent_signups >= result.username.limit
                ? html`<span class="badge warn">Similar usernames</span>`
                : html`<span class="badge ok">Username passes</span>`}
              ${fmtNumber(result.username.similar_recent_signups)} similar signups recently, it counts from ${fmtNumber(result.username.limit)}.
            </p>`
          : ""}
        ${result.ip
          ? html`<p>
              ${result.ip.error
                ? html`<span class="badge warn">Address</span> That isn't an IP address.`
                : result.ip.exempt
                  ? html`<span class="badge ok">Exempt address</span> ${result.ip.group} skips the accounts per address caps.`
                  : html`<span class="badge">Address</span> Counted as ${result.ip.group}.`}
            </p>`
          : ""}
      `,
    );
  });

  const logResults = $("#automod-log-results", view);
  const logRequests = latestList(view, logResults, $("#automod-log-status", view));
  const loadLog = async () => {
    const st = automodState.log;
    const params = new URLSearchParams({ limit: st.limit, offset: st.offset });
    if (st.rule) params.set("rule", st.rule);
    if (st.action) params.set("action", st.action);
    if (st.reversed) params.set("reversed", st.reversed);
    if (st.user) params.set("user_id", st.user);
    if (st.dryRun) params.set("dry_run", st.dryRun);
    if (st.days) params.set("days", st.days);
    await logRequests.load(
      `/admin/automod/actions?${params}`,
      ({ actions, total }) => {
        mount(
          logResults,
          actions.length
            ? html`
                <div class="table-wrap">
                  <table class="automod-log">
                    <thead>
                      <tr>
                        <th>When</th>
                        <th>User</th>
                        <th>Rule</th>
                        <th class="hide-sm">Where</th>
                        <th>Action</th>
                        <th class="hide-sm">Excerpt</th>
                        <th><span class="visually-hidden">Actions</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      ${actions.map(
                        (entry) => html`
                          <tr data-id="${entry.id}" class="${entry.reversed ? "automod-reversed" : ""}">
                            <td>${fmtDate(entry.created_at)}</td>
                            <td>
                              ${entry.user
                                ? html`<div class="ident">${avatar(entry.user)}<div><strong>${userName(entry.user)}</strong><span class="muted">${userTag(entry.user)}</span></div></div>`
                                : html`<span class="muted">${entry.username ? `@${entry.username}` : "No account"}</span>`}
                            </td>
                            <td>
                              ${ruleLabel(entry.rule)}${entry.list_name ? html`<span class="muted automod-sub">${entry.list_name}</span>` : ""}
                              <span class="muted automod-sub">${AUTOMOD_SOURCES[entry.source] ?? entry.source}</span>
                            </td>
                            <td class="hide-sm">${automodWhere(entry)}</td>
                            <td>
                              ${automodActionBadge(entry)}
                              ${entry.reversed
                                ? html`<span class="badge ok automod-sub">${{ not_a_match: "Not a match", false_positive: "False positive" }[entry.reversal] ?? "Undone"}</span>`
                                : entry.confirmed_at
                                  ? html`<span class="badge automod-sub">Confirmed</span>`
                                  : ""}
                            </td>
                            <td class="hide-sm automod-excerpt">${entry.excerpt || html`<span class="muted">None</span>`}</td>
                            <td>
                              <div class="row automod-row-actions">
                                ${entry.user_id ? html`<button class="btn small" type="button" data-open="${entry.user_id}">Open user</button>` : ""}
                                ${entry.reversed || !access.moderate
                                  ? ""
                                  : entry.confirmed_at
                                    ? ""
                                    : html`${["block", "log", "ban", "flag"].includes(entry.action) || !entry.user_id ? "" : html`<button class="btn small" type="button" data-reverse="undo">Undo</button>`}
                                      <button class="btn small ghost" type="button" data-reverse="false_positive">False positive</button>
                                      ${NO_ALLOW_RULES.has(entry.rule) || RAID_RULES.has(entry.rule) ? "" : html`<button class="btn small ghost" type="button" data-reverse="not_a_match">Not a match</button>`}`}
                              </div>
                            </td>
                          </tr>
                        `,
                      )}
                    </tbody>
                  </table>
                </div>
                ${pager(total, st)}
              `
            : html`<div class="card empty">Nothing here yet. Automod actions show up as soon as they happen.</div>`,
        );
        for (const button of $$("[data-open]", logResults)) button.addEventListener("click", () => openUser(button.dataset.open, loadLog));
        for (const button of $$("[data-reverse]", logResults))
          button.addEventListener("click", async () => {
            const id = button.closest("tr").dataset.id;
            const reversal = button.dataset.reverse;
            const question =
              reversal === "not_a_match"
                ? "Add the matched word to the allow list and lift any suspension this caused? Deleted messages stay deleted."
                : "Lift any suspension this caused and overturn its violation? Deleted messages stay deleted.";
            if (reversal !== "false_positive" && !confirm(question)) return;
            const done = await act(
              button,
              () => api(`/admin/automod/actions/${id}/reverse`, { method: "POST", body: { reversal } }),
              { not_a_match: "Added to the allow list", false_positive: "Marked as a false positive and lifted" }[reversal] ?? "Action undone",
            );
            if (done !== undefined) {
              loadLog();
              loadStats();
              loadRules();
            }
          });
        bindPager(logResults, total, st, loadLog);
      },
      loadLog,
    );
  };
  const filterLog = (key, value) => {
    automodState.log[key] = value;
    automodState.log.offset = 0;
    loadLog();
  };
  $("#automod-rule", view).addEventListener("change", (event) => filterLog("rule", event.target.value));
  $("#automod-action", view).addEventListener("change", (event) => filterLog("action", event.target.value));
  $("#automod-reversed", view).addEventListener("change", (event) => filterLog("reversed", event.target.value));
  $("#automod-dry-run", view).addEventListener("change", (event) => filterLog("dryRun", event.target.value));
  const searchUser = debounce((value) => filterLog("user", value));
  $("#automod-user", view).addEventListener("input", (event) => {
    logRequests.cancel();
    searchUser(event.target.value.trim());
  });

  const joinResults = $("#automod-join-results", view);
  const joinTabs = $("#automod-join-tabs", view);
  const joinButtons = $$("[data-join-action]", view);
  const syncJoinSelection = () => {
    const count = $$("input[data-select]:checked", joinResults).length;
    for (const button of joinButtons) button.disabled = count === 0;
    const selected = $("#automod-join-selected", view);
    if (selected) selected.textContent = count ? `${fmtNumber(count)} selected` : "";
  };
  const loadJoin = async () => {
    const st = automodState.join;
    mount(
      joinTabs,
      JOIN_STATUSES.map(
        ([key, label]) =>
          html`<button class="btn small ${st.status === key ? "primary" : ""}" type="button" data-join-status="${key}" aria-pressed="${st.status === key}">${label}</button>`,
      ),
    );
    for (const button of $$("[data-join-status]", joinTabs))
      button.addEventListener("click", () => {
        st.status = button.dataset.joinStatus;
        st.offset = 0;
        loadJoin();
      });
    const { users, total } = await api(`/admin/automod/join-requests?${new URLSearchParams({ status: st.status, limit: st.limit, offset: st.offset })}`);
    if (!joinResults.isConnected) return;
    mount(
      joinResults,
      users.length
        ? html`
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    ${access.moderate ? html`<th><input type="checkbox" data-select-all aria-label="Select every account on this page" /></th>` : ""}
                    <th>Account</th>
                    <th>Why they want to join</th>
                    <th class="hide-sm">Signed up</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  ${users.map(
                    (u) => html`
                      <tr data-id="${u.id}">
                        ${access.moderate ? html`<td><input type="checkbox" data-select="${u.id}" aria-label="Select ${userName(u)}" /></td>` : ""}
                        <td><button class="link-button ident" type="button" data-open="${u.id}">${avatar(u)}<span><strong>${userName(u)}</strong><span class="muted">${userTag(u)}</span></span></button></td>
                        <td class="automod-reason">
                          ${u.join_reason ? html`<p>${u.join_reason}</p>` : html`<span class="muted">No reason given</span>`}
                          ${u.signals.length ? html`<div class="badges">${u.signals.map((signal) => html`<span class="badge warn">${signal.label}</span>`)}</div>` : ""}
                        </td>
                        <td class="hide-sm">${fmtDate(u.created_at)}</td>
                        <td>
                          <span class="badge ${u.join_status === "pending" ? "warn" : u.join_status === "rejected" ? "danger" : u.join_status === "approved" ? "ok" : ""}"
                            >${u.join_status === "pending" ? "Waiting" : u.join_status === "rejected" ? "Rejected" : u.join_status === "approved" ? "Approved" : "Active"}</span
                          >
                        </td>
                      </tr>
                    `,
                  )}
                </tbody>
              </table>
            </div>
            ${pager(total, st)}
          `
        : html`<div class="card empty">${st.status === "pending" ? "Nobody is waiting for approval." : "No accounts here."}</div>`,
    );
    $("[data-select-all]", joinResults)?.addEventListener("change", (event) => {
      for (const box of $$("input[data-select]", joinResults)) box.checked = event.target.checked;
      syncJoinSelection();
    });
    for (const box of $$("input[data-select]", joinResults)) box.addEventListener("change", syncJoinSelection);
    for (const button of $$("[data-open]", joinResults)) button.addEventListener("click", () => openUser(button.dataset.open, loadJoin));
    bindPager(joinResults, total, st, loadJoin);
    syncJoinSelection();
  };
  for (const button of joinButtons)
    button.addEventListener("click", async () => {
      const user_ids = $$("input[data-select]:checked", joinResults).map((box) => box.dataset.select);
      const action = button.dataset.joinAction;
      if (action === "reject" && !confirm(`Reject ${user_ids.length} ${user_ids.length === 1 ? "account" : "accounts"}? They won't be able to sign in.`)) return;
      const done = await act(
        button,
        () => api("/admin/automod/join-requests", { method: "POST", body: { user_ids, action } }),
        action === "approve" ? "Accounts approved" : "Accounts rejected",
      );
      if (done) loadJoin();
    });

  const nameResults = $("#automod-name-results", view);
  const nameStatus = $("#automod-name-status", view);
  const disableButton = $("#automod-name-disable", view);
  const scanButton = $("#automod-name-scan-run", view);
  const syncNameSelection = () => {
    disableButton.disabled = !$$("input[data-name-select]:checked", nameResults).length;
  };
  const drawNames = () => {
    const st = automodState.names;
    mount(
      nameResults,
      st.users.length
        ? html`<div class="table-wrap">
            <table>
              <thead>
                <tr>
                  ${access.moderate ? html`<th><span class="visually-hidden">Select</span></th>` : ""}
                  <th>Account</th>
                  <th>Matched</th>
                  <th class="hide-sm">Joined</th>
                </tr>
              </thead>
              <tbody>
                ${st.users.map(
                  (u) => html`<tr>
                    ${access.moderate ? html`<td><input type="checkbox" data-name-select="${u.id}" ${u.disabled ? raw("disabled") : ""} aria-label="Select ${u.username}" /></td>` : ""}
                    <td><button class="link-button ident" type="button" data-open="${u.id}">${avatar(u)}<span><strong>${userName(u)}</strong><span class="muted">${userTag(u)}</span></span></button>${u.disabled ? html` <span class="badge danger">Disabled</span>` : ""}</td>
                    <td>${u.field === "username" ? "Username" : "Display name"} · ${u.rule === "word" && u.list ? u.list.name : ruleLabel(u.rule)}</td>
                    <td class="hide-sm">${fmtDay(u.created_at)}</td>
                  </tr>`,
                )}
              </tbody>
            </table>
          </div>`
        : st.scanned
          ? html`<div class="card empty">No names break the rules.</div>`
          : "",
    );
    for (const box of $$("input[data-name-select]", nameResults)) box.addEventListener("change", syncNameSelection);
    for (const button of $$("[data-open]", nameResults)) button.addEventListener("click", () => openUser(button.dataset.open));
    nameStatus.textContent = st.scanned ? `${fmtNumber(st.scanned)} accounts scanned${st.done ? "" : ", more to go"}` : "";
    scanButton.textContent = st.scanned && !st.done ? "Scan more" : st.scanned ? "Scan again" : "Scan accounts";
    syncNameSelection();
  };
  scanButton.addEventListener("click", async () => {
    const st = automodState.names;
    if (st.done) Object.assign(st, { after: null, users: [], scanned: 0, done: false });
    const result = await act(scanButton, () => api(`/admin/automod/names${st.after ? `?after=${st.after}` : ""}`));
    if (!result) return;
    st.users.push(...result.users.filter((u) => !st.users.some((known) => known.id === u.id)));
    st.scanned += result.scanned;
    st.after = result.next;
    st.done = !result.next;
    drawNames();
  });
  disableButton.addEventListener("click", async () => {
    const user_ids = $$("input[data-name-select]:checked", nameResults).map((box) => box.dataset.nameSelect);
    if (!confirm(`Disable ${user_ids.length} ${user_ids.length === 1 ? "account" : "accounts"} and sign them out everywhere?`)) return;
    const result = await act(disableButton, () => api("/admin/automod/names/disable", { method: "POST", body: { user_ids } }), "Accounts disabled");
    if (!result) return;
    for (const u of automodState.names.users) if (result.disabled.includes(u.id)) u.disabled = true;
    drawNames();
  });
  drawNames();

  const plural = (count, word, many = `${word}s`) => `${fmtNumber(count)} ${count === 1 ? word : many}`;
  const incidentWhere = (incident) =>
    incident.guild
      ? html`<span>${incident.guild.name ?? "Deleted server"}</span>`
      : html`<span class="muted">${incident.kind === "dm_raid" ? "Direct messages" : "Across the instance"}</span>`;
  const incidentState = (incident) =>
    incident.live
      ? html`<span class="badge warn">Live</span>`
      : incident.ended_at
        ? html`<span class="badge ok">Ended</span>`
        : html`<span class="badge">Quiet</span>`;
  const accountState = (u) =>
    u?.disabled
      ? html`<span class="badge danger">Disabled</span>`
      : u?.suspended_until && new Date(u.suspended_until) > new Date()
        ? html`<span class="badge danger">Suspended</span><span class="muted automod-sub">until ${fmtDate(u.suspended_until)}</span>`
        : html`<span class="badge">Active</span>`;
  const incidentTable = (incidents) => html`
    <div class="table-wrap">
      <table class="automod-incidents">
        <thead>
          <tr>
            <th>Incident</th>
            <th class="hide-sm">Where</th>
            <th>Accounts</th>
            <th class="hide-sm">Last event</th>
            <th>State</th>
            <th><span class="visually-hidden">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          ${incidents.map(
            (incident) => html`
              <tr>
                <td>
                  <strong>${ruleLabel(incident.kind)}</strong>
                  <span class="muted automod-sub">started ${fmtDate(incident.started_at)}</span>
                </td>
                <td class="hide-sm">${incidentWhere(incident)}</td>
                <td class="automod-num">
                  ${fmtNumber(incident.user_count)}
                  <span class="muted automod-sub">${plural(incident.event_count, "event")}${incident.deleted_messages ? `, ${plural(incident.deleted_messages, "message")} deleted` : ""}</span>
                </td>
                <td class="hide-sm">${fmtDate(incident.last_event_at)}</td>
                <td>${incidentState(incident)}${incident.actions.length ? html`<span class="muted automod-sub">${plural(incident.actions.length, "staff action")}</span>` : ""}</td>
                <td><button class="btn small" type="button" data-incident="${incident.id}">Open incident</button></td>
              </tr>
            `,
          )}
        </tbody>
      </table>
    </div>
  `;

  const raidState = automodState.raids;
  const raidLive = $("#automod-raids-live", view);
  const raidRecent = $("#automod-raids-recent", view);
  const raidOffenders = $("#automod-raids-offenders", view);
  const raidStatus = $("#automod-raids-status", view);
  let raidLoading = false;
  const loadRaids = async () => {
    if (raidLoading) return;
    raidLoading = true;
    try {
      const data = await api(`/admin/automod/raids?${new URLSearchParams({ limit: raidState.limit, offset: raidState.offset })}`);
      if (!view.isConnected) return;
      raidStatus.hidden = true;
      $("#automod-live-count", view).textContent = fmtNumber(data.live.length);
      mount(
        raidLive,
        data.live.length
          ? incidentTable(data.live)
          : html`<div class="card empty">No raids or spam waves right now. Incidents show up here as soon as automod groups two or more events.</div>`,
      );
      mount(
        raidRecent,
        data.recent.incidents.length
          ? html`${incidentTable(data.recent.incidents)}${pager(data.recent.total, raidState)}`
          : html`<div class="card empty">No incidents in the last 7 days.</div>`,
      );
      bindPager(raidRecent, data.recent.total, raidState, loadRaids);
      mount(
        raidOffenders,
        data.offenders.length
          ? html`<div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Times caught</th>
                    <th class="hide-sm">Rules</th>
                    <th class="hide-sm">Last caught</th>
                    <th>State</th>
                  </tr>
                </thead>
                <tbody>
                  ${data.offenders.map(
                    (row) => html`<tr>
                      <td>
                        ${row.user
                          ? html`<button class="link-button ident" type="button" data-open="${row.user_id}">${avatar(row.user)}<span><strong>${userName(row.user)}</strong><span class="muted">${userTag(row.user)}</span></span></button>`
                          : html`<span class="muted">Deleted account</span>`}
                      </td>
                      <td class="automod-num">${fmtNumber(row.count)}<span class="muted automod-sub">${plural(row.incidents, "incident")}</span></td>
                      <td class="hide-sm"><div class="badges">${Object.entries(row.rules).map(([rule, count]) => html`<span class="badge">${ruleLabel(rule)}: ${fmtNumber(count)}</span>`)}</div></td>
                      <td class="hide-sm">${fmtDate(row.last_at)}</td>
                      <td>${accountState(row.user)}</td>
                    </tr>`,
                  )}
                </tbody>
              </table>
            </div>`
          : html`<div class="card empty">Nobody has tripped a spam or raid rule this week.</div>`,
      );
      for (const button of $$("[data-incident]", view)) button.addEventListener("click", () => openIncident(button.dataset.incident));
      for (const button of $$("[data-open]", raidOffenders)) button.addEventListener("click", () => openUser(button.dataset.open, loadRaids));
    } catch (error) {
      if (!view.isConnected || error.status === 499 || error.status === 401) return;
      raidStatus.hidden = false;
      raidStatus.textContent = `Couldn't load incidents: ${error.message ?? error}`;
    } finally {
      raidLoading = false;
    }
  };

  const openIncident = async (id) => {
    const body = openDrawer("Incident", html`<div class="spinner">Loading…</div>`);
    if (!body) return;
    const draw = async () => {
      const incident = await api(`/admin/automod/raids/${id}`);
      if (!body.isConnected) return;
      $("#drawer-title").textContent = `${ruleLabel(incident.kind)} incident`;
      const users = incident.users;
      mount(
        body,
        html`
          <div class="stack">
            <dl class="automod-facts">
              <div><dt>Where</dt><dd>${incidentWhere(incident)}</dd></div>
              <div><dt>State</dt><dd>${incidentState(incident)}</dd></div>
              <div><dt>Started</dt><dd>${fmtDate(incident.started_at)}</dd></div>
              <div><dt>Last event</dt><dd>${fmtDate(incident.last_event_at)}</dd></div>
              <div><dt>Accounts</dt><dd>${fmtNumber(incident.user_count)}</dd></div>
              <div><dt>Events</dt><dd>${fmtNumber(incident.event_count)}</dd></div>
              <div><dt>Messages deleted by automod</dt><dd>${fmtNumber(incident.deleted_messages)}</dd></div>
              ${incident.invite_code ? html`<div><dt>Invite used</dt><dd>${incident.invite_code}</dd></div>` : ""}
            </dl>
            ${incident.actions.length
              ? html`<div>
                  <h3>What staff did</h3>
                  <ul class="automod-history">
                    ${incident.actions.map(
                      (entry) => html`<li>
                        ${INCIDENT_ACTIONS.find(([key]) => key === entry.action)?.[1] ?? entry.action} on ${plural(entry.processed, "account")}${entry.skipped ? `, ${fmtNumber(entry.skipped)} skipped` : ""}${entry.messages_deleted !== undefined ? `, ${plural(entry.messages_deleted, "message")} deleted` : ""}${entry.ips_banned !== undefined ? `, ${plural(entry.ips_banned, "IP address", "IP addresses")} banned` : ""}
                        <span class="muted">${fmtDate(entry.at)}</span>
                      </li>`,
                    )}
                  </ul>
                </div>`
              : ""}
            ${
              access.moderate
                ? html`<div>
              <h3>Act on the accounts</h3>
              <p class="muted">
                Acts on the accounts you select, or on everyone in the incident when none are selected. Your own account
                is always skipped. Accounts from other instances are blocked from federating instead of suspended,
                disabled or IP banned.
              </p>
              <label>Reason<span class="hint">Optional. Shown in the automod log and on suspensions.</span><input id="incident-reason" maxlength="512" placeholder="Raid on ${incident.guild?.name ?? "the instance"}" /></label>
              <div class="row automod-bulk">
                ${INCIDENT_ACTIONS.filter(([key]) => key !== "delete_messages" || access.messages).map(([key, label]) => html`<button class="btn small danger" type="button" data-incident-action="${key}">${label}</button>`)}
                ${incident.ended_at ? "" : html`<button class="btn small ghost" type="button" id="incident-end">End incident</button>`}
              </div>
              <p class="muted" id="incident-target" role="status" aria-live="polite"></p>
            </div>`
                : ""
            }
            ${users.length
              ? html`<div class="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        ${access.moderate ? html`<th><input type="checkbox" data-incident-all aria-label="Select every account in this incident" /></th>` : ""}
                        <th>Account</th>
                        <th class="hide-sm">Created</th>
                        <th>Caught</th>
                        <th>State</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${users.map(
                        (entry) => html`<tr>
                          ${access.moderate ? html`<td><input type="checkbox" data-incident-user="${entry.id}" aria-label="Select ${entry.user ? userName(entry.user) : entry.id}" /></td>` : ""}
                          <td>
                            ${entry.user
                              ? html`<button class="link-button ident" type="button" data-open="${entry.id}">${avatar(entry.user)}<span><strong>${userName(entry.user)}</strong><span class="muted">${userTag(entry.user)}</span></span></button>`
                              : html`<span class="muted">Deleted account ${entry.id}</span>`}
                            ${entry.user?.federated_instance ? html`<span class="muted automod-sub">from ${entry.user.federated_instance}</span>` : ""}
                          </td>
                          <td class="hide-sm">${entry.user ? fmtDate(entry.user.created_at) : ""}</td>
                          <td class="automod-num">${fmtNumber(entry.actions)}</td>
                          <td>${accountState(entry.user)}</td>
                        </tr>`,
                      )}
                    </tbody>
                  </table>
                </div>`
              : html`<div class="card empty">This incident has no accounts. Raid alerts from joins list the accounts that joined.</div>`}
          </div>
        `,
      );
      const selected = () => $$("input[data-incident-user]:checked", body).map((box) => box.dataset.incidentUser);
      const syncTarget = () => {
        const count = selected().length;
        const target = $("#incident-target", body);
        if (target) target.textContent = count
          ? `Buttons act on the ${plural(count, "selected account")}.`
          : `Buttons act on all ${plural(users.length, "account")}.`;
      };
      $("[data-incident-all]", body)?.addEventListener("change", (event) => {
        for (const box of $$("input[data-incident-user]", body)) box.checked = event.target.checked;
        syncTarget();
      });
      for (const box of $$("input[data-incident-user]", body)) box.addEventListener("change", syncTarget);
      for (const button of $$("[data-open]", body)) button.addEventListener("click", () => openUser(button.dataset.open));
      syncTarget();
      for (const button of $$("[data-incident-action]", body))
        button.addEventListener("click", async () => {
          const action = button.dataset.incidentAction;
          const user_ids = selected();
          const count = user_ids.length || users.length;
          const phrase = INCIDENT_ACTIONS.find(([key]) => key === action)[2];
          const warning =
            action === "delete_messages"
              ? " This removes every message they ever sent, in every server and DM, and can't be undone."
              : action === "ban_ip"
                ? " Everyone else on those IP addresses is blocked too, and the accounts are signed out."
                : action === "disable"
                  ? " They are signed out and can't sign in again until an admin enables them."
                  : "";
          if (!confirm(`${phrase} ${plural(count, "account")}?${warning}`)) return;
          const reason = $("#incident-reason", body).value.trim();
          const result = await act(button, () =>
            api(`/admin/automod/raids/${id}/action`, { method: "POST", body: { action, ...(user_ids.length ? { user_ids } : {}), ...(reason ? { reason } : {}) } }),
          );
          if (!result) return;
          const extra =
            action === "delete_messages"
              ? `, ${plural(result.messages_deleted, "message")} deleted`
              : action === "ban_ip"
                ? `, ${fmtNumber(result.ips_banned.length)} IP ${result.ips_banned.length === 1 ? "address" : "addresses"} banned`
                : "";
          toast(`Done for ${plural(result.processed.length, "account")}${result.skipped.length ? `, ${fmtNumber(result.skipped.length)} skipped` : ""}${extra}`);
          await draw();
          loadRaids();
        });
      $("#incident-end", body)?.addEventListener("click", async (event) => {
        const done = await act(event.currentTarget, () => api(`/admin/automod/raids/${id}/end`, { method: "POST" }), "Incident ended");
        if (!done) return;
        await draw();
        loadRaids();
      });
    };
    try {
      await draw();
    } catch (error) {
      if (body.isConnected) mount(body, html`<div class="card empty">Couldn't load this incident: ${error.message ?? error}</div>`);
    }
  };

  $("#automod-raids-refresh", view).addEventListener("click", loadRaids);
  const raidTimer = setInterval(() => {
    if (!view.isConnected) {
      clearInterval(raidTimer);
      return;
    }
    if (!document.hidden) loadRaids();
  }, 15000);

  await Promise.all([loadLog(), loadJoin(), loadRaids(), loadReview(), loadStats(), loadQuarantine(), loadRules(), loadAppeals()]);
}

TABS.automod = renderAutomod;
