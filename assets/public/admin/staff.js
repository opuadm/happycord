"use strict";

const STAFF_ROLE_RIGHTS = [
  ["VIEW_USERS", 51, "View accounts", "Search accounts and open their details, addresses, sessions and invites."],
  ["SUPPORT_USERS", 54, "Account recovery", "Send password reset links, remove two-factor, mark email verified and sign accounts out."],
  ["VIEW_MODERATION", 53, "Read moderation", "Read reports, violations, IP bans and the automod log without acting."],
  ["MODERATE_USERS", 52, "Moderate accounts", "Handle reports, issue violations, suspend, disable and ban, and act on automod."],
  ["MANAGE_MESSAGES", 3, "Remove content", "Delete or edit any message the account can see."],
  ["MANAGE_USERS", 7, "Manage accounts", "Edit profiles, delete accounts, manage instance invites and automod settings. Includes the four rights above it."],
  ["MANAGE_GUILDS", 2, "Manage servers", "Edit, delete and repair any server."],
  ["MANAGE_STAFF", 55, "Manage staff", "Create, edit and assign staff roles below their own."],
  ["VIEW_AUDIT_LOG", 56, "Read the audit log", "See every staff action on this instance."],
  ["BYPASS_RATE_LIMITS", 9, "Skip rate limits", "Requests from this account are never rate limited."],
  ["CREATE_REGISTRATION_TOKENS", 50, "Registration tokens", "Create registration tokens."],
];

const STAFF_AUDIT_AREAS = [
  ["", "Everything"],
  ["staff", "Staff roles"],
  ["users", "Users"],
  ["reports", "Reports"],
  ["automod", "Automod"],
  ["ips", "IP bans"],
  ["instance-invites", "Instance invites"],
  ["guilds", "Servers"],
  ["channels", "Messages"],
  ["settings", "Site settings"],
  ["announcements", "Announcements"],
];

const STAFF_AUDIT_LABELS = {
  "staff_role.create": "Created a staff role",
  "staff_role.update": "Edited a staff role",
  "staff_role.delete": "Deleted a staff role",
  "staff_role.assign": "Gave a staff role",
  "staff_role.remove": "Took a staff role",
  "user.customization": "Changed a profile customization",
  "official_message.send": "Sent an official message",
};

const staffAuditState = { area: "", action: "", actor_id: "", target_id: "", after: "", before: "" };

const roleBit = (bit) => 1n << BigInt(bit);
const roleHas = (rights, bit) => (BigInt(rights || 0) & roleBit(bit)) !== 0n;
const roleColor = (color) => (color == null ? "var(--muted)" : `#${Number(color).toString(16).padStart(6, "0")}`);
const roleDot = (role) => html`<span class="dot" style="color: ${roleColor(role.color)}" aria-hidden="true"></span>`;
const roleRightNames = (rights) =>
  STAFF_ROLE_RIGHTS.filter(([, bit]) => roleHas(rights, bit)).map(([, , label]) => label);
const roleEditable = (data, role) => data.operator || (data.level != null && role.position < data.level);

