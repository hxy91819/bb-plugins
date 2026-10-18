import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { stripVTControlCharacters } from "node:util";
import {
  providerUsageResultSchema,
  withoutBridgeRuntimeEnv,
  type ProviderUsageResult,
} from "@get-bb/plugin-sdk/provider-bridge";

export function usageError(message: string): ProviderUsageResult {
  return {
    supported: true,
    usage: { status: "error", message, planLabel: null, accountEmail: null },
  };
}
export interface QueryOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  cwd?: string;
  env?: Record<string, string>;
}

export function normalizeAgyUsage(raw: string): ProviderUsageResult {
  const text = stripVTControlCharacters(raw).trim();
  if (/not logged in|not logged into|please log in/i.test(text))
    return { supported: true, usage: { status: "unauthenticated" } };
  if (/(?:token|session).{0,30}expired/i.test(text))
    return { supported: true, usage: { status: "expired" } };
  const windows = [];
  for (const line of text.split(/\r?\n/)) {
    const cols = line.split("\t").map((value) => value.trim());
    const [group, metric, remaining, reset] = cols;
    if (
      cols.length !== 4 ||
      !group ||
      !["Weekly Limit Remaining", "Five Hour Limit Remaining"].includes(
        metric,
      ) ||
      !/^\d+(?:\.\d+)?%$/.test(remaining) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(reset)
    ) {
      return usageError(
        "AGY returned an unrecognized /usage format; no quota estimate was made.",
      );
    }
    const percent = Number(remaining.slice(0, -1));
    const date = new Date(reset);
    if (
      percent > 100 ||
      !Number.isFinite(date.getTime()) ||
      date.toISOString().replace(".000Z", "Z") !== reset
    ) {
      return usageError(
        "AGY returned invalid quota values or a reset timestamp.",
      );
    }
    // AGY 返回剩余百分比，BB 的进度条需要已用百分比。
    windows.push({
      label: `${group}: ${metric === "Weekly Limit Remaining" ? "Weekly limit" : "5-hour limit"}`,
      usedPercent: Number((100 - percent).toFixed(10)),
      resetsAt: date.toISOString(),
    });
  }
  return {
    supported: true,
    usage: { status: "ok", accountEmail: null, planLabel: null, windows },
  };
}

export async function readAgyUsage(
  command: string,
  options: QueryOptions = {},
): Promise<ProviderUsageResult> {
  return runQuery(command, ["--print", "/usage"], options, (child, finish) => {
    let output = "";
    child.stdin.end();
    child.stdout.on("data", (chunk) => {
      if (output.length <= 128 * 1024) output += chunk.toString();
      if (output.length > 128 * 1024)
        finish(usageError("AGY usage output exceeded the size limit."));
    });
    // 启动日志可能在认证完成前声称未登录，不能据此覆盖最终额度结果。
    child.stderr.resume();
    return () =>
      child.exitCode === 0
        ? normalizeAgyUsage(output)
        : usageError("AGY account limits command failed; check the CLI login.");
  });
}

function spawnQuery(command: string, args: string[], options: QueryOptions) {
  return spawn(command, args, {
    cwd: options.cwd ?? homedir(),
    env: withoutBridgeRuntimeEnv({ ...process.env, ...options.env }),
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
}

type QueryChild = ReturnType<typeof spawnQuery>;
type SetupQuery = (
  child: QueryChild,
  finish: (result: ProviderUsageResult) => void,
) => () => ProviderUsageResult;

async function runQuery(
  command: string,
  args: string[],
  options: QueryOptions,
  setup: SetupQuery,
): Promise<ProviderUsageResult> {
  if (options.signal?.aborted)
    return usageError("Account limits query cancelled.");
  return new Promise((resolve) => {
    const child = spawnQuery(command, args, options);
    let result: ProviderUsageResult | undefined;
    let closed = false;
    let stopping: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        /* 子进程可能已在信号到达前退出。 */
      }
    };
    const finish = (next: ProviderUsageResult) => {
      if (result || closed) return;
      result = next;
      child.stdin.end();
      // 先让命令正常结束，超时再清理其进程组。
      stopping = setTimeout(() => {
        kill("SIGTERM");
        stopping = setTimeout(() => kill("SIGKILL"), 1000);
      }, 1000);
    };
    const timer = setTimeout(
      () => finish(usageError("Account limits query timed out.")),
      options.timeoutMs ?? 20000,
    );
    const abort = () => finish(usageError("Account limits query cancelled."));
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdin.on("error", () =>
      finish(usageError("Account limits process closed its input.")),
    );
    child.on("error", (error) =>
      finish(
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? { supported: true, usage: { status: "not_installed" } }
          : usageError("Could not start account limits query."),
      ),
    );
    const onExit = setup(child, finish);
    child.on("close", () => {
      closed = true;
      clearTimeout(timer);
      clearTimeout(stopping);
      options.signal?.removeEventListener("abort", abort);
      resolve(providerUsageResultSchema.parse(result ?? onExit()));
    });
  });
}
