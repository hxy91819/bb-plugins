import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareDownload } from "./download.ts";
import type { PluginFileOpenerSource } from "@get-bb/plugin-sdk/app";

const source = (
  overrides: Partial<PluginFileOpenerSource> = {},
): PluginFileOpenerSource => ({
  kind: "workspace",
  threadId: "thread",
  environmentId: "env",
  projectId: null,
  ...overrides,
});
const signal = () => new AbortController().signal;
type Read = {
  hostId: string;
  path: string;
  rootPath?: string;
  signal: AbortSignal;
};
function fixture(
  read: (request: Read) => unknown,
  extra: Record<string, unknown> = {},
) {
  return {
    files: { read },
    environments: {
      get: async () => ({
        hostId: "remote",
        path: "/work tree",
        status: "ready",
      }),
    },
    projects: {
      get: async () => ({
        sources: [
          { type: "local_path", hostId: "primary", path: "/primary" },
          { type: "local_path", hostId: "remote", path: "/remote" },
        ],
      }),
    },
    system: { config: async () => ({ primaryHostId: "primary" }) },
    threads: {
      storageLocation: async () => ({
        hostId: "storage-host",
        storageRootPath: "/storage/thread",
      }),
    },
    ...extra,
  } as unknown as Parameters<typeof prepareDownload>[0];
}
function transport(bytes: Uint8Array, encoding: "utf8" | "base64") {
  return {
    content: Buffer.from(bytes).toString(
      encoding === "utf8" ? "utf8" : "base64",
    ),
    contentEncoding: encoding,
    sizeBytes: bytes.length,
  };
}

test("HTML download preserves Chinese/spaced name, BOM, CRLF and script bytes", async () => {
  const bytes = Buffer.from(
    '\uFEFF<!doctype html>\r\n<script>throw "不应执行"</script>\r\n',
  );
  const sdk = fixture(({ hostId, rootPath, path }) => {
    assert.equal(hostId, "remote");
    assert.equal(rootPath, "/work tree");
    assert.equal(path, "/work tree/报告 空格 #%.html");
    return transport(bytes, "utf8");
  });
  const request = await prepareDownload(
    sdk,
    "报告 空格 #%.html",
    source(),
    signal(),
  );
  assert.equal(request.fileName, "报告 空格 #%.html");
  assert.equal(request.blob.type, "application/octet-stream");
  assert.deepEqual(Buffer.from(await request.blob.arrayBuffer()), bytes);
});

test("non-UTF8 HTML and binary files preserve every byte", async () => {
  for (const bytes of [Buffer.from([0, 255, 128, 13, 10]), Buffer.alloc(0)]) {
    const result = await prepareDownload(
      fixture(() => transport(bytes, "base64")),
      "报告.html",
      source(),
      signal(),
    );
    assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), bytes);
  }
});

test("project checkout uses explicit host, or BB primary host rather than default source order", async () => {
  for (const hostId of ["remote", undefined]) {
    const sdk = fixture((request) => {
      assert.equal(request.hostId, hostId ?? "primary");
      assert.equal(request.path, `/${hostId ?? "primary"}/report.html`);
      return transport(Buffer.from(request.hostId), "utf8");
    });
    const result = await prepareDownload(
      sdk,
      "report.html",
      source({
        environmentId: null,
        projectId: "project",
        experimental_hostId: hostId,
      }),
      signal(),
    );
    assert.equal(await result.blob.text(), hostId ?? "primary");
  }
});

test("thread storage uses its storage host and root, independent of environment host", async () => {
  const sdk = fixture((request) => {
    assert.equal(request.hostId, "storage-host");
    assert.equal(request.rootPath, "/storage/thread");
    assert.equal(request.path, "/storage/thread/Attachments/报告 空格.html");
    return transport(Buffer.from("storage"), "utf8");
  });
  await prepareDownload(
    sdk,
    "Attachments/报告 空格.html",
    source({ kind: "thread-storage" }),
    signal(),
  );
});

test("absolute host files support explicit host and environment host, without primary fallback", async () => {
  for (const explicit of ["selected", undefined]) {
    const sdk = fixture((request) => {
      assert.equal(request.hostId, explicit ?? "remote");
      assert.equal(request.path, "/data/output/report.html");
      return transport(Buffer.from("host"), "utf8");
    });
    await prepareDownload(
      sdk,
      "/data/output/report.html",
      source({ kind: "host", experimental_hostId: explicit }),
      signal(),
    );
  }
  await assert.rejects(
    prepareDownload(
      fixture(() => assert.fail("must not read")),
      "/report.html",
      source({ kind: "host", environmentId: null }),
      signal(),
    ),
    /host is unavailable/,
  );
});

test("Windows workspace and Unicode basename retain the selected host path", async () => {
  const sdk = fixture(
    (request) => {
      assert.equal(request.path, "C:\\work tree\\报告 空格.html");
      assert.equal(request.rootPath, "C:\\work tree");
      return transport(Buffer.from("windows"), "utf8");
    },
    {
      environments: {
        get: async () => ({
          hostId: "windows",
          path: "C:\\work tree",
          status: "ready",
        }),
      },
    },
  );
  const result = await prepareDownload(
    sdk,
    "报告 空格.html",
    source(),
    signal(),
  );
  assert.equal(result.fileName, "报告 空格.html");
});

test("relative traversal and absolute workspace inputs never reach file reads", async () => {
  for (const path of [
    "../secret.html",
    "/etc/report.html",
    "a/../report.html",
    "a\\..\\report.html",
    "C:\\report.html",
    "a\0.html",
  ]) {
    await assert.rejects(
      prepareDownload(
        fixture(() => assert.fail("must not read")),
        path,
        source(),
        signal(),
      ),
      /Invalid/,
    );
  }
});

test("permission, symlink escape, offline, missing and too-large errors remain visible to the caller", async () => {
  for (const message of [
    "Permission denied",
    "Path escapes read root",
    "Host offline",
    "File not found",
    "File exceeds 25 MB limit",
  ]) {
    await assert.rejects(
      prepareDownload(
        fixture(() => {
          throw new Error(message);
        }),
        "report.html",
        source(),
        signal(),
      ),
      (error: Error) => error.message === message,
    );
  }
});

test("unready workspace, missing checkout, partial data and cancellation never produce downloads", async () => {
  await assert.rejects(
    prepareDownload(
      fixture(() => assert.fail("must not read"), {
        environments: {
          get: async () => ({ status: "destroyed", path: null }),
        },
      }),
      "report.html",
      source(),
      signal(),
    ),
    /not ready/,
  );
  await assert.rejects(
    prepareDownload(
      fixture(() => assert.fail("must not read")),
      "report.html",
      source({
        environmentId: null,
        projectId: "project",
        experimental_hostId: "missing",
      }),
      signal(),
    ),
    /no checkout/,
  );
  await assert.rejects(
    prepareDownload(
      fixture(() => ({
        content: "partial",
        contentEncoding: "utf8",
        sizeBytes: 100,
      })),
      "report.html",
      source(),
      signal(),
    ),
    /size changed/,
  );
  const controller = new AbortController();
  const sdk = fixture(() => {
    controller.abort();
    return transport(Buffer.from("data"), "utf8");
  });
  await assert.rejects(
    prepareDownload(sdk, "report.html", source(), controller.signal),
    /aborted/,
  );
});