async function renderStaffRoles(view) {
  const data = await api("/admin/staff/roles");
  const refresh = () => renderStaffRoles(view);
  const sorted = [...data.roles].sort((a, b) => b.position - a.position);
  mount(
    view,
    html`
      <div class="page-head">
        <div>
          <h1>Staff roles</h1>
          <p class="muted">
            Named sets of rights for staff. Higher roles can manage the roles and people below them, and
            operators are above every role.
            ${data.operator ? "" : html`Your highest role is at position ${data.level ?? 0}, so you can change roles below it.`}
          </p>
        </div>
        <button class="btn primary" id="new-staff-role" type="button">Create role</button>
      </div>
      ${
        sorted.length
          ? html`<div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Role</th>
                    <th class="hide-sm">Rights</th>
                    <th>Members</th>
                    <th>Position</th>
                  </tr>
                </thead>
                <tbody>
                  ${sorted.map(
                    (role, index) => html`<tr data-role="${role.id}">
                      <td>
                        <div class="ident">
                          ${roleDot(role)}
                          <div>
                            <strong>${role.name}</strong>
                            ${role.show_badge ? html`<span class="muted">Shows a staff badge</span>` : ""}
                          </div>
                        </div>
                      </td>
                      <td class="hide-sm"><span class="muted">${roleRightNames(role.rights).join(", ") || "No rights"}</span></td>
                      <td>${fmtNumber(role.members.length)}</td>
                      <td>
                        <div class="row" style="gap: 4px">
                          <span class="muted">${role.position}</span>
                          ${
                            roleEditable(data, role)
                              ? html`<button class="btn small ghost" type="button" data-move="up" data-index="${index}" aria-label="Move ${role.name} up" ${index === 0 || !roleEditable(data, sorted[index - 1]) ? "disabled" : ""}>↑</button>
                                  <button class="btn small ghost" type="button" data-move="down" data-index="${index}" aria-label="Move ${role.name} down" ${index === sorted.length - 1 ? "disabled" : ""}>↓</button>`
                              : html`<span class="badge">Above you</span>`
                          }
                        </div>
                      </td>
                    </tr>`,
                  )}
                </tbody>
              </table>
            </div>`
          : html`<div class="card empty">No staff roles yet. Create one, then give it to people.</div>`
      }
    `,
  );
  $("#new-staff-role", view).addEventListener("click", () => openStaffRole(data, null, refresh));
  for (const row of $$("tr[data-role]", view))
    onRowOpen(row, (event) => {
      if (event.target.closest("button")) return;
      openStaffRole(
        data,
        data.roles.find((role) => role.id === row.dataset.role),
        refresh,
      );
    });
  for (const button of $$("[data-move]", view))
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const index = Number(button.dataset.index);
      const other = sorted[button.dataset.move === "up" ? index - 1 : index + 1];
      const role = sorted[index];
      if (!other) return;
      const positions =
        role.position === other.position
          ? [
              { id: role.id, position: button.dataset.move === "up" ? role.position + 1 : Math.max(1, role.position - 1) },
            ]
          : [
              { id: role.id, position: other.position },
              { id: other.id, position: role.position },
            ];
      const done = await act(button, () => api("/admin/staff/roles", { method: "PATCH", body: positions }), "Order saved");
      if (done) refresh();
    });
}

