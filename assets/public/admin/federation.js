"use strict";

const FEDERATION_GITHUB_EDIT = "https://github.com/meowcorded/meowcord/edit/main/instances.json";
const FEDERATION_BLOCK_KINDS = [
  ["instance", "Instance"],
  ["guild", "Server"],
  ["user", "User"],
];
const FEDERATION_GUILD_STATUS = {
  verified: ["ok", "Listed by the registry"],
  pending: ["warn", "Waiting for the registry"],
  blocked: ["danger", "Blocked"],
  unknown: ["", "No public address"],
};
const FEDERATION_INSTANCE_STATE = {
  active: ["ok", "Federating"],
  listed: ["info", "Listed only"],
  suspended: ["warn", "Suspended"],
  blocked: ["danger", "Blocked"],
};
const FEDERATION_REGISTRATION = { open: "Open", invite: "Invite only", approval: "Needs approval", closed: "Closed" };
const FEDERATION_ANNOUNCE_STATUS = {
  pending: ["warn", "Waiting for review"],
  listed: ["info", "Listed"],
  active: ["ok", "Federating"],
  suspended: ["warn", "Suspended"],
  blocked: ["danger", "Blocked"],
  accepted: ["ok", "Accepted"],
  sent: ["ok", "Sent"],
  skipped: ["", "Not sent"],
  failed: ["danger", "Failed"],
  moved: ["warn", "Moved to another id"],
};
const FEDERATION_MOVE_STATUS = {
  pending: ["warn", "Waiting"],
  running: ["info", "Rewriting"],
  applied: ["ok", "Applied"],
  unverified: ["warn", "Needs an admin"],
  refused: ["danger", "Refused"],
};
const FEDERATION_MOVE_SOURCE = { registry: "Registry", direct: "The instance itself", admin: "An admin here" };
const FEDERATION_MOVE_COUNTS = [
  ["objects", "id mappings"],
  ["users", "shadow users"],
  ["guilds", "mirror servers"],
  ["channels", "mirror channels"],
  ["former_recipients", "former DM recipients"],
  ["merged_users", "duplicate users merged"],
  ["merged_guilds", "duplicate servers merged"],
  ["merged_channels", "duplicate DMs merged"],
  ["blocks", "blocks copied"],
  ["verified_guilds", "verified servers"],
  ["inbox_events", "remembered events"],
  ["outbox", "queued events"],
  ["deliveries", "delivery queues"],
  ["peers", "peer rows"],
  ["config_peers", "configured peers"],
  ["e2ee_keys", "cached encryption keys dropped"],
];

