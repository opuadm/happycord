"use strict";

const AUTOMOD_RULES = [
  ["hard_r", "Slur (hard R)"],
  ["soft_a", "Slur (soft A)"],
  ["word", "Word list"],
  ["name_blocklist", "Blocked name word"],
  ["ip_limit", "Per-IP signup limit"],
];
const AUTOMOD_ACTIONS = [
  ["suspend", "Suspended"],
  ["delete", "Message deleted"],
  ["block", "Blocked"],
];
const AUTOMOD_LIST_ACTIONS = [
  ["delete", "Delete the message"],
  ["suspend", "Delete the message and suspend the account"],
  ["name", "Block names only"],
];
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
};
const JOIN_STATUSES = [
  ["pending", "Waiting"],
  ["low_effort", "Looks low effort"],
  ["approved", "Approved"],
  ["rejected", "Rejected"],
  ["all", "All"],
];

const automodState = {
  log: { rule: "", action: "", user: "", reversed: "", offset: 0, limit: 25 },
  join: { status: "pending", offset: 0, limit: 25 },
  names: { after: null, users: [], scanned: 0, done: false },
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
  const label = AUTOMOD_ACTIONS.find(([key]) => key === entry.action)?.[1] ?? entry.action;
  const kind = entry.action === "suspend" ? "danger" : entry.action === "delete" ? "warn" : "info";
  return html`<span class="badge ${kind}">${label}</span>${
    entry.action === "suspend" && entry.suspended_until
      ? html`<span class="muted automod-sub">until ${fmtDate(entry.suspended_until)}</span>`
      : ""
  }${entry.deleted_messages ? html`<span class="muted automod-sub">${fmtNumber(entry.deleted_messages)} messages wiped</span>` : ""}`;
};