function openStaffRole(data, role, refresh) {
  const editable = !role || roleEditable(data, role);
  const grantable = BigInt(data.grantable_rights || 0);
  const current = BigInt(role?.rights ?? 0);
  const defaultPosition = data.operator
    ? Math.max(0, ...data.roles.map((r) => r.position)) + 1
    : Math.max(1, (data.level ?? 1) - 1);
  const body = openDrawer(
    role ? `Staff role: ${role.name}` : "Create staff role",
    html`
      <form id="staff-role-form" class="stack">
        ${editable ? "" : html`<div class="card"><p class="muted">This role is at or above your own, so you can only look at it.</p></div>`}
        <label>Name<input name="name" required maxlength="64" value="${role?.name ?? ""}" placeholder="Moderator" ${editable ? "" : "disabled"} /></label>
        <div class="row" style="gap: 12px; flex-wrap: wrap">
          <label
            >Position<span class="hint">Higher numbers rank higher. ${data.operator ? "" : `Yours is ${data.level}.`}</span
            ><input name="position" type="number" min="1" max="${data.operator ? 1000 : Math.max(1, (data.level ?? 1) - 1)}" value="${role?.position ?? defaultPosition}" required ${editable ? "" : "disabled"}
          /></label>
          <label
            >Color<input name="color" type="color" value="${role?.color != null ? roleColor(role.color) : "#5865f2"}" ${editable ? "" : "disabled"}
          /></label>
        </div>
        <label class="toggle"
          ><input type="checkbox" name="show_badge" ${role?.show_badge ? "checked" : ""} ${editable ? "" : "disabled"} /><span
            >Show a staff badge<span class="hint">Members get the instance staff badge on their profile, named after this role.</span></span
          ></label
        >
        <fieldset class="stack" style="border: 0; padding: 0; margin: 0">
          <legend><h3>Rights</h3></legend>
          ${STAFF_ROLE_RIGHTS.map(([name, bit, label, hint]) => {
            const has = (current & roleBit(bit)) !== 0n;
            const allowed = editable && (data.operator || has || (grantable & roleBit(bit)) !== 0n);
            return html`<label class="toggle"
              ><input type="checkbox" data-right="${bit}" ${has ? "checked" : ""} ${allowed ? "" : "disabled"} /><span
                >${label} <code class="muted">${name}</code><span class="hint">${hint}${allowed || !editable ? "" : " You don't have this right, so you can't give it."}</span></span
              ></label
            >`;
          })}
        </fieldset>
        ${
          role
            ? html`<div class="stack">
                <h3>Members</h3>
                <div id="staff-role-members" class="list"></div>
                ${
                  editable && state.overview.access.users
                    ? html`<label
                          >Add someone<span class="hint">Search by name, email or id.</span
                          ><input name="search" autocomplete="off" placeholder="Search accounts…"
                        /></label>
                        <div id="staff-role-search" class="stack"></div>`
                    : ""
                }
              </div>`
            : ""
        }
        ${
          editable
            ? html`<div class="form-actions">
                ${role ? html`<button class="btn danger" id="staff-role-delete" type="button" style="margin-right: auto">Delete role</button>` : ""}
                <button class="btn primary" type="submit">${role ? "Save role" : "Create role"}</button>
              </div>`
            : ""
        }
      </form>
    `,
  );
  if (!body) return;
  const form = $("#staff-role-form", body);
  const rolesOfUser = (userId) =>
    data.roles.filter((r) => r.members.some((member) => member.id === userId)).map((r) => r.id);
  const setRoles = (button, userId, roleIds, message) =>
    act(button, () => api(`/admin/users/${userId}/staff-roles`, { method: "PUT", body: { role_ids: roleIds } }), message);

  const drawMembers = () => {
    const box = $("#staff-role-members", body);
    if (!box) return;
    mount(
      box,
      role.members.length
        ? role.members.map(
            (member) => html`<div class="list-item">
              ${avatar(member)}
              <div class="grow">
                <strong>${userName(member)}</strong>
                <div class="muted">${member.username ? userTag(member) : member.id}${member.assigned_at ? html` · since ${fmtDay(member.assigned_at)}` : ""}</div>
              </div>
              ${editable && member.id !== state.me?.id ? html`<button class="btn small ghost" type="button" data-remove="${member.id}">Remove</button>` : ""}
            </div>`,
          )
        : html`<p class="muted">Nobody has this role yet.</p>`,
    );
    for (const button of $$("[data-remove]", box))
      button.addEventListener("click", async () => {
        const userId = button.dataset.remove;
        const done = await setRoles(
          button,
          userId,
          rolesOfUser(userId).filter((id) => id !== role.id),
          "Role removed",
        );
        if (done) {
          closeDrawer();
          refresh();
        }
      });
  };
  if (role) drawMembers();

  const search = debounce(async () => {
    const q = form.search.value.trim();
    const results = $("#staff-role-search", body);
    if (!q) return mount(results, "");
    const found = await api(`/admin/users?${new URLSearchParams({ q, limit: 6 })}`).catch(() => ({ users: [] }));
    mount(
      results,
      (found.users ?? []).map(
        (user) => html`<div class="list-item">
          ${avatar(user)}
          <div class="grow"><strong>${userName(user)}</strong><div class="muted">${userTag(user)} · ${user.id}</div></div>
          ${
            role.members.some((member) => member.id === user.id)
              ? html`<span class="badge">Has this role</span>`
              : html`<button class="btn small" type="button" data-add="${user.id}">Add</button>`
          }
        </div>`,
      ),
    );
    for (const button of $$("[data-add]", results))
      button.addEventListener("click", async () => {
        const userId = button.dataset.add;
        const done = await setRoles(button, userId, [...rolesOfUser(userId), role.id], "Role given");
        if (done) {
          closeDrawer();
          refresh();
        }
      });
  });
  form.search?.addEventListener("input", search);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    let rights = current;
    for (const box of $$("[data-right]", form)) {
      const bit = roleBit(box.dataset.right);
      rights = box.checked ? rights | bit : rights & ~bit;
    }
    const payload = {
      name: form.name.value.trim(),
      position: Number(form.position.value),
      color: Number.parseInt(form.color.value.slice(1), 16),
      show_badge: form.show_badge.checked,
      rights: rights.toString(),
    };
    const done = await act(
      $("button[type=submit]", form),
      () =>
        role
          ? api(`/admin/staff/roles/${role.id}`, { method: "PATCH", body: payload })
          : api("/admin/staff/roles", { method: "POST", body: payload }),
      role ? "Role saved" : "Role created",
    );
    if (done) {
      closeDrawer();
      refresh();
    }
  });

  $("#staff-role-delete", body)?.addEventListener("click", async (event) => {
    const who = role.members.length ? ` ${role.members.length} ${role.members.length === 1 ? "person loses" : "people lose"} it and its rights.` : "";
    if (!await confirmDialog({ title: `Delete the "${role.name}" role?`, message: who.trim(), confirm: "Delete role" })) return;
    const done = await act(event.currentTarget, () => api(`/admin/staff/roles/${role.id}`, { method: "DELETE" }), "Role deleted");
    if (done !== undefined) {
      closeDrawer();
      refresh();
    }
  });
}

