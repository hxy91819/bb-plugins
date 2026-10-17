import { test, expect } from "vitest";
import { createIdentityStore } from "../src/identity.js";
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
    removeItem: (k: string) => {
      values.delete(k);
    },
  };
}
test("persistent defaults, pinned windows, null, restore, forget and server partitioning", () => {
  const local = storage(),
    aSession = storage(),
    bSession = storage();
  const a = createIdentityStore(
    "server-a",
    () => local,
    () => aSession,
  );
  a.select("A", true);
  const b = createIdentityStore(
    "server-a",
    () => local,
    () => bSession,
  );
  expect(b.getSnapshot().memberId).toBe("A");
  b.select("B", false);
  expect(a.getSnapshot().memberId).toBe("A");
  expect(
    createIdentityStore(
      "server-a",
      () => local,
      () => bSession,
    ).getSnapshot().memberId,
  ).toBe("B");
  a.select("C", true);
  expect(b.getSnapshot().memberId).toBe("B");
  b.select(null, false);
  expect(
    createIdentityStore(
      "server-a",
      () => local,
      () => bSession,
    ).getSnapshot().memberId,
  ).toBeNull();
  b.restoreDefault();
  expect(b.getSnapshot().memberId).toBe("C");
  b.forgetDefault();
  expect(b.getSnapshot().memberId).toBeNull();
  expect(a.getSnapshot().memberId).toBe("C");
  expect(
    createIdentityStore(
      "server-a",
      () => local,
      () => storage(),
    ).getSnapshot().memberId,
  ).toBeNull();
  expect(
    createIdentityStore(
      "server-b",
      () => local,
      () => storage(),
    ).getSnapshot().memberId,
  ).toBeNull();
});
test("unavailable browser storage retains current-window identity and reports loss of persistence", () => {
  const unavailable = () => {
    throw Error("denied");
  };
  const window = createIdentityStore("server", unavailable, unavailable);
  window.select("A", true);
  expect(window.getSnapshot().memberId).toBe("A");
  expect(window.getSnapshot().warning).toContain("内存");
  window.select("B", false);
  window.restoreDefault();
  expect(window.getSnapshot().memberId).toBe("A");
  window.select(null, false);
  expect(window.getSnapshot().memberId).toBeNull();
});

test("a readable but unwritable store preserves the remembered in-memory default", () => {
  const persisted = storage();
  let failed = false;
  const local = {
    getItem: persisted.getItem,
    setItem: (key: string, value: string) => {
      if (failed) throw Error("quota");
      persisted.setItem(key, value);
    },
    removeItem: (key: string) => {
      if (failed) throw Error("quota");
      persisted.removeItem(key);
    },
  };
  const identity = createIdentityStore(
    "quota",
    () => local,
    () => storage(),
  );
  identity.select("Persisted", true);
  failed = true;
  identity.select("A", true);
  identity.select("B", false);
  identity.restoreDefault();
  expect(identity.getSnapshot().memberId).toBe("A");
  identity.forgetDefault();
  identity.restoreDefault();
  expect(identity.getSnapshot().memberId).toBeNull();
});