async function renderAutomod(view) {
  const overview = await api("/admin/automod");
  const s = overview.settings;
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
        <a class="btn small ghost" href="#automod-log" data-jump>Log</a>
        <a class="btn small ghost" href="#automod-join" data-jump>Join requests</a>
        <a class="btn small ghost" href="#automod-test" data-jump>Test text</a>
        <a class="btn small ghost" href="#automod-slurs" data-jump>Slur auto-ban</a>
        <a class="btn small ghost" href="#automod-lists" data-jump>Word lists</a>
        <a class="btn small ghost" href="#automod-names" data-jump>Names</a>
        <a class="btn small ghost" href="#automod-registration" data-jump>Signups</a>
        <a class="btn small ghost" href="#automod-login" data-jump>Sign-in</a>
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
      </div>

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
        <div class="row automod-bulk">
          <button class="btn small primary" type="button" data-join-action="approve" disabled>Approve selected</button>
          <button class="btn small danger" type="button" data-join-action="reject" disabled>Reject selected</button>
          <span class="muted" id="automod-join-selected" aria-live="polite"></span>
        </div>
        <div id="automod-join-results"><div class="spinner">Loading…</div></div>
      </section>

      <section class="card" id="automod-test" aria-labelledby="automod-test-title">
        <h2 id="automod-test-title">Test text</h2>
        <p class="muted">Check text against the saved rules without acting on anyone. Save a word list first to test it.</p>
        <label
          >Text to check<textarea id="automod-test-text" rows="3" maxlength="4000" placeholder="Paste a message or a name"></textarea>
        </label>
        <div class="row" style="margin-top:12px">
          <button class="btn" type="button" id="automod-test-run">Check text</button>
        </div>
        <div id="automod-test-result" class="automod-test-result" role="status" aria-live="polite"></div>
      </section>

      <form class="card" id="automod-slurs" aria-labelledby="automod-slurs-title">
        <h2 id="automod-slurs-title">Slur auto-ban</h2>
        <p class="muted">
          Catches the hard-R slur in messages, edits, polls, thread, channel and server names, including spaced
          out, leetspeak, look-alike letters and full-width spellings. It ignores Niger, Nigeria, Nigerian, snigger
          and niggardly. Encrypted DMs are only checked when someone reports a message.
        </p>
        <div class="stack">
          ${toggle("enabled", s.slurs.enabled, "Turn on the slur auto-ban", "Rejects the message, suspends the account and records a violation on its Account Standing page.")}
          ${toggle("includeSoftA", s.slurs.includeSoftA, "Also act on the soft-A spelling", "Off by default. When on, the soft-A spelling gets the same suspension.")}
          ${toggle("deleteAllMessages", s.slurs.deleteAllMessages, "Delete all of the user's messages", "Removes every message the account ever sent, in every server and DM, right after the suspension.")}
          ${toggle("actOnVerifiedReports", s.slurs.actOnVerifiedReports, "Act on verified encrypted reports", "When a report of an encrypted message carries a signature-verified copy of the text, the same action runs.")}
        </div>
        <div class="form-grid" style="margin-top:16px">
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
          <button class="btn small danger" type="button" id="automod-name-disable" disabled>Disable selected</button>
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

      <form class="card" id="automod-login" aria-labelledby="automod-login-title">
        <h2 id="automod-login-title">Sign-in protection</h2>
        <p class="muted">Locks an account after repeated wrong passwords, whichever IP addresses they come from. The per-IP sign-in rate limit applies too.</p>
        <div class="form-grid">
          ${number("maxFailedAttemptsPerAccount", s.login.maxFailedAttemptsPerAccount, "Wrong passwords before a lock", "0 turns the lock off.", 0, 1000)}
          ${number("lockoutMinutes", s.login.lockoutMinutes, "Lock length", "Minutes, counted from the first wrong password.", 1, 10080)}
        </div>
        <div class="form-actions"><button class="btn primary" type="submit">Save sign-in protection</button></div>
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
    $$("input[name]", form).map((input) => [input.name, input.type === "checkbox" ? input.checked : Number(input.value)]),
  );

  $("#automod-slurs", view).addEventListener("submit", (event) => {
    event.preventDefault();
    save(event.currentTarget, { slurs: values(event.currentTarget) }, "Slur auto-ban saved");
  });
  $("#automod-registration", view).addEventListener("submit", (event) => {
    event.preventDefault();
    save(event.currentTarget, { registration: values(event.currentTarget) }, "Signup rules saved");
  });
  $("#automod-login", view).addEventListener("submit", (event) => {
    event.preventDefault();
    save(event.currentTarget, { login: values(event.currentTarget) }, "Sign-in protection saved");
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
      <div class="row"><button class="btn small ghost" type="button" data-remove>Remove this list</button></div>
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
      $("[data-remove]", fieldset).addEventListener("click", () => {
        lists = readLists();
        lists.splice(Number(fieldset.dataset.index), 1);
        $("#automod-lists").dataset.dirty = "true";
        drawLists();
      });
    }
  };
  drawLists();
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
    const target = $("#automod-test-result", view);
    if (!text.trim()) {
      target.textContent = "Type or paste some text to check.";
      return;
    }
    const result = await act($("#automod-test-run", view), () => api("/admin/automod/test", { method: "POST", body: { text } }));
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
                                ? html`<span class="badge ok automod-sub">${entry.reversal === "not_a_match" ? "Not a match" : "Undone"}</span>`
                                : ""}
                            </td>
                            <td class="hide-sm automod-excerpt">${entry.excerpt || html`<span class="muted">None</span>`}</td>
                            <td>
                              <div class="row automod-row-actions">
                                ${entry.user_id ? html`<button class="btn small" type="button" data-open="${entry.user_id}">Open user</button>` : ""}
                                ${entry.reversed
                                  ? ""
                                  : html`${entry.action === "block" ? "" : html`<button class="btn small" type="button" data-reverse="undo">Undo</button>`}
                                      ${entry.rule === "ip_limit" ? "" : html`<button class="btn small ghost" type="button" data-reverse="not_a_match">Not a match</button>`}`}
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
            if (!confirm(question)) return;
            const done = await act(
              button,
              () => api(`/admin/automod/actions/${id}/reverse`, { method: "POST", body: { reversal } }),
              reversal === "not_a_match" ? "Added to the allow list" : "Action undone",
            );
            if (done !== undefined) loadLog();
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
    $("#automod-join-selected", view).textContent = count ? `${fmtNumber(count)} selected` : "";
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
                    <th><input type="checkbox" data-select-all aria-label="Select every account on this page" /></th>
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
                        <td><input type="checkbox" data-select="${u.id}" aria-label="Select ${userName(u)}" /></td>
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
                  <th><span class="visually-hidden">Select</span></th>
                  <th>Account</th>
                  <th>Matched</th>
                  <th class="hide-sm">Joined</th>
                </tr>
              </thead>
              <tbody>
                ${st.users.map(
                  (u) => html`<tr>
                    <td><input type="checkbox" data-name-select="${u.id}" ${u.disabled ? raw("disabled") : ""} aria-label="Select ${u.username}" /></td>
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

  await Promise.all([loadLog(), loadJoin()]);
}

TABS.automod = renderAutomod;
