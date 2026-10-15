export async function mountUserCustomization(container, user, { api, toast, editable = true }) {
  const card = document.createElement("section");
  card.className = "card stack";
  card.setAttribute("aria-label", "User customization");
  card.innerHTML =
    '<h3>User customization</h3><p class="muted">Profile badges, widget layout and client preferences. Changes apply to this account and are recorded in the customization history.</p><p role="status">Loading customization…</p>';
  const anchor = container.querySelector("#standing-card");
  if (anchor) anchor.before(card);
  else container.append(card);
  const request = (section, options) => api(`/admin/users/${user.id}/${section}`, options);
  const element = (tag, text, cls) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  };
  const form = (title, action, save) => {
    const form = element("form", "", "stack");
    form.append(element("h4", title));
    for (const event of ["input", "change"])
      form.addEventListener(event, () => {
        form.dataset.dirty = "true";
      });
    const button = element("button", action, "btn primary");
    button.type = "submit";
    const status = element("p", "", "hint");
    status.setAttribute("role", "status");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      button.disabled = true;
      status.textContent = "Saving…";
      try {
        await save(form);
        delete form.dataset.dirty;
        status.textContent = "Changes saved";
        toast("User customization saved");
      } catch (error) {
        status.textContent = error.message || "Could not save these changes. Try again.";
      } finally {
        button.disabled = false;
      }
    });
    if (editable) form.append(button, status);
    card.append(form);
    return form;
  };
  const field = (form, name, title, value, choices) => {
    const label = element("label", title);
    const input = element(choices ? "select" : "input");
    input.name = name;
    if (choices)
      for (const [value, title] of choices) {
        const option = element("option", title);
        option.value = value;
        input.append(option);
      }
    input.value = value ?? "";
    label.append(input);
    form.insertBefore(label, form.querySelector("button"));
    return input;
  };
  try {
    const [pride, widgetData, settings] = await Promise.all([
      request("pride-badges"),
      request("widgets"),
      user.bot ? Promise.resolve(null) : request("settings"),
    ]);
    if (!card.isConnected) return;
    card.querySelector("[role=status]").remove();
    const prideForm = form("Pride badges", "Save pride badges", (form) =>
      request("pride-badges", {
        method: "PATCH",
        body: { flags: [...form.querySelectorAll("input:checked")].map((input) => input.value) },
      }),
    );
    const prideGrid = element("div", "", "checks");
    for (const flag of pride.catalog) {
      const label = element("label", "", "toggle");
      const input = element("input");
      input.type = "checkbox";
      input.value = flag.slug;
      input.checked = pride.flags.includes(flag.slug);
      const image = element("img");
      image.src = flag.icon_url || `/badge-icons/${flag.icon}.png`;
      image.alt = "";
      image.width = 32;
      image.height = 24;
      image.style.objectFit = "contain";
      label.append(input, image, element("span", flag.description));
      prideGrid.append(label);
    }
    prideForm.insertBefore(prideGrid, prideForm.querySelector("button"));
    const widgetForm = form("Profile widgets", "Save widget layout", (form) => {
      const widgets = JSON.parse(form.elements.widgets.value);
      if (!Array.isArray(widgets)) throw new Error("Enter a JSON array of profile widgets.");
      return request("widgets", { method: "PUT", body: { widgets } });
    });
    const widgetLabel = element("label", "Widget layout JSON");
    const widgetInput = element("textarea");
    widgetInput.name = "widgets";
    widgetInput.rows = 8;
    widgetInput.value = JSON.stringify(widgetData.widgets, null, 2);
    widgetLabel.append(
      widgetInput,
      element(
        "span",
        "Up to 12 widgets. Application widgets still require this user's normal eligibility. An empty array removes the layout.",
        "hint",
      ),
    );
    widgetForm.insertBefore(widgetLabel, widgetForm.querySelector("button"));
    if (settings) {
      const preferenceForm = form("Client preferences", "Save client preferences", (form) => {
        const patch = JSON.parse(form.elements.advanced.value || "{}");
        if (!patch || Array.isArray(patch) || typeof patch !== "object")
          throw new Error("Additional preferences must be a JSON object.");
        for (const name of ["theme", "locale", "status"]) patch[name] = form.elements[name].value;
        for (const input of form.querySelectorAll("input[type=checkbox]"))
          patch[input.name] = input.checked;
        return request("settings", { method: "PATCH", body: patch });
      });
      field(preferenceForm, "theme", "Theme", settings.theme, [
        ["dark", "Dark"],
        ["light", "Light"],
        ["darker", "Darker"],
        ["midnight", "Midnight"],
      ]);
      field(preferenceForm, "locale", "Language code", settings.locale);
      field(preferenceForm, "status", "Presence", settings.status, [
        ["online", "Online"],
        ["idle", "Idle"],
        ["dnd", "Do not disturb"],
        ["invisible", "Invisible"],
        ["offline", "Offline"],
      ]);
      for (const [name, title] of [
        ["animate_emoji", "Animate emoji"],
        ["render_embeds", "Show link previews"],
        ["render_reactions", "Show reactions"],
        ["inline_attachment_media", "Show attachment previews"],
        ["inline_embed_media", "Show embedded media"],
        ["message_display_compact", "Use compact messages"],
        ["enable_tts_command", "Enable text-to-speech commands"],
      ]) {
        const label = element("label", "", "toggle");
        const input = element("input");
        input.type = "checkbox";
        input.name = name;
        input.checked = !!settings[name];
        label.append(input, element("span", title));
        preferenceForm.insertBefore(label, preferenceForm.querySelector("button"));
      }
      const advancedLabel = element("label", "Additional preference changes (JSON)");
      const advanced = element("textarea");
      advanced.name = "advanced";
      advanced.rows = 4;
      advanced.value = "{}";
      advancedLabel.append(
        advanced,
        element(
          "span",
          "Uses the same validated preference fields as the native client. Account secrets and encryption keys are excluded.",
          "hint",
        ),
      );
      preferenceForm.insertBefore(advancedLabel, preferenceForm.querySelector("button"));
    }
    if (!editable)
      for (const control of card.querySelectorAll("form input, form select, form textarea")) control.disabled = true;
    const history = element("details", "", "stack");
    history.append(element("summary", "Customization history"));
    const refresh = element("button", "Refresh customization history", "btn ghost");
    refresh.type = "button";
    const list = element("div", "", "list");
    refresh.addEventListener("click", async () => {
      refresh.disabled = true;
      try {
        const { entries } = await request("customization-audit");
        list.replaceChildren(
          ...entries.map((entry) =>
            element(
              "p",
              `${entry.options?.type || "Customization"} · actor ${entry.user_id} · entry ${entry.id}${entry.reason ? ` · ${entry.reason}` : ""}`,
              "muted",
            ),
          ),
        );
        if (!entries.length)
          list.append(element("p", "No customization changes recorded yet.", "muted"));
      } catch (error) {
        list.textContent = error.message;
      } finally {
        refresh.disabled = false;
      }
    });
    history.append(refresh, list);
    card.append(history);
  } catch (error) {
    if (card.isConnected)
      card.querySelector("[role=status]").textContent =
        error.message || "Could not load user customization.";
  }
}
