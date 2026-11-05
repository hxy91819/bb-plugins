
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const command = process.argv[2];
if (!command) {
  process.stderr.write("codebuddy-acp-proxy: missing downstream command\n");
  process.exit(2);
}

const child = spawn(command, process.argv.slice(3), {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});
child.stderr.pipe(process.stderr);

const CANCEL_QUIET_MS = 250;
const RECOVERY_COALESCE_MS = 100;
const CANCEL_RETRY_MS = 100;
const MAX_CANCEL_RETRIES = 20;
const RETRY_WINDOW_MS = 3000;
const MAX_RETRIES = 5;
const sessions = new Map();
const downstreamRequests = new Map();
let nextDownstreamId = 1;
let shuttingDown = false;

function keyOf(id) {
  return typeof id + ":" + String(id);
}

function write(stream, message) {
  stream.write(JSON.stringify(message) + "\n");
}

function writeUpstream(message) {
  write(process.stdout, message);
}

function writeDownstream(message) {
  write(child.stdin, message);
}

function sessionFor(sessionId) {
  let session = sessions.get(sessionId);
  if (!session) {
    session = {
      active: null,
      queue: [],
      cancelEpoch: 0,
      lastCancelAt: 0,
      timer: null,
      cancelTimer: null,
      cancelMessage: null,
      cancelRetries: 0,
    };
    sessions.set(sessionId, session);
  }
  return session;
}

function mappedRequest(message, pending) {
  const id = "__bb_codebuddy_proxy_" + nextDownstreamId++;
  downstreamRequests.set(keyOf(id), pending);
  writeDownstream({ ...message, id });
}

function forwardRequest(message) {
  mappedRequest(message, { kind: "forward", upstreamId: message.id });
}

function forwardCancel(message) {
  const sessionId = message.params?.sessionId;
  if (typeof sessionId === "string") {
    const session = sessionFor(sessionId);
    session.cancelEpoch += 1;
    session.lastCancelAt = Date.now();
    session.cancelMessage = message;
    session.cancelRetries = 0;
    if (session.cancelTimer) {
      clearTimeout(session.cancelTimer);
      session.cancelTimer = null;
    }
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }
    writeDownstream(message);
    if (!session.active && session.queue.length > 0) {
      const cancelled = session.queue.shift();
      writeUpstream({
        jsonrpc: "2.0",
        id: cancelled.upstreamId,
        result: { stopReason: "cancelled" },
      });
    }
    scheduleCancelRetry(session);
    pump(sessionId, session);
    return;
  }
  writeDownstream(message);
}

function scheduleCancelRetry(session) {
  if (
    !session.active ||
    !session.cancelMessage ||
    session.cancelRetries >= MAX_CANCEL_RETRIES ||
    session.cancelTimer
  ) return;
  session.cancelTimer = setTimeout(() => {
    session.cancelTimer = null;
    if (!session.active || !session.cancelMessage) return;
    session.cancelRetries += 1;
    session.lastCancelAt = Date.now();
    writeDownstream(session.cancelMessage);
    scheduleCancelRetry(session);
  }, CANCEL_RETRY_MS);
}

function clearCancelRetry(session) {
  if (session.cancelTimer) {
    clearTimeout(session.cancelTimer);
    session.cancelTimer = null;
  }
  session.cancelMessage = null;
  session.cancelRetries = 0;
}

function enqueuePrompt(message) {
  const sessionId = message.params?.sessionId;
  if (typeof sessionId !== "string") {
    forwardRequest(message);
    return;
  }
  const session = sessionFor(sessionId);
  const now = Date.now();
  session.queue.push({
    message,
    upstreamId: message.id,
    retries: 0,
    recovery:
      session.lastCancelAt > 0 &&
      now - session.lastCancelAt <= RETRY_WINDOW_MS,
    notBefore:
      session.lastCancelAt > 0 &&
      now - session.lastCancelAt <= RETRY_WINDOW_MS
        ? now + RECOVERY_COALESCE_MS
        : now,
  });
  pump(sessionId, session);
}

