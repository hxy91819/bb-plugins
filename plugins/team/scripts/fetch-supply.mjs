import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, appendFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFileSync } from "node:child_process";

const supply = JSON.parse(
  await readFile(new URL("../release/bb-supply.json", import.meta.url), "utf8"),
);
if (
  supply.status !== "verified" ||
  !/^[a-f0-9]{64}$/.test(supply.runtime.sha256 ?? "") ||
  !/^[a-f0-9]{64}$/.test(supply.sdk.sha256 ?? "")
)
  throw Error(
    "Formal BB supply is pending: verify published assets and commit their actual hashes first.",
  );
if (!process.argv[2])
  throw Error("Usage: node scripts/fetch-supply.mjs NEW_DIRECTORY");
const directory = resolve(process.argv[2]);
await mkdir(directory);
for (const artifact of [supply.runtime, supply.sdk]) {
  if (!/^[a-zA-Z0-9._-]+$/.test(artifact.filename))
    throw Error("Invalid asset filename");
  const response = await fetch(`${supply.baseUrl}/${artifact.filename}`);
  if (!response.ok || !response.body)
    throw Error(`Asset download failed: ${response.status}`);
  const path = join(directory, artifact.filename);
  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(path, { flags: "wx" }),
  );
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest("hex") !== artifact.sha256)
    throw Error(`Checksum mismatch: ${artifact.filename}`);
}
const runtime = join(directory, "runtime");
await mkdir(runtime);
execFileSync("tar", [
  "-xzf",
  join(directory, supply.runtime.filename),
  "-C",
  runtime,
  "--strip-components=1",
]);
const provenance = JSON.parse(
  await readFile(join(runtime, "release.json"), "utf8"),
);
if (
  provenance.source !== supply.source ||
  provenance.tag !== supply.tag ||
  !provenance.node.startsWith("v24.")
)
  throw Error("Runtime provenance does not match the pinned BB supply");
if (process.env.GITHUB_ENV) {
  await appendFile(process.env.GITHUB_ENV, `BB_TEAM_RUNTIME_DIR=${runtime}\n`);
  await appendFile(process.env.GITHUB_PATH, `${join(runtime, "bin")}\n`);
}
console.log(
  JSON.stringify({
    runtime,
    sdk: join(directory, supply.sdk.filename),
    source: supply.source,
    tag: supply.tag,
  }),
);