const AUDIT_TARGET_LABELS = {
  report: "Report",
  automod_action: "Automod action",
  raid: "Raid incident",
  violation: "Violation",
  role: "Role",
  ban: "Ban",
  channel: "Channel",
  message: "Message",
};

const auditUser = (user, id) =>
  user?.username
    ? html`<button class="link-button ident" type="button" data-audit-user="${user.id}">${avatar(user)}<span><strong>${userName(user)}</strong></span></button>`
    : id
      ? html`<button class="link-button" type="button" data-audit-user="${id}"><code>${id}</code></button>`
      : html`<span class="muted">None</span>`;

const auditTarget = (entry) => {
  if (!entry.target_id) return html`<span class="muted">None</span>`;
  if (entry.target_type === "user") return auditUser(entry.target, entry.target_id);
  if (entry.target_type === "guild")
    return html`<button class="link-button ident" type="button" data-audit-guild="${entry.target_id}">${guildIcon(entry.target_guild ?? { id: entry.target_id, name: "?" })}<span><strong>${entry.target_guild?.name ?? "Deleted server"}</strong><span class="muted">Server</span></span></button>`;
  return html`<span class="stack" style="gap:2px"><span class="muted">${AUDIT_TARGET_LABELS[entry.target_type] ?? "Target"}</span><code>${entry.target_id}</code></span>`;
};

const auditValue = (value) => {
  if (value === undefined) return "";
  if (Array.isArray(value)) return value.length > 5 ? `${value.slice(0, 5).join(", ")} and ${value.length - 5} more` : value.join(", ");
  if (value === null) return "none";
  return String(value);
};

const auditDetails = (entry) => {
  const parts = [];
  if (entry.options?.role_name) parts.push(html`<span class="badge">${entry.options.role_name}</span>`);
  if (entry.options?.right) parts.push(html`<span class="badge warn">Used ${entry.options.right}</span>`);
  for (const change of entry.changes ?? []) {
    const before = auditValue(change.old_value);
    const after = auditValue(change.new_value);
    parts.push(html`<div class="muted"><code>${change.key}</code> ${before ? html`was ${before}, now ${after || "none"}` : after}</div>`);
  }
  if (entry.reason) parts.push(html`<div class="muted">Reason: ${entry.reason}</div>`);
  return parts;
};

