type Provider = {
  id: string;
  displayName: string;
  pluginId: string | null;
  logoUrl: string | null;
  icon?: { glyph: string };
};

const tabSelector = "button[title].border-b-2";
const marker = "data-acp-profile-tab";

export function mountCompactProviderTabs(document: Document) {
  let byLabel = new Map<string, Provider>();
  let hues = new Map<string, number>();
  const rows = new Map<HTMLElement, MutationObserver>();
  const touched = new Map<HTMLElement, string | null>();
  const style = document.createElement("style");
  style.textContent = `
:where([${marker}]) {
  width: 2rem !important;
  min-width: 2rem !important;
  flex: 0 0 2rem !important;
  padding-inline: 0 !important;
  gap: 0 !important;
}
:where([${marker}]) > span:last-child:not(:first-child) { display: none !important; }
:where([${marker}][data-acp-profile-hue]) > :first-child {
  color: var(--acp-profile-color) !important;
}
`;
  document.head.appendChild(style);

  const restore = (tab: HTMLElement) => {
    tab.removeAttribute(marker);
    tab.removeAttribute("data-acp-profile-hue");
    tab.style.removeProperty("--acp-profile-color");
    const label = touched.get(tab);
    if (label === null) tab.removeAttribute("aria-label");

    touched.delete(tab);
  };

  const updateCatalog = (providers: readonly Provider[]) => {
    byLabel = new Map(
      providers.map((provider) => [provider.displayName, provider]),
    );
    const groups = new Map<string, Provider[]>();
    for (const provider of providers) {
      const hash = provider.logoUrl
        ? new URL(provider.logoUrl, document.baseURI).searchParams.get("h")
        : null;
      const key = `${provider.pluginId}:${hash ?? provider.icon?.glyph ?? provider.displayName.split(" · ")[0]}`;
      const group = groups.get(key) ?? [];
      group.push(provider);
      groups.set(key, group);
    }
    hues = new Map<string, number>();
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      for (const provider of group) {
        let hash = 0;
        for (const char of provider.id)
          hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
        hues.set(provider.id, hash % 360);
      }
      const used: number[] = [];
      for (const provider of [...group].sort((a, b) =>
        a.id.localeCompare(b.id),
      )) {
        let hue = hues.get(provider.id)!;
        for (
          let attempt = 0;
          attempt < 24 &&
          used.some(
            (other) =>
              Math.min(Math.abs(hue - other), 360 - Math.abs(hue - other)) < 45,
          );
          attempt++
        )
          hue = (hue + 137) % 360;
        used.push(hue);
        hues.set(provider.id, hue);
      }
    }
  };

  const refresh = (row: HTMLElement) => {
    const active = new Set<HTMLElement>();
    for (const tab of Array.from(
      row.querySelectorAll<HTMLElement>(`:scope > ${tabSelector}`),
    )) {
      const label = tab.title.replace(/ \(current thread\)$/, "");
      const provider = byLabel.get(label);
      if (
        !provider ||
        !tab.firstElementChild ||
        !tab.parentElement ||
        !Array.from(tab.parentElement.children).every((child) =>
          child.matches(tabSelector),
        )
      )
        continue;
      active.add(tab);
      if (!touched.has(tab)) touched.set(tab, tab.getAttribute("aria-label"));
      tab.setAttribute(marker, "");
      if (touched.get(tab) === null) tab.setAttribute("aria-label", tab.title);
      const hue = hues.get(provider.id);
      if (hue !== undefined) {
        tab.setAttribute("data-acp-profile-hue", String(hue));
        tab.style.setProperty(
          "--acp-profile-color",
          `light-dark(oklch(0.48 0.17 ${hue}), oklch(0.78 0.14 ${hue}))`,
        );
      } else {
        tab.removeAttribute("data-acp-profile-hue");
        tab.style.removeProperty("--acp-profile-color");
      }
    }
    for (const tab of touched.keys())
      if (tab.parentElement === row && !active.has(tab)) restore(tab);
  };
  const discover = (root: Element | Document) => {
    const candidates =
      root instanceof Element && root.matches(tabSelector)
        ? [root]
        : Array.from(root.querySelectorAll<HTMLElement>(tabSelector));
    for (const tab of candidates) {
      const row = tab.parentElement;
      if (!row || rows.has(row)) continue;
      const observer = new MutationObserver(() => refresh(row));
      observer.observe(row, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["title", "class"],
      });
      rows.set(row, observer);
      refresh(row);
    }
  };
  const observer = new MutationObserver((records) => {
    for (const [row, watcher] of rows) {
      if (!row.isConnected) {
        watcher.disconnect();
        rows.delete(row);
      }
    }
    for (const tab of touched.keys())
      if (
        !tab.isConnected ||
        !tab.parentElement ||
        !rows.has(tab.parentElement)
      )
        restore(tab);
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        if (!(node instanceof Element) || !node.isConnected) continue;
        if (Array.from(rows.keys()).some((row) => row.contains(node))) continue;
        discover(node);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  discover(document);
  return {
    update(next: readonly Provider[]) {
      updateCatalog(next);
      for (const row of rows.keys()) refresh(row);
    },
    dispose() {
      observer.disconnect();
      for (const watcher of rows.values()) watcher.disconnect();
      rows.clear();
      for (const tab of touched.keys()) restore(tab);
      style.remove();
    },
  };
}
