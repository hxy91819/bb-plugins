import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { useEffect } from "react";
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
const { render, fireEvent, waitFor, cleanup, act } =
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
const request = {
  fileName: "报告 空格.html",
  blob: new Blob(["\uFEFF<html>原始\r\n</html>"]),
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// This is the exact view mounted by the SDK opener. Original stands in for BB's
// bound preview; DOM identity/effect counts expose any re-mount on download.
test("normal open immediately retains preview; explicit download preserves preview state and mounts", async () => {
  let mounts = 0,
    reads = 0;
  function Original() {
    useEffect(() => {
      mounts++;
    }, []);
    return (
      <textarea aria-label="Original preview" defaultValue="existing preview" />
    );
  }
  const reading = deferred<typeof request>();
  const saved: (typeof request)[] = [];
  const props = {
    path: request.fileName,
    source,
    Original,
    prepare: async () => {
      reads++;
      return reading.promise;
    },
    save: async (value: typeof request) => {
      saved.push(value);
      return "started" as const;
    },
  };
  const view = render(<FileDownload {...props} />);
  const preview = view.getByRole("textbox", { name: "Original preview" });
  fireEvent.change(preview, {
    target: { value: "retained selection / state" },
  });
  assert.equal(reads, 0);
  assert.equal(saved.length, 0);
  assert.equal(mounts, 1);
  const button = view.getByRole("button", { name: "Download" });
  fireEvent.click(button);
  fireEvent.click(button);
  assert.equal(reads, 1);
  assert.equal((button as HTMLButtonElement).disabled, true);
  // Parent rerenders (including a new source object) must also retain preview.
  view.rerender(<FileDownload {...props} source={{ ...source }} />);
  await act(async () => reading.resolve(request));
  await waitFor(() => assert.equal(saved.length, 1));
  assert.equal(saved[0].fileName, request.fileName);
  assert.deepEqual(
    Buffer.from(await saved[0].blob.arrayBuffer()),
    Buffer.from(await request.blob.arrayBuffer()),
  );
  assert.equal(view.getByRole("textbox"), preview);
  assert.equal(
    (preview as HTMLTextAreaElement).value,
    "retained selection / state",
  );
  assert.equal(mounts, 1);
  assert.match(
    view.getByRole("status").textContent!,
    /handed to your browser or device/,
  );
  assert.equal((button as HTMLButtonElement).disabled, false);
});

test("read failures and save-start failures remain visible and retryable while preview stays mounted", async () => {
  let attempts = 0,
    saves = 0,
    mounts = 0;
  function Original() {
    useEffect(() => {
      mounts++;
    }, []);
    return <p>BB original preview</p>;
  }
  const view = render(
    <FileDownload
      path="report.html"
      source={source}
      Original={Original}
      prepare={async () => {
        if (++attempts === 1) throw new Error("Host offline");
        return request;
      }}
      save={async () => {
        saves++;
        return "failed";
      }}
    />,
  );
  fireEvent.click(view.getByRole("button", { name: "Download" }));
  await waitFor(() =>
    assert.match(view.getByRole("status").textContent!, /Host offline/),
  );
  assert.equal(saves, 0);
  fireEvent.click(view.getByRole("button", { name: "Download" }));
  await waitFor(() =>
    assert.match(view.getByRole("status").textContent!, /could not start/),
  );
  assert.equal(saves, 1);
  assert.equal(mounts, 1);
  assert.ok(view.getByText("BB original preview"));
  assert.equal((view.getByRole("button") as HTMLButtonElement).disabled, false);
});

test("file/host change aborts the prior read and its late result cannot download or affect the new preview", async () => {
  const first = deferred<typeof request>();
  const signals: AbortSignal[] = [];
  let saves = 0;
  const props = {
    path: "report.html",
    source,
    Original: () => <p>Original</p>,
    prepare: async (signal: AbortSignal) => {
      signals.push(signal);
      return first.promise;
    },
    save: async () => {
      saves++;
      return "started" as const;
    },
  };
  const view = render(<FileDownload {...props} />);
  fireEvent.click(view.getByRole("button", { name: "Download" }));
  view.rerender(
    <FileDownload
      {...props}
      source={{ ...source, experimental_hostId: "other" }}
    />,
  );
  assert.equal(signals[0].aborted, true);
  assert.equal(
    (view.getByRole("button", { name: "Download" }) as HTMLButtonElement)
      .disabled,
    false,
  );
  await act(async () => first.resolve(request));
  assert.equal(saves, 0);
  assert.equal(view.getByRole("status").textContent, "");
});

test("closing a pending panel aborts the read and suppresses a late download", async () => {
  const reading = deferred<typeof request>();
  let pendingSignal: AbortSignal | undefined;
  let saves = 0;
  const view = render(
    <FileDownload
      path="report.html"
      source={source}
      Original={() => <p>Original</p>}
      prepare={async (signal) => {
        pendingSignal = signal;
        return reading.promise;
      }}
      save={async () => {
        saves++;
        return "started";
      }}
    />,
  );
  fireEvent.click(view.getByRole("button", { name: "Download" }));
  view.unmount();
  assert.equal(pendingSignal?.aborted, true);
  await act(async () => reading.resolve(request));
  assert.equal(saves, 0);
});
