import { useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  experimental_saveFile,
  useSdk,
  type PluginFileOpenerProps,
} from "@get-bb/plugin-sdk/app";
import { extensions, prepareDownload } from "./download.ts";

function DownloadFile({ path, source, Original }: PluginFileOpenerProps) {
  const sdk = useSdk();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);

  async function download() {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setMessage("");
    try {
      const request = await prepareDownload(
        sdk,
        path,
        source,
        controller.signal,
      );
      controller.signal.throwIfAborted();
      const outcome = await experimental_saveFile(request);
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
        <button
          type="button"
          onClick={() => setPreview((value) => !value)}
          className="rounded border px-3 py-1"
        >
          {preview ? "Hide preview" : "Show BB preview"}
        </button>
        <span className="break-all text-sm">{path}</span>
        <p role="status" className="w-full text-sm">
          {message}
        </p>
      </div>
      {preview ? (
        <div className="min-h-0 flex-1">
          <Original />
        </div>
      ) : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.fileOpener({
    id: "download",
    title: "Download",
    extensions,
    component: (props) => (
      <DownloadFile
        key={JSON.stringify([props.path, props.source])}
        {...props}
      />
    ),
  });
});
