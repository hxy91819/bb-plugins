import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createFakePluginHost,
  makeHostResponse,
} from "@get-bb/plugin-sdk/testing";
import type { ServerAccessGrant } from "@get-bb/plugin-sdk";
import plugin from "./server.js";

function fixture() {
  const removed = new Set<string>();
  const host = createFakePluginHost({
    pluginId: "machine-gateway",
    settings: { gatewayUrl: "https://gateway.example.com" },
    sdk: {
      hosts: {
        get: async ({ hostId }) => {
          const host = makeHostResponse({ id: hostId });
          if (removed.has(hostId)) host.lifecycle.phase = "removing";
          return {
            ...host,
            connectMachineId: null,
            threadStorageRootPath: null,
          };
        },
      },
    },
  });
  return { ...host, removed };
}

function requireGrant(
  grant: ServerAccessGrant | { status: "failed"; message: string },
): ServerAccessGrant {
  if ("status" in grant) throw new Error(grant.message);
  return grant;
}

test("per-machine credentials survive reload, reject forgery and are revoked independently", async () => {
  let { bb, harness } = fixture();
  try {
    await plugin(bb);
    let provider =
      harness.registrations.serverAccessProviders.get("machine-gateway")!;
    const acquire = (hostId: string) =>
      provider
        .acquire({ key: hostId, hostId, signal: new AbortController().signal })
        .then(requireGrant);
    const [first, second, repeated] = await Promise.all([
      acquire("host_first"),
      acquire("host_second"),
      acquire("host_first"),
    ]);
    assert.deepEqual(first, repeated);
    assert.notDeepEqual(first.headers, second.headers);
    const verify = (headers?: Record<string, string>) =>
      harness.behavior.fetchHttp("GET", "/verify", { headers });
    assert.equal((await verify(first.headers)).status, 204);
    for (const headers of [
      undefined,
      { "x-bb-gateway-machine": "invalid" },
      {
        "x-bb-gateway-machine": first.headers!["x-bb-gateway-machine"].replace(
          "host_first",
          "host_second",
        ),
      },
    ]) {
      assert.equal((await verify(headers)).status, 401);
    }
    ({ bb, harness } = await harness.lifecycle.reload(plugin));
    provider =
      harness.registrations.serverAccessProviders.get("machine-gateway")!;
    assert.equal((await verify(first.headers)).status, 204);
    await provider.release({
      key: "host_first",
      hostId: "host_first",
      grantId: null,
    });
    assert.equal((await verify(first.headers)).status, 401);
    assert.equal((await verify(second.headers)).status, 204);
    const renewed = await acquire("host_first");
    assert.notDeepEqual(first.headers, renewed.headers);
    assert.equal((await verify(first.headers)).status, 401);
    assert.equal((await verify(renewed.headers)).status, 204);
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("removing hosts and signing-key rotation invalidate otherwise valid credentials", async () => {
  const { bb, harness, removed } = fixture();
  try {
    await plugin(bb);
    const provider =
      harness.registrations.serverAccessProviders.get("machine-gateway")!;
    const grant = requireGrant(
      await provider.acquire({
        key: "test",
        hostId: "host_test",
        signal: new AbortController().signal,
      }),
    );
    const verify = () =>
      harness.behavior.fetchHttp("GET", "/verify", { headers: grant.headers });
    assert.equal((await verify()).status, 204);
    removed.add("host_test");
    assert.equal((await verify()).status, 401);
    removed.clear();
    await harness.behavior.setSettings({ signingKey: "replacement-test-key" });
    assert.equal((await verify()).status, 401);
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("gateway configuration requires an HTTPS origin and cancellation cannot issue access", async () => {
  const { bb, harness } = fixture();
  try {
    await plugin(bb);
    for (const gatewayUrl of [
      "http://gateway.example.com",
      "https://user:pass@gateway.example.com",
      "https://gateway.example.com/path",
      "https://gateway.example.com?secret=value",
    ]) {
      await assert.rejects(harness.behavior.setSettings({ gatewayUrl }));
    }
    const provider =
      harness.registrations.serverAccessProviders.get("machine-gateway")!;
    await assert.rejects(
      provider.acquire({
        key: "test",
        hostId: "host_test",
        signal: AbortSignal.abort(),
      }),
    );
    await harness.behavior.setSettings({ gatewayUrl: "" });
    assert.equal((await provider.availability()).status, "setup-required");
    await assert.rejects(
      provider.acquire({
        key: "test",
        hostId: "host_test",
        signal: new AbortController().signal,
      }),
    );
  } finally {
    await harness.lifecycle.dispose();
  }
});
