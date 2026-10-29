import { useEffect, useRef, useState } from "react";
import type {
  ExperimentalSaveFileOutcome,
  PluginFileOpenerProps,
} from "@get-bb/plugin-sdk/app";

type DownloadRequest = { fileName: string; blob: Blob };
interface Props extends PluginFileOpenerProps {
  prepare(signal: AbortSignal): Promise<DownloadRequest>;
  save(request: DownloadRequest): Promise<ExperimentalSaveFileOutcome>;
}

function DownloadPanel({ path, Original, prepare, save }: Props) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);

  async function download() {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setMessage("");
    try {
      const request = await prepare(controller.signal);
      controller.signal.throwIfAborted();
      const outcome = await save(request);
      if (!controller.signal.aborted)
        setMessage(
          outcome === "started"
            ? "Download handed to your browser or device."
            : "Download could not start. Try again.",
        );
    } catch (error) {
      if (!controller.signal.aborted)
        setMessage(
          error instanceof Error ? error.message : "Could not read this file.",
        );
    } finally {
      if (pending.current === controller) pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b p-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => void download()}
          className="rounded border px-3 py-1 disabled:opacity-50"
        >
          {busy ? "Preparing…" : "Download"}
        </button>
        <span className="break-all text-sm">{path}</span>
        <p role="status" className="w-full text-sm">
          {message}
        </p>
      </div>
      <div className="min-h-0 flex-1">
        <Original />
      </div>
    </div>
  );
}

export function FileDownload(props: Props) {
  const { path, source } = props;
  return (
    <DownloadPanel
      key={JSON.stringify([
        path,
        source.kind,
        source.environmentId,
        source.projectId,
        source.threadId,
        source.experimental_hostId,
      ])}
      {...props}
    />
  );
}
