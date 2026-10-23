import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { BbPluginApi, ServerAccessGrant } from "@get-bb/plugin-sdk";
import { z } from "zod";

const header = "x-bb-gateway-machine";
const gatewayUrlSchema = z.string().refine((value) => {
  if (value === "") return true;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}, "Use an HTTPS origin without a path or credentials");
const nonceSchema = z.object({ nonce: z.string().regex(/^[a-f0-9]{64}$/u) });

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    gatewayUrl: {
      type: "string",
      label: "Gateway URL",
      default: "",
      experimental_schema: gatewayUrlSchema,
    },
    signingKey: { type: "string", label: "Machine signing key", secret: true },
  });
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    "CREATE TABLE machine_grants (host_id TEXT PRIMARY KEY, nonce TEXT NOT NULL)",
  ]);
  const readGrant = db.prepare(
    "SELECT nonce FROM machine_grants WHERE host_id = ?",
  );
  const writeGrant = db.prepare(
    "INSERT INTO machine_grants (host_id, nonce) VALUES (?, ?)",
  );
  const deleteGrant = db.prepare(
    "DELETE FROM machine_grants WHERE host_id = ?",
  );
  let queue = Promise.resolve();
  function serialized<T>(action: () => Promise<T>): Promise<T> {
    const result = queue.then(action);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  function signature(hostId: string, nonce: string, key: string): string {
    return createHmac("sha256", key)
      .update(JSON.stringify([hostId, nonce]))
      .digest("base64url");
  }
  const unauthorized = () =>
    new Response("Unauthorized", {
      status: 401,
      headers: { "cache-control": "no-store" },
    });
  bb.http.route(
    "GET",
    "/verify",
    async (context) => {
      const token = context.req.header(header);
      const match = token?.match(
        /^bbgw\.(host_[a-z0-9]+)\.([A-Za-z0-9_-]{43})$/u,
      );
      if (!match) return unauthorized();
      const [, hostId, supplied] = match;
      const row = readGrant.get(hostId);
      if (row === undefined) return unauthorized();
      const { nonce } = nonceSchema.parse(row);
      const { signingKey } = await settings.get();
      if (!signingKey) return unauthorized();
      const expected = signature(hostId, nonce, signingKey);
      if (!timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)))
        return unauthorized();
      try {
        const host = await bb.sdk.hosts.get({ hostId });
        if (
          host.lifecycle.phase === "removing" ||
          host.lifecycle.phase === "destroyed"
        )
          return unauthorized();
      } catch {
        return unauthorized();
      }
      return new Response(null, {
        status: 204,
        headers: { "cache-control": "no-store" },
      });
    },
    { auth: "none" },
  );
  bb.experimental_serverAccess.register({
    id: "machine-gateway",
    displayName: "Self-hosted gateway",
    description:
      "Connect through your HTTPS gateway with a separate revocable credential per machine.",
    async availability() {
      const { gatewayUrl } = await settings.get();
      return gatewayUrl === ""
        ? {
            status: "setup-required",
            message: "Configure the Machine Gateway URL.",
          }
        : { status: "available", serverUrl: gatewayUrl.replace(/\/$/u, "") };
    },
    acquire({ hostId, signal }) {
      return serialized(async (): Promise<ServerAccessGrant> => {
        signal.throwIfAborted();
        const current = await settings.get();
        if (current.gatewayUrl === "")
          throw new Error("Configure the Machine Gateway URL.");
        let signingKey = current.signingKey;
        if (!signingKey) {
          signingKey = randomBytes(32).toString("hex");
          await settings.experimental_set({ signingKey });
        }
        const row = readGrant.get(hostId);
        const nonce =
          row === undefined
            ? randomBytes(32).toString("hex")
            : nonceSchema.parse(row).nonce;
        signal.throwIfAborted();
        if (row === undefined) writeGrant.run(hostId, nonce);
        return {
          id: hostId,
          serverUrl: current.gatewayUrl.replace(/\/$/u, ""),
          headers: {
            [header]: `bbgw.${hostId}.${signature(hostId, nonce, signingKey)}`,
          },
        };
      });
    },
    release({ hostId }) {
      return serialized(async () => {
        deleteGrant.run(hostId);
      });
    },
  });
  settings.onChange(() => bb.experimental_serverAccess.recheck());
}
