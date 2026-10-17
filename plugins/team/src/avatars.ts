import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
const manifestSchema = z.object({
  version: z.literal(1),
  avatars: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z]+(?:-[a-z]+)*$/),
        name: z.string().min(1),
        file: z.string().regex(/^[a-z]+(?:-[a-z]+)*\.png$/),
        alt: z.string().min(1),
      }),
    )
    .length(21),
});
/** src/avatars.ts and bundled dist/server.js both sit one level below assets. */
export function loadAvatarAssets() {
  const moduleUrl = import.meta.url;
  const base = new URL("../assets/avatars/", moduleUrl);
  const manifest = manifestSchema.parse(
    JSON.parse(readFileSync(new URL("manifest.json", base), "utf8")),
  );
  if (
    new Set(manifest.avatars.map((a) => a.id)).size !== 21 ||
    !manifest.avatars.some((a) => a.id === "cat") ||
    !manifest.avatars.some((a) => a.id === "admin")
  )
    throw Error("Invalid avatar IDs");
  return manifest.avatars.map((avatar) => {
    const bytes = readFileSync(new URL(avatar.file, base));
    if (
      !bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw Error(`Invalid PNG: ${avatar.file}`);
    return {
      ...avatar,
      bytes,
      hash: createHash("sha256").update(bytes).digest("hex"),
    };
  });
}