function pump(sessionId, session) {
  if (session.active || session.timer || session.queue.length === 0) return;
  const next = session.queue[0];
  const quietRemaining = Math.max(
    0,
    session.lastCancelAt + CANCEL_QUIET_MS - Date.now(),
  );
  const coalesceRemaining = Math.max(0, next.notBefore - Date.now());
  const waitRemaining = Math.max(quietRemaining, coalesceRemaining);
  if (waitRemaining > 0) {
    session.timer = setTimeout(() => {
      session.timer = null;
      pump(sessionId, session);
    }, waitRemaining);
    return;
  }
  const job = session.queue.shift();
  session.active = job;
  sendPromptAttempt(sessionId, session, job);
}

function sendPromptAttempt(sessionId, session, job) {
  const attemptEpoch = session.cancelEpoch;
  mappedRequest(job.message, {
    kind: "prompt",
    sessionId,
    session,
    job,
    attemptEpoch,
  });
}

function promptSettled(pending, message) {
  const { sessionId, session, job, attemptEpoch } = pending;
  clearCancelRetry(session);
  const cancelled = message.result?.stopReason === "cancelled";
  const noNewCancel = session.cancelEpoch === attemptEpoch;
  const withinRetryWindow =
    session.lastCancelAt > 0 &&
    Date.now() - session.lastCancelAt <= RETRY_WINDOW_MS;
  if (
    cancelled &&
    job.recovery &&
    noNewCancel &&
    withinRetryWindow &&
    job.retries < MAX_RETRIES
  ) {
    job.retries += 1;
    session.active = null;
    const retryDelay = Math.min(400, 50 * 2 ** (job.retries - 1));
    job.notBefore = Date.now() + retryDelay;
    session.queue.unshift(job);
    pump(sessionId, session);
    return;
  }
  writeUpstream({ ...message, id: job.upstreamId });
  session.active = null;
  pump(sessionId, session);
}

function handleUpstream(message) {
  if (message && typeof message === "object" && "method" in message) {
    if (message.method === "session/cancel" && !("id" in message)) {
      forwardCancel(message);
      return;
    }
    if (message.method === "session/prompt" && "id" in message) {
      enqueuePrompt(message);
      return;
    }
    if ("id" in message) {
      forwardRequest(message);
      return;
    }
    writeDownstream(message);
    return;
  }
  writeDownstream(message);
}

function handleDownstream(message) {
  if (message && typeof message === "object" && "id" in message) {
    const pending = downstreamRequests.get(keyOf(message.id));
    if (pending && ("result" in message || "error" in message)) {
      downstreamRequests.delete(keyOf(message.id));
      if (pending.kind === "prompt") {
        promptSettled(pending, message);
      } else {
        writeUpstream({ ...message, id: pending.upstreamId });
      }
      return;
    }
  }
  writeUpstream(message);
}

function readLines(stream, handler) {
  const lines = createInterface({ input: stream });
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    handler(message);
  });
}

readLines(process.stdin, handleUpstream);
readLines(child.stdout, handleDownstream);

function terminate(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  child.kill(signal);
}

process.on("SIGTERM", () => terminate("SIGTERM"));
process.on("SIGINT", () => terminate("SIGINT"));
process.stdin.on("end", () => terminate("SIGTERM"));
child.on("error", (error) => {
  process.stderr.write("codebuddy-acp-proxy: " + error.message + "\n");
});
child.on("exit", (code, signal) => {
  for (const pending of downstreamRequests.values()) {
    writeUpstream({
      jsonrpc: "2.0",
      id: pending.upstreamId ?? pending.job?.upstreamId,
      error: {
        code: -32000,
        message: "CodeBuddy ACP process exited before replying",
      },
    });
  }
  for (const session of sessions.values()) {
    if (session.timer) clearTimeout(session.timer);
    if (session.cancelTimer) clearTimeout(session.cancelTimer);
    for (const job of session.queue.splice(0)) {
      writeUpstream({
        jsonrpc: "2.0",
        id: job.upstreamId,
        error: {
          code: -32000,
          message: "CodeBuddy ACP process exited before replying",
        },
      });
    }
  }
  process.exitCode = code ?? (signal ? 1 : 0);
});
