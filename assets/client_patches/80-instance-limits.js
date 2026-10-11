(() => {
  const readEnv = () => window.GLOBAL_ENV?.INSTANCE_LIMITS ?? null;
  let limits = readEnv();
  if (!limits) {
    fetch(`${location.origin}/policies/instance/config`, { credentials: "same-origin" })
      .then((res) => (res.ok ? res.json() : null))
      .then((config) => {
        if (config?.limits) {
          limits = config.limits;
          scan(document);
        }
      })
      .catch(() => {});
  }
  const current = () => limits ?? readEnv() ?? {};
  const labelledBy = (el) =>
    (el.getAttribute?.("aria-labelledby") ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
  const textOf = (el) =>
    [el.getAttribute?.("name"), el.getAttribute?.("aria-label"), labelledBy(el), el.getAttribute?.("placeholder"), el.id, el.labels?.[0]?.textContent]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  const rules = [
    { defaults: [190], match: /bio|about me/, value: () => current().user?.maxBio },
    { defaults: [40], match: /pronoun/, value: () => current().user?.maxPronouns },
    { defaults: [32], match: /username/, value: () => current().user?.maxUsername },
    { defaults: [32], match: /display name|global name/, value: () => current().user?.maxUsername },
    { defaults: [100], match: /channel name/, value: () => current().channel?.maxName },
    { defaults: [1024], match: /topic/, value: () => current().channel?.maxTopic },
  ];
  const apply = (el) => {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
    const currentMax = el.maxLength;
    if (currentMax <= 0 || currentMax > 100000) return;
    const text = textOf(el);
    for (const rule of rules) {
      if (!rule.defaults.includes(currentMax) || !rule.match.test(text)) continue;
      const next = rule.value();
      if (typeof next === "number" && Number.isSafeInteger(next) && next > 0 && next !== currentMax) el.maxLength = next;
      return;
    }
  };
  const scan = (root) => {
    if (root instanceof HTMLInputElement || root instanceof HTMLTextAreaElement) apply(root);
    for (const el of root.querySelectorAll?.("input[maxlength], textarea[maxlength]") ?? []) apply(el);
    for (const el of root.querySelectorAll?.('[role="alert"]') ?? []) fixErrorLabel(el);
    if (root instanceof Element && root.getAttribute?.("role") === "alert") fixErrorLabel(root);
    pruneStickerTiers(root);
  };
  const fixErrorLabel = (el) => {
    const text = el.textContent ?? "";
    const found = /must be (\d+) characters or fewer in length/i.exec(text);
    if (!found) return;
    const shown = Number(found[1]);
    for (const field of fieldsForAlert(el)) {
      const context = textOf(field);
      for (const rule of rules) {
        if (!rule.defaults.includes(shown) || !rule.match.test(context)) continue;
        const next = rule.value();
        if (typeof next !== "number" || !Number.isSafeInteger(next) || next <= 0 || next === shown) return;
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node) {
          const value = node.nodeValue ?? "";
          const hit = /must be (\d+) characters or fewer in length/i.exec(value);
          if (hit && Number(hit[1]) === shown) {
            node.nodeValue = value.replace(hit[1], String(next));
            return;
          }
          node = walker.nextNode();
        }
        return;
      }
    }
  };
  const fieldsForAlert = (el) => {
    const fields = [];
    if (el.id) {
      const described = document.querySelector?.(`[aria-describedby~="${CSS.escape(el.id)}"]`);
      if (described instanceof HTMLInputElement || described instanceof HTMLTextAreaElement) fields.push(described);
    }
    let scope = el;
    for (let depth = 0; depth < 4 && scope.parentElement; depth++) {
      scope = scope.parentElement;
      for (const field of scope.querySelectorAll?.("input, textarea") ?? []) {
        if (!fields.includes(field)) fields.push(field);
      }
    }
    return fields;
  };
  const pruneStickerTiers = (root) => {
    const maxStickers = current().guild?.maxStickers;
    if (typeof maxStickers !== "number" || !Number.isSafeInteger(maxStickers) || maxStickers <= 0 || maxStickers === 5) return;
    const tab =
      root instanceof Element && root.id === "stickers-tab"
        ? root
        : (root.querySelector?.('[id="stickers-tab"]') ?? root.closest?.('[id="stickers-tab"]') ?? null);
    if (!tab) return;
    for (const heading of tab.querySelectorAll("h2")) {
      if (!/^level [123]$/i.test(heading.textContent.trim())) continue;
      let block = heading;
      let target = null;
      while (block.parentElement && block.parentElement !== tab) {
        block = block.parentElement;
        const text = block.textContent;
        if (!text.includes("slots available")) continue;
        if (text.includes("Free Slots") || (text.match(/level [123]/gi) ?? []).length > 1) break;
        target = block;
      }
      if (target && target.style.display !== "none") target.style.display = "none";
    }
  };
  new MutationObserver((entries) => {
    for (const entry of entries) {
      if (entry.type === "attributes") apply(entry.target);
      for (const node of entry.addedNodes) if (node instanceof Element) scan(node);
    }
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["maxlength"] });
  scan(document);
})();
