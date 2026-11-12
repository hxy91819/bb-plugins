import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { JSDOM } from "jsdom";
import { FileDownload } from "./panel.tsx";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
const keys = [
  "window",
  "document",
  "HTMLElement",
  "MutationObserver",
  "navigator",
] as const;
const descriptors = keys.map(
  (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
);
for (const key of keys)
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: dom.window[key],
  });
const { render, cleanup } =
  await import("@testing-library/react");
afterEach(cleanup);
after(() => {
  dom.window.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const source = {
  kind: "workspace" as const,
  threadId: "thread",
  environmentId: "env",
  projectId: null,
};
test("opening a file shows only the native preview without a duplicate download toolbar", () => {
  const view = render(
    <FileDownload
      path="报告 空格.html"
      source={source}
      Original={() => <main aria-label="Native file preview">Report</main>}
    />,
  );
  assert.equal(view.getByRole("main").textContent, "Report");
  assert.ok(view.queryByRole("button", { name: "Download" }) === null);
  assert.equal(view.queryByText("报告 空格.html"), null);
});