async function renderFederation(view) {
  const [overview, document, guilds, blocks, candidates, delivery, remote, usage, moves] = await Promise.all([
    api("/admin/federation"),
    api("/admin/federation/registry").then((body) => body?.document ?? null),
    api("/admin/federation/guilds"),
    api("/admin/federation/blocks"),
    api("/admin/federation/verified"),
    api("/admin/federation/delivery"),
    api("/admin/federation/shadows"),
    api("/admin/federation/usage"),
    api("/admin/federation/moves"),
  ]);
  const moveCounts = (counts) => {
    const parts = FEDERATION_MOVE_COUNTS.filter(([key]) => counts?.[key]).map(([key, label]) => `${fmtNumber(counts[key])} ${label}`);
    return parts.length ? parts.join(", ") : "Nothing needed rewriting";
  };
  const usageCell = (count, limit) => {
    const full = limit && count >= limit;
    const near = limit && count >= limit * 0.9;
    return html`<td class="num">${fmtNumber(count)}${limit ? html`<span class="muted"> / ${fmtNumber(limit)}</span>` : ""}${full ? html` <span class="badge danger">Full</span>` : near ? html` <span class="badge warn">Almost full</span>` : ""}</td>`;
  };
  const deliveryBadge = (entry) =>
    entry.unreachable
      ? html`<span class="badge danger">Unreachable</span>`
      : entry.failing_since
        ? html`<span class="badge warn">Retrying since ${fmtDate(entry.failing_since)}</span>`
        : entry.last_success_at
          ? html`<span class="badge ok">Delivering</span>`
          : html`<span class="badge">Nothing sent yet</span>`;
  const blockedTargets = new Set(blocks.map((block) => block.target));
  const { settings: s, instance, status } = overview;
  const instanceMode = s.verification === "instance";
  const toggle = (name, checked, label, hint) =>
    html`<label class="toggle"
      ><input type="checkbox" name="${name}" ${checked ? raw("checked") : ""} /><span
        >${label}${hint ? html`<span class="hint">${hint}</span>` : ""}</span
      ></label
    >`;
  const badge = (map, key) => {
    const [kind, label] = map[key] ?? ["", key ?? "Never"];
    return html`<span class="badge ${kind}">${label}</span>`;
  };
  const registryBadge = status.live
    ? html`<span class="badge ok">Up to date</span>`
    : status.sequence == null
      ? html`<span class="badge warn">No registry list yet</span>`
      : html`<span class="badge danger">Expired</span>`;
  const blockRows = (list, kind) =>
    list.map(
      (entry) => html`<tr>
        <td>${kind}</td>
        <td class="federation-id">${entry.id}</td>
        <td>${entry.reason || html`<span class="muted">No reason given</span>`}</td>
        <td class="hide-sm">${fmtDate(entry.at)}</td>
      </tr>`,
    );
  const registryBlocks = document
    ? [
        ...blockRows(document.blocked.instances, "Instance"),
        ...blockRows(document.blocked.guilds, "Server"),
        ...blockRows(document.blocked.users, "User"),
      ]
    : [];

  mount(
    view,
    html`
      <div class="page-head">
        <div>
          <h1>Federation</h1>
          <p class="muted">
            Other approved instances list their public servers in each other's Discovery. A shared registry decides which
            instances take part, and this page controls how this instance joins in.
          </p>
        </div>
      </div>
      <div class="stack">
        <div class="stats">
          <div class="card stat">
            <span class="muted">Registry list published</span>
            <div class="value federation-value">${status.issued_at ? fmtDay(status.issued_at) : "Never"}</div>
            <div class="badges">${registryBadge}</div>
          </div>
          <div class="card stat">
            <span class="muted">Approved instances</span>
            <div class="value">${fmtNumber(overview.counts?.instances)}</div>
          </div>
          <div class="card stat">
            <span class="muted">Servers listed by the registry</span>
            <div class="value">${fmtNumber(overview.counts?.discovery)}</div>
          </div>
          <div class="card stat">
            <span class="muted">Your servers shown elsewhere</span>
            <div class="value">${fmtNumber(guilds.filter((guild) => guild.verified && !guild.hidden).length)}</div>
          </div>
        </div>

        <section class="card" aria-labelledby="federation-status-title">
          <h2 id="federation-status-title">Registry</h2>
          <dl class="federation-facts">
            <div><dt>Address</dt><dd class="federation-id">${s.registryUrl}</dd></div>
            <div><dt>List sequence</dt><dd class="federation-id">${status.sequence ?? "None yet"}</dd></div>
            <div><dt>Last check</dt><dd>${fmtDate(status.last_fetch_at)}</dd></div>
            <div><dt>List accepted</dt><dd>${fmtDate(status.accepted_at)}</dd></div>
            <div><dt>List expires</dt><dd>${fmtDate(status.expires_at)}</dd></div>
          </dl>
          ${status.last_error
            ? html`<p class="federation-error" role="status"><strong>The last check failed.</strong> ${status.last_error}</p>`
            : ""}
          <div class="form-actions">
            <button class="btn" type="button" id="federation-refresh">Check the registry now</button>
          </div>
        </section>

        <form class="card" id="federation-settings" aria-labelledby="federation-settings-title">
          <h2 id="federation-settings-title">Settings</h2>
          <div class="stack">
            ${toggle("enabled", s.enabled, "Take part in federation", "Fetches the registry every 5 minutes, publishes this instance's discovery list and shows the Other instances tab in Discovery.")}
            ${toggle("announce", s.announce, "Tell the registry about this instance once a day", "Sends a signed hello when the server starts and every 24 hours. Addresses like localhost or private IPs are never sent.")}
            ${toggle("announceStats", s.announceStats, "Send user, server and message counts with each announce", "The registry admins see how many local users and servers this instance has and how many messages were sent in the last 24 hours. The counts are never published.")}
            ${toggle("allowUnlistedPeers", s.allowUnlistedPeers, "Show peers that aren't in the registry", "Instances in the peer list below appear in Discovery even when the registry hasn't approved them. Registry and local blocks still apply.")}
          </div>
          <div class="form-grid" style="margin-top:16px">
            <label
              >Registry address<span class="hint">Where the signed list of approved instances comes from.</span
              ><input name="registryUrl" type="url" inputmode="url" value="${s.registryUrl}" required
            /></label>
            <label
              >Registry public key<span class="hint">Ed25519, base64url. Changing the address or key forgets the stored list.</span
              ><input name="registryPublicKey" value="${s.registryPublicKey}" autocomplete="off" spellcheck="false" required
            /></label>
            <label
              >Which servers appear in Discovery<select name="verification">
                ${options(
                  [
                    ["registry", "Servers the registry verified"],
                    ["instance", "Servers verified on this page"],
                  ],
                  s.verification,
                )}
              </select></label
            >
            <label class="span"
              >Peers<span class="hint">Instance ids such as meow.example, one per line. Used only when showing unlisted peers is on.</span
              ><textarea name="peers" rows="3" spellcheck="false">${s.peers.join("\n")}</textarea>
            </label>
            <label class="span"
              >Registry contacts<span class="hint">Local usernames, one per line, at most 10. The registry admins see them privately and can add them to a group DM with the admins of every instance. Leave it empty to send every account with the operator right.</span
              ><textarea name="contacts" rows="3" spellcheck="false" autocomplete="off">${(s.contacts ?? []).join("\n")}</textarea>
            </label>
            <label class="span"
              >Previous ids<span class="hint">Ids this instance had before its address changed, one per line, at most 10. This instance signs a move statement for each one with its key, serves it in its well-known document and sends it to every instance it talks to. Read Change your instance's URL in the self-hosting docs first.</span
              ><textarea name="previousIds" rows="2" spellcheck="false" autocomplete="off">${(s.previousIds ?? []).join("\n")}</textarea>
            </label>
          </div>
          ${overview.peers.length
            ? html`<div class="table-wrap" style="margin-top:12px">
                <table>
                  <thead>
                    <tr><th>Peer</th><th class="num">Servers</th><th class="hide-sm">Fetched</th><th>Result</th></tr>
                  </thead>
                  <tbody>
                    ${overview.peers.map(
                      (peer) => html`<tr>
                        <td class="federation-id">${peer.id}</td>
                        <td class="num">${fmtNumber(peer.guilds)}</td>
                        <td class="hide-sm">${fmtDate(peer.fetched_at)}</td>
                        <td>${peer.error ? html`<span class="badge danger">Failed</span> <span class="muted">${peer.error}</span>` : html`<span class="badge ok">Fetched</span>`}</td>
                      </tr>`,
                    )}
                  </tbody>
                </table>
              </div>`
            : ""}
          <div class="form-actions"><button class="btn primary" type="submit">Save federation settings</button></div>
        </form>

        <section class="card" aria-labelledby="federation-announce-title">
          <h2 id="federation-announce-title">Announce</h2>
          <p class="muted">
            This instance is <strong class="federation-id">${instance.id ?? "not reachable at a public address"}</strong>.
            ${instance.listed ? "The registry lists it as approved." : "The registry doesn't list it yet."}
          </p>
          ${instance.announce_refusal
            ? html`<p class="federation-error" role="status">${instance.announce_refusal}</p>`
            : ""}
          <dl class="federation-facts">
            <div><dt>Last sent</dt><dd>${fmtDate(status.announce.at)}</dd></div>
            <div><dt>Result</dt><dd>${status.announce.status ? badge(FEDERATION_ANNOUNCE_STATUS, status.announce.status) : html`<span class="muted">Never sent</span>`}</dd></div>
            <div><dt>Contacts sent</dt><dd class="federation-id">${instance.contacts?.length ? instance.contacts.join(", ") : html`<span class="muted">None</span>`}</dd></div>
          </dl>
          ${status.announce.error ? html`<p class="muted">${status.announce.error}</p>` : ""}
          <div class="form-actions">
            <button class="btn" type="button" id="federation-announce">Send to registry</button>
          </div>
        </section>

        <section class="card" aria-labelledby="federation-listing-title">
          <h2 id="federation-listing-title">Get listed</h2>
          <p class="muted federation-prose">
            The registry lists an instance after someone adds it to instances.json on GitHub and a maintainer merges the
            pull request. Copy the entry below, open the file on GitHub, add the entry to the list and propose the change.
            Announcing first lets the maintainers see that the address answers and signs with this key.
          </p>
          ${instance.instances_json
            ? html`<label
                  >Entry for instances.json<textarea id="federation-entry" rows="9" readonly spellcheck="false">${JSON.stringify(instance.instances_json, null, 2)}</textarea>
                </label>
                <div class="form-actions">
                  <button class="btn" type="button" id="federation-copy">Copy entry</button>
                  <a class="btn primary" href="${FEDERATION_GITHUB_EDIT}" target="_blank" rel="noopener">Open instances.json on GitHub ↗</a>
                </div>`
            : html`<p class="empty">Set a public server address under Site settings first. The entry needs it.</p>`}
        </section>

        <section class="card" aria-labelledby="federation-guilds-title">
          <h2 id="federation-guilds-title">Servers on other instances</h2>
          <p class="muted">Servers whose owners turned on Show on other instances. Other instances only see the ones you verify. The registry lists them within an hour and can still block one.</p>
          ${guilds.length
            ? html`<div class="table-wrap">
                <table>
                  <thead>
                    <tr><th>Server</th><th class="num hide-sm">Members</th><th>Status</th><th></th></tr>
                  </thead>
                  <tbody>
                    ${guilds.map(
                      (guild) => html`<tr>
                        <td>
                          <div>${guild.name}</div>
                          <div class="muted federation-id">${guild.canonical_id ?? guild.id}</div>
                        </td>
                        <td class="num hide-sm">${fmtNumber(guild.member_count)}</td>
                        <td>${!guild.verified || guild.hidden ? html`<span class="badge warn">Waiting for you</span>` : badge(FEDERATION_GUILD_STATUS, guild.registry_status)}</td>
                        <td class="num">
                          <button class="btn small ${guild.verified && !guild.hidden ? "ghost" : ""}" type="button" data-verify-guild="${guild.id}" data-verified="${guild.verified && !guild.hidden ? "1" : ""}">
                            ${guild.verified && !guild.hidden ? "Take back" : "Verify"}
                          </button>
                        </td>
                      </tr>`,
                    )}
                  </tbody>
                </table>
              </div>`
            : html`<p class="empty">No server owner has turned on Show on other instances. Owners find it in Server Settings, Other instances.</p>`}
        </section>

        ${instanceMode
          ? html`<section class="card" aria-labelledby="federation-verify-title">
              <h2 id="federation-verify-title">Verify servers from other instances</h2>
              <p class="muted">Discovery shows only the servers you verify here. Blocked servers can't be verified.</p>
              ${candidates.length
                ? html`<div class="table-wrap">
                    <table>
                      <thead>
                        <tr><th>Server</th><th>Instance</th><th class="num hide-sm">Members</th><th></th></tr>
                      </thead>
                      <tbody>
                        ${candidates.map(
                          (guild) => html`<tr>
                            <td>
                              <div>${guild.name}</div>
                              <div class="muted federation-id">${guild.id}</div>
                            </td>
                            <td class="federation-id">${guild.instance}</td>
                            <td class="num hide-sm">${fmtNumber(guild.member_count)}</td>
                            <td class="num">
                              ${guild.blocked
                                ? html`<span class="badge danger">Blocked</span>`
                                : html`<button class="btn small ${guild.verified_at ? "ghost" : "primary"}" type="button" data-verify="${guild.id}" data-verified="${guild.verified_at ? "1" : ""}">
                                    ${guild.verified_at ? "Remove verification" : "Verify server"}
                                  </button>`}
                            </td>
                          </tr>`,
                        )}
                      </tbody>
                    </table>
                  </div>`
                : html`<p class="empty">No other instance lists any servers yet. Check the registry again later.</p>`}
            </section>`
          : ""}

        <section class="card" aria-labelledby="federation-moves-title">
          <h2 id="federation-moves-title">Instance moves</h2>
          <p class="muted">
            Instances that changed their id. This instance applies a move after it checks that the new id holds the key the
            old id had, then rewrites the users, servers and queued events it keeps for the old id. A move where the key
            changed waits for an admin here unless the registry admins approved it.
          </p>
          ${moves.own.previous_ids.length
            ? html`<dl class="federation-facts">
                ${moves.own.statements.map(
                  (statement) => html`<div>
                    <dt class="federation-id">${statement.from}</dt>
                    <dd>Moved to <span class="federation-id">${statement.to ?? "unknown"}</span>. ${statement.delivered ? html`Last sent ${fmtDate(statement.delivered.at)}. <span class="muted">${statement.delivered.status}</span>` : html`<span class="muted">Not sent to other instances yet.</span>`}</dd>
                  </div>`,
                )}
              </dl>`
            : ""}
          ${moves.moves.length
            ? html`<div class="table-wrap">
                <table>
                  <thead>
                    <tr><th>Move</th><th>State</th><th class="hide-sm">Learned from</th><th>What changed</th><th></th></tr>
                  </thead>
                  <tbody>
                    ${moves.moves.map(
                      (move) => html`<tr>
                        <td>
                          <div class="federation-id">${move.from}</div>
                          <div class="muted federation-id">to ${move.to}</div>
                        </td>
                        <td>${badge(FEDERATION_MOVE_STATUS, move.status)}${move.key_changed ? html` <span class="badge warn">New key</span>` : ""}</td>
                        <td class="hide-sm">${FEDERATION_MOVE_SOURCE[move.source] ?? move.source}<div class="muted">${fmtDate(move.created_at)}</div></td>
                        <td>
                          ${move.status === "applied" ? html`<div>${moveCounts(move.counts)}</div><div class="muted">Applied ${fmtDate(move.applied_at)}</div>` : ""}
                          ${move.detail ? html`<div class="muted">${move.detail}</div>` : ""}
                          ${move.counts?.retired?.length
                            ? html`<details>
                                <summary>Duplicates retired</summary>
                                <ul class="federation-id">
                                  ${move.counts.retired.map((entry) => html`<li>${entry.kind} ${entry.loser}, kept ${entry.winner}</li>`)}
                                </ul>
                              </details>`
                            : ""}
                        </td>
                        <td class="num">
                          ${move.status === "unverified" || move.status === "pending"
                            ? html`<button class="btn small primary" type="button" data-apply-move="${move.id}">Apply</button>`
                            : ""}
                        </td>
                      </tr>`,
                    )}
                  </tbody>
                </table>
              </div>`
            : html`<p class="empty">No instance this one knows has changed its id.</p>`}
        </section>

        <section class="card" aria-labelledby="federation-delivery-title">
          <h2 id="federation-delivery-title">Event delivery</h2>
          <p class="muted">
            Messages, member changes, presence and friend requests sent to other instances. Each instance has its own queue,
            and events it doesn't accept within 24 hours are dropped. A restart clears the queues.
          </p>
          ${delivery.instances.length
            ? html`<div class="table-wrap">
                <table>
                  <thead>
                    <tr><th>Instance</th><th>State</th><th class="num">Queued</th><th class="num hide-sm">Delivered</th><th class="num hide-sm">Dropped</th><th class="hide-sm">Last error</th></tr>
                  </thead>
                  <tbody>
                    ${delivery.instances.map(
                      (entry) => html`<tr>
                        <td class="federation-id">${entry.instance}</td>
                        <td>${deliveryBadge(entry)}</td>
                        <td class="num">${fmtNumber(entry.queued)}</td>
                        <td class="num hide-sm">${fmtNumber(entry.delivered)}</td>
                        <td class="num hide-sm">${fmtNumber(entry.dropped)}</td>
                        <td class="hide-sm">${entry.last_error || html`<span class="muted">None</span>`}</td>
                      </tr>`,
                    )}
                  </tbody>
                </table>
              </div>`
            : html`<p class="empty">Nothing has been sent to another instance yet. Delivery starts when someone from another instance joins a server or starts a conversation here.</p>`}
        </section>

        <section class="card" aria-labelledby="federation-usage-title">
          <h2 id="federation-usage-title">Storage per instance</h2>
          <p class="muted">
            Rows each other instance has made here. When an instance reaches a limit, this instance refuses its new ids, users,
            servers or events with status 507 until an operator raises the limit in <code>federation.limits</code> or the rows age out.
            One request can add at most ${fmtNumber(usage.limits.new_objects_per_request)} new ids.
          </p>
          ${usage.instances.length
            ? html`<div class="table-wrap">
                <table>
                  <thead>
                    <tr><th>Instance</th><th class="num">Ids</th><th class="num">Users</th><th class="num">Servers</th><th class="num hide-sm">Remembered events</th><th class="num hide-sm">Queued events</th></tr>
                  </thead>
                  <tbody>
                    ${usage.instances.map(
                      (entry) => html`<tr>
                        <td class="federation-id">${entry.instance}</td>
                        ${usageCell(entry.objects, usage.limits.objects)}
                        ${usageCell(entry.shadows, usage.limits.shadows)}
                        ${usageCell(entry.guilds, usage.limits.guilds)}
                        <td class="num hide-sm">${fmtNumber(entry.inbox_events)}${usage.limits.inbox_events ? html`<span class="muted"> / ${fmtNumber(usage.limits.inbox_events)}</span>` : ""}</td>
                        <td class="num hide-sm">${fmtNumber(entry.outbox_events)}<span class="muted"> / ${fmtNumber(usage.limits.outbox_events)}</span></td>
                      </tr>`,
                    )}
                  </tbody>
                </table>
              </div>`
            : html`<p class="empty">No other instance has stored anything here yet.</p>`}
        </section>

        <section class="card" aria-labelledby="federation-remote-title">
          <h2 id="federation-remote-title">Users and servers from other instances</h2>
          <p class="muted">
            This instance keeps a copy of each user and server from another instance that its members talk to. These users
            can't sign in here. ${fmtNumber(remote.total_users)} users are stored, newest first.
          </p>
          ${remote.users.length || remote.guilds.length
            ? html`<div class="table-wrap">
                <table>
                  <thead>
                    <tr><th>Name</th><th>Kind</th><th class="hide-sm">Canonical id</th><th></th></tr>
                  </thead>
                  <tbody>
                    ${[
                      ...remote.guilds.map((guild) => ({ kind: "guild", label: "Server", name: guild.name, canonical: guild.canonical })),
                      ...remote.users.map((user) => ({
                        kind: "user",
                        label: user.bot ? "Bot" : "User",
                        name: user.global_name ? `${user.global_name} (${user.username})` : user.username,
                        canonical: user.canonical,
                      })),
                    ].map(
                      (row) => html`<tr>
                        <td>${row.name}</td>
                        <td>${row.label}</td>
                        <td class="hide-sm federation-id">${row.canonical ?? html`<span class="muted">Unknown</span>`}</td>
                        <td class="num">
                          ${!row.canonical
                            ? ""
                            : blockedTargets.has(row.canonical)
                              ? html`<span class="badge danger">Blocked</span>`
                              : html`<button class="btn small ghost" type="button" data-block-kind="${row.kind}" data-block-target="${row.canonical}">
                                  Block ${row.kind === "guild" ? "server" : "user"}
                                </button>`}
                        </td>
                      </tr>`,
                    )}
                  </tbody>
                </table>
              </div>`
            : html`<p class="empty">No one from another instance has talked to anyone here yet.</p>`}
        </section>

        <section class="card" aria-labelledby="federation-blocks-title">
          <h2 id="federation-blocks-title">Blocks on this instance</h2>
          <p class="muted">
            These apply on top of the registry's blocks. Blocking an instance also hides every server and user from it.
            Servers and users use canonical ids such as @123@meow.example.
          </p>
          <form class="row federation-block-form" id="federation-block-form">
            <label
              >Kind<select name="kind">
                ${options(FEDERATION_BLOCK_KINDS, "instance")}
              </select></label
            >
            <label class="grow"
              >Instance or canonical id<input name="target" required autocomplete="off" spellcheck="false" placeholder="meow.example"
            /></label>
            <label class="grow">Reason<input name="reason" maxlength="500" placeholder="Optional" /></label>
            <button class="btn danger" type="submit">Add block</button>
          </form>
          ${blocks.length
            ? html`<div class="table-wrap" style="margin-top:12px">
                <table>
                  <thead>
                    <tr><th>Kind</th><th>Target</th><th>Reason</th><th class="hide-sm">Added</th><th></th></tr>
                  </thead>
                  <tbody>
                    ${blocks.map(
                      (block) => html`<tr>
                        <td>${FEDERATION_BLOCK_KINDS.find(([key]) => key === block.kind)?.[1] ?? block.kind}</td>
                        <td class="federation-id">${block.target}</td>
                        <td>${block.reason || html`<span class="muted">No reason given</span>`}</td>
                        <td class="hide-sm">${fmtDate(block.created_at)}</td>
                        <td class="num"><button class="btn small ghost" type="button" data-unblock="${block.id}">Lift block</button></td>
                      </tr>`,
                    )}
                  </tbody>
                </table>
              </div>`
            : html`<p class="empty" style="margin-top:12px">Nothing is blocked on this instance. The registry's blocks still apply.</p>`}
        </section>

        <section class="card" aria-labelledby="federation-registry-title">
          <h2 id="federation-registry-title">Registry instances and blocks</h2>
          <p class="muted">Read only. These come from the signed registry list and change when the registry publishes a new one.</p>
          ${document
            ? html`<div class="table-wrap">
                  <table>
                    <thead>
                      <tr><th>Instance</th><th>State</th><th class="hide-sm">Signups</th><th class="hide-sm">Listed since</th></tr>
                    </thead>
                    <tbody>
                      ${document.instances.map(
                        (entry) => html`<tr>
                          <td>
                            <div>${entry.name}</div>
                            <a class="muted federation-id" href="${entry.url}" target="_blank" rel="noopener">${entry.id}</a>
                          </td>
                          <td>${badge(FEDERATION_INSTANCE_STATE, entry.state)}</td>
                          <td class="hide-sm">${FEDERATION_REGISTRATION[entry.registration] ?? entry.registration}</td>
                          <td class="hide-sm">${fmtDay(entry.listed_at)}</td>
                        </tr>`,
                      )}
                    </tbody>
                  </table>
                </div>
                ${registryBlocks.length
                  ? html`<div class="table-wrap" style="margin-top:12px">
                      <table>
                        <thead>
                          <tr><th>Kind</th><th>Blocked</th><th>Reason</th><th class="hide-sm">Since</th></tr>
                        </thead>
                        <tbody>${registryBlocks}</tbody>
                      </table>
                    </div>`
                  : html`<p class="empty" style="margin-top:12px">The registry blocks nothing right now.</p>`}`
            : html`<p class="empty">No registry list has been accepted yet. Check the registry above.</p>`}
        </section>
      </div>
    `,
  );

  const rerender = () => renderFederation(view).catch((error) => toast(error.message, "error"));

  $("#federation-refresh", view).addEventListener("click", async (event) => {
    const done = await act(event.currentTarget, () => api("/admin/federation/refresh", { method: "POST" }), "Registry checked");
    if (done) rerender();
  });
  $("#federation-announce", view).addEventListener("click", async (event) => {
    const done = await act(event.currentTarget, () => api("/admin/federation/announce", { method: "POST" }), "Announce finished");
    if (done) rerender();
  });
  $("#federation-copy", view)?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("#federation-entry", view).value);
      toast("Entry copied");
    } catch {
      $("#federation-entry", view).select();
      toast("Couldn't copy the entry. It's selected, so press Ctrl+C or Cmd+C.", "error");
    }
  });
  $("#federation-settings", view).addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const { elements } = form;
    const body = {
      enabled: elements.enabled.checked,
      announce: elements.announce.checked,
      announceStats: elements.announceStats.checked,
      allowUnlistedPeers: elements.allowUnlistedPeers.checked,
      registryUrl: elements.registryUrl.value.trim(),
      registryPublicKey: elements.registryPublicKey.value.trim(),
      verification: elements.verification.value,
      peers: elements.peers.value
        .split("\n")
        .map((line) => line.trim().toLowerCase())
        .filter(Boolean),
      contacts: elements.contacts.value
        .split("\n")
        .map((line) => line.trim().toLowerCase().replace(/^@/, ""))
        .filter(Boolean),
      previousIds: elements.previousIds.value
        .split("\n")
        .map((line) => line.trim().toLowerCase())
        .filter(Boolean),
    };
    const saved = await act($("button[type=submit]", form), () => api("/admin/federation/settings", { method: "PATCH", body }), "Federation settings saved");
    if (saved) rerender();
  });
  for (const button of $$("[data-verify-guild]", view))
    button.addEventListener("click", async () => {
      const verified = !button.dataset.verified;
      const done = await act(
        button,
        () => api(`/admin/federation/guilds/${button.dataset.verifyGuild}`, { method: "PATCH", body: { verified } }),
        verified ? "Server verified for other instances" : "Server taken off other instances",
      );
      if (done) rerender();
    });
  for (const button of $$("[data-verify]", view))
    button.addEventListener("click", async () => {
      const verified = !button.dataset.verified;
      const done = await act(
        button,
        () => api("/admin/federation/verified", { method: "POST", body: { id: button.dataset.verify, verified } }),
        verified ? "Server verified" : "Verification removed",
      );
      if (done) rerender();
    });
  for (const button of $$("[data-apply-move]", view))
    button.addEventListener("click", async () => {
      const done = await act(button, () => api(`/admin/federation/moves/${button.dataset.applyMove}`, { method: "POST" }), "Move applied");
      if (done) rerender();
    });
  $("#federation-block-form", view).addEventListener("submit", async (event) => {
    event.preventDefault();
    const { elements } = event.currentTarget;
    const body = { kind: elements.kind.value, target: elements.target.value.trim(), reason: elements.reason.value.trim() };
    const done = await act($("button[type=submit]", event.currentTarget), () => api("/admin/federation/blocks", { method: "POST", body }), "Block added");
    if (done) rerender();
  });
  for (const button of $$("[data-block-target]", view))
    button.addEventListener("click", async () => {
      const body = { kind: button.dataset.blockKind, target: button.dataset.blockTarget, reason: "" };
      const done = await act(button, () => api("/admin/federation/blocks", { method: "POST", body }), "Block added");
      if (done) rerender();
    });
  for (const button of $$("[data-unblock]", view))
    button.addEventListener("click", async () => {
      const done = await act(button, () => api(`/admin/federation/blocks/${button.dataset.unblock}`, { method: "DELETE" }), "Block lifted");
      if (done !== undefined) rerender();
    });
}

TABS.federation = renderFederation;
