import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { chromium, webkit, expect } from "@playwright/test";
import ts from "typescript";

const source = ts.transpileModule(
  await readFile(new URL("./compact-tabs.ts", import.meta.url), "utf8"),
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  },
).outputText;
const providers = [
  {
    id: "codex",
    displayName: "Codex",
    pluginId: "provider-codex",
    logoUrl: "/api/v1/system/providers/codex/logo?h=openai",
  },
  {
    id: "codex-l",
    displayName: "Codex · L",
    pluginId: "provider-codex",
    logoUrl: "/api/v1/system/providers/codex-l/logo?h=openai",
  },
  {
    id: "codex-b",
    displayName: "Codex · B",
    pluginId: "provider-codex",
    logoUrl: "/api/v1/system/providers/codex-b/logo?h=openai",
  },
  {
    id: "claude-code",
    displayName: "Claude Code",
    pluginId: "provider-claude-code",
    logoUrl: "/api/v1/system/providers/claude-code/logo?h=claude",
  },
  {
    id: "alpha",
    displayName: "Alpha",
    pluginId: "acp",
    logoUrl: null,
    icon: { glyph: "Toolbox" },
  },
  {
    id: "beta",
    displayName: "Beta",
    pluginId: "acp",
    logoUrl: null,
    icon: { glyph: "Toolbox" },
  },
];
const tabs = providers
  .map(
    (p) =>
      `<button type="button" title="${p.displayName}" aria-label="${p.displayName}" class="border-b-2" onclick="window.selected=this.title"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="12" cy="12" r="10"/></svg><span>${p.displayName}</span></button>`,
  )
  .join("");

for (const [name, engine] of Object.entries({ chromium, webkit })) {
  test(`${name}: compact profiles preserve selection, identity and cleanup across menu changes`, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<base href="http://localhost/"><style>html{color-scheme:light}button{display:inline-flex;align-items:center;min-width:100px;padding:6px;gap:6px}</style><div id="tabs">${tabs}</div><button title="Codex" id="unrelated">Other control</button>`,
      );
      await page.addScriptTag({
        type: "module",
        content: `${source}\nwindow.compact = mountCompactProviderTabs(document);`,
      });
      await page.waitForFunction(() => !!window.compact);
      await page.evaluate((p) => window.compact.update(p), providers);
      const codex = page.getByRole("button", { name: "Codex", exact: true });
      const profile = page.getByRole("button", {
        name: "Codex · L",
        exact: true,
      });
      await expect(profile.locator("span")).toBeHidden();
      expect((await profile.boundingBox()).width).toBe(32);
      await profile.click();
      expect(await page.evaluate(() => window.selected)).toBe("Codex · L");
      const colors = await page
        .locator("#tabs svg")
        .evaluateAll((icons) =>
          icons.map((icon) => getComputedStyle(icon).color),
        );
      expect(new Set(colors.slice(0, 3)).size).toBe(3);
      await expect(page.locator("#unrelated")).not.toHaveAttribute(
        "data-acp-profile-tab",
      );
      await expect(
        page.getByRole("button", { name: "Claude Code", exact: true }),
      ).not.toHaveAttribute("data-acp-profile-hue");
      await page.evaluate(
        () => (document.documentElement.style.colorScheme = "dark"),
      );
      expect(
        await profile
          .locator("svg")
          .evaluate((icon) => getComputedStyle(icon).color),
      ).not.toBe(colors[1]);
      const glyphColors = await page
        .locator("#tabs svg")
        .evaluateAll((icons) =>
          icons.slice(-2).map((icon) => getComputedStyle(icon).color),
        );
      expect(new Set(glyphColors).size).toBe(2);
      const unrelatedTabWrites = await page.evaluate(async () => {
        let writes = 0;
        const watcher = new MutationObserver((records) => {
          writes += records.length;
        });
        watcher.observe(document.querySelector("#tabs"), {
          attributes: true,
          subtree: true,
        });
        const transcript = document.createElement("main");
        const text = document.createTextNode("");
        transcript.append(text);
        document.body.append(transcript);
        for (let index = 0; index < 30; index++) {
          text.data += " token";
          transcript.className = `stream-${index}`;
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        watcher.disconnect();
        transcript.remove();
        return writes;
      });
      expect(unrelatedTabWrites).toBe(0);
      const hue = await profile.getAttribute("data-acp-profile-hue");
      await page.evaluate(
        () => (document.querySelector("#tabs").innerHTML = ""),
      );
      await page.evaluate(
        (html) => (document.querySelector("#tabs").innerHTML = html),
        tabs,
      );
      await expect(profile).toHaveAttribute("data-acp-profile-hue", hue);
      await page.evaluate(
        () =>
          (document.querySelector("#tabs button").title =
            "Codex (current thread)"),
      );
      await expect(codex).toHaveAttribute("aria-label", "Codex");
      await page.evaluate(() => window.compact.update([]));
      await expect(profile.locator("span")).toBeVisible();
      await page.evaluate((p) => window.compact.update(p), providers);
      await page.evaluate(() => window.compact.dispose());
      await expect(profile.locator("span")).toBeVisible();
      expect((await profile.boundingBox()).width).toBeGreaterThan(32);
      await expect(profile).not.toHaveAttribute("data-acp-profile-tab");
      await expect(profile).toHaveAttribute("aria-label", "Codex · L");
    } finally {
      await browser.close();
    }
  });
}
