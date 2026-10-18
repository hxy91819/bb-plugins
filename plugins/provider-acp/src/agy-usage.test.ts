import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeAgyUsage, readAgyUsage } from "./agy-usage.js";

const raw =
  "Gemini Models\tWeekly Limit Remaining\t72.5%\t2027-01-01T00:00:00Z\nClaude and GPT models\tFive Hour Limit Remaining\t81%\t2027-01-01T01:00:00Z\n";
async function executable(body: string, run: (file: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "bb-acp-agy-"));
  const file = path.join(dir, "agent.mjs");
  await writeFile(file, `#!${process.execPath}\n${body}`, { mode: 0o700 });
  try {
    await run(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
describe("AGY usage collection", () => {
  it("preserves model groups, converts remaining to used, and rejects missing or malformed measurements", () => {
    expect(normalizeAgyUsage(raw)).toMatchObject({
      supported: true,
      usage: {
        status: "ok",
        windows: [
          {
            label: "Gemini Models: Weekly limit",
            usedPercent: 27.5,
            resetsAt: "2027-01-01T00:00:00.000Z",
          },
          {
            label: "Claude and GPT models: 5-hour limit",
            usedPercent: 19,
            resetsAt: "2027-01-01T01:00:00.000Z",
          },
        ],
      },
    });
    for (const invalid of [
      "",
      "unrecognized format",
      raw.replace("72.5%", "101%"),
      raw.replace("2027-01-01", "2026-02-30"),
    ])
      expect(normalizeAgyUsage(invalid)).toMatchObject({
        usage: { status: "error" },
      });
    expect(normalizeAgyUsage("Please log in")).toMatchObject({
      usage: { status: "unauthenticated" },
    });
  });
  it("runs only the configured usage command with the configured environment and ignores startup diagnostics", async () => {
    await executable(
      `if (JSON.stringify(process.argv.slice(2)) !== '["--print","/usage"]' || process.env.FIXTURE_VALUE !== 'configured') process.exit(2);
      console.error('Not logged in during initialization'); console.log(${JSON.stringify(raw)});`,
      async (file) => {
        expect(
          await readAgyUsage(file, { env: { FIXTURE_VALUE: "configured" } }),
        ).toEqual(normalizeAgyUsage(raw));
      },
    );
    expect(await readAgyUsage("/missing/fixture-agy")).toMatchObject({
      usage: { status: "not_installed" },
    });
  });
  it("rejects a failed process even when its quota output is valid", async () => {
    await executable(
      `console.log(${JSON.stringify(raw)}); process.exitCode = 1;`,
      async (file) => {
        expect(await readAgyUsage(file)).toMatchObject({
          usage: {
            status: "error",
            message: "AGY account limits command failed; check the CLI login.",
          },
        });
      },
    );
  });
  it("cleans up a hanging process on cancellation and timeout", async () => {
    await executable("setInterval(() => {}, 1000)", async (file) => {
      const timedOut = await readAgyUsage(file, { timeoutMs: 30 });
      expect(timedOut).toMatchObject({
        usage: { status: "error", message: "Account limits query timed out." },
      });
      const controller = new AbortController();
      const pending = readAgyUsage(file, { signal: controller.signal });
      controller.abort();
      expect(await pending).toMatchObject({
        usage: { status: "error", message: "Account limits query cancelled." },
      });
    });
  });
});