async function renderStaffAudit(view) {
  mount(
    view,
    html`
      <div class="page-head">
        <div>
          <h1>Audit log</h1>
          <p class="muted">
            Every staff action on this instance, newest first: changes from this dashboard, staff role
            changes and actions staff took with their rights elsewhere, such as deleting messages in servers
            they don't moderate.
          </p>
        </div>
      </div>
      <form id="audit-filters" class="card row" style="gap: 12px; flex-wrap: wrap; align-items: end; margin-bottom: 12px">
        <label>Area<select name="area">${STAFF_AUDIT_AREAS.map(([value, label]) => html`<option value="${value}" ${staffAuditState.area === value ? "selected" : ""}>${label}</option>`)}</select></label>
        <label>Staff member id<input name="actor_id" inputmode="numeric" value="${staffAuditState.actor_id}" placeholder="Any" /></label>
        <label>Target id<input name="target_id" inputmode="numeric" value="${staffAuditState.target_id}" placeholder="Any" /></label>
        <label>Action<input name="action" value="${staffAuditState.action}" placeholder="PATCH /admin/users/:user_id" /></label>
        <label>From<input name="after" type="date" value="${staffAuditState.after}" /></label>
        <label>Until<input name="before" type="date" value="${staffAuditState.before}" /></label>
        <button class="btn primary" type="submit">Filter</button>
        <button class="btn ghost" type="button" id="audit-clear">Clear</button>
      </form>
      <div id="audit-results"><div class="spinner">Loading…</div></div>
    `,
  );
  const form = $("#audit-filters", view);
  const results = $("#audit-results", view);
  let entries = [];
  const query = (beforeId) => {
    const params = new URLSearchParams({ limit: 50 });
    for (const [key, value] of Object.entries(staffAuditState)) if (value) params.set(key, value);
    if (staffAuditState.before) params.set("before", new Date(`${staffAuditState.before}T23:59:59.999`).toISOString());
    if (staffAuditState.after) params.set("after", new Date(`${staffAuditState.after}T00:00:00`).toISOString());
    if (beforeId) params.set("before_id", beforeId);
    return api(`/admin/audit-log?${params}`);
  };
  const draw = (hasMore) => {
    mount(
      results,
      entries.length
        ? html`<div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Staff member</th>
                    <th>Action</th>
                    <th class="hide-sm">Target</th>
                    <th class="hide-sm">Details</th>
                  </tr>
                </thead>
                <tbody>
                  ${entries.map(
                    (entry) => html`<tr>
                      <td><span title="${entry.created_at}">${fmtDate(entry.created_at)}</span></td>
                      <td>${auditUser(entry.actor, entry.actor?.id)}</td>
                      <td>
                        <strong>${STAFF_AUDIT_LABELS[entry.action] ?? entry.action}</strong>
                        <div class="muted">${entry.area}</div>
                      </td>
                      <td class="hide-sm">${auditTarget(entry)}</td>
                      <td class="hide-sm">${auditDetails(entry)}</td>
                    </tr>`,
                  )}
                </tbody>
              </table>
            </div>
            ${hasMore ? html`<div class="pager"><span class="muted">${fmtNumber(entries.length)} shown</span><button class="btn" type="button" id="audit-more">Load older</button></div>` : ""}`
        : html`<div class="card empty">No staff actions match these filters.</div>`,
    );
    for (const button of $$("[data-audit-user]", results)) button.addEventListener("click", () => openUser(button.dataset.auditUser));
    for (const button of $$("[data-audit-guild]", results)) button.addEventListener("click", () => openGuild(button.dataset.auditGuild));
    $("#audit-more", results)?.addEventListener("click", async (event) => {
      const page = await act(event.currentTarget, () => query(entries.at(-1).id));
      if (!page) return;
      entries = entries.concat(page.entries);
      draw(page.has_more);
    });
  };
  const load = async () => {
    const page = await query();
    entries = page.entries;
    draw(page.has_more);
  };
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    for (const key of Object.keys(staffAuditState)) staffAuditState[key] = form[key].value.trim();
    load().catch((error) => toast(error.message, "error"));
  });
  $("#audit-clear", view).addEventListener("click", () => {
    for (const key of Object.keys(staffAuditState)) staffAuditState[key] = "";
    renderStaffAudit(view);
  });
  await load();
}

TABS.staff = renderStaffRoles;
TABS.audit = renderStaffAudit;
