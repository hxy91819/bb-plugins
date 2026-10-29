import type {
  PluginBrowserBbSdk,
  PluginFileOpenerSource,
} from "@get-bb/plugin-sdk/app";

// fileOpener has no wildcard contract. Keep the supported formats explicit.
export const extensions = [
  "html",
  "htm",
  "txt",
  "md",
  "json",
  "csv",
  "pdf",
  "zip",
];

type DownloadSdk = Pick<
  PluginBrowserBbSdk,
  "files" | "environments" | "projects" | "threads" | "system"
>;

function relativeSegments(path: string): string[] {
  const segments = path.replaceAll("\\", "/").split("/");
  if (
    path.includes("\0") ||
    /^[A-Za-z]:/.test(path) ||
    segments.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("Invalid relative file path.");
  }
  return segments;
}

function rootedPath(root: string, path: string): string {
  const segments = relativeSegments(path);
  const windows = /^[A-Za-z]:[\\/]/.test(root) || root.startsWith("\\\\");
  if (!root.startsWith("/") && !windows)
    throw new Error("File root is unavailable.");
  const separator = windows ? "\\" : "/";
  return root.replace(/[\\/]+$/, "") + separator + segments.join(separator);
}

export function fileName(path: string): string {
  const name = path.split(/[\\/]/).at(-1);
  if (!name || name === "." || name === ".." || name.includes("\0")) {
    throw new Error("Invalid file name.");
  }
  return name;
}

async function readTarget(
  sdk: DownloadSdk,
  path: string,
  source: PluginFileOpenerSource,
  signal: AbortSignal,
) {
  if (source.kind === "thread-storage") {
    if (!source.threadId) throw new Error("Thread storage is unavailable.");
    const location = await sdk.threads.storageLocation({
      threadId: source.threadId,
      signal,
    });
    return {
      hostId: location.hostId,
      rootPath: location.storageRootPath,
      path: rootedPath(location.storageRootPath, path),
    };
  }
  if (source.kind === "workspace") {
    if (source.environmentId) {
      const environment = await sdk.environments.get({
        environmentId: source.environmentId,
        signal,
      });
      if (environment.status !== "ready" || !environment.path)
        throw new Error("Environment workspace is not ready.");
      return {
        hostId: environment.hostId,
        rootPath: environment.path,
        path: rootedPath(environment.path, path),
      };
    }
    if (!source.projectId) throw new Error("Project workspace is unavailable.");
    const hostId =
      source.experimental_hostId ??
      (await sdk.system.config({ signal })).primaryHostId;
    if (!hostId) throw new Error("Project host is unavailable.");
    const project = await sdk.projects.get({
      projectId: source.projectId,
      signal,
    });
    const checkout = project.sources.find(
      (entry) => entry.type === "local_path" && entry.hostId === hostId,
    );
    if (!checkout)
      throw new Error("Project has no checkout on the selected host.");
    return {
      hostId,
      rootPath: checkout.path,
      path: rootedPath(checkout.path, path),
    };
  }
  let hostId = source.experimental_hostId;
  if (!hostId && source.environmentId) {
    hostId = (
      await sdk.environments.get({
        environmentId: source.environmentId,
        signal,
      })
    ).hostId;
  }
  if (!hostId) throw new Error("File host is unavailable.");
  if (!path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(path)) {
    throw new Error("Host file path must be absolute.");
  }
  // A host source already denotes an absolute file, just as BB's host preview does.
  return { hostId, path };
}

export async function prepareDownload(
  sdk: DownloadSdk,
  path: string,
  source: PluginFileOpenerSource,
  signal: AbortSignal,
): Promise<{ fileName: string; blob: Blob }> {
  const name = fileName(path);
  const target = await readTarget(sdk, path, source, signal);
  signal.throwIfAborted();
  const file = await sdk.files.read({ ...target, signal });
  signal.throwIfAborted();
  const bytes =
    file.contentEncoding === "base64"
      ? Uint8Array.from(atob(file.content), (character) =>
          character.charCodeAt(0),
        )
      : new TextEncoder().encode(file.content);
  if (bytes.byteLength !== file.sizeBytes)
    throw new Error("File size changed while preparing the download.");
  // Never navigate to or render the HTML. The browser receives an attachment Blob.
  return {
    fileName: name,
    blob: new Blob([bytes], { type: "application/octet-stream" }),
  };
}
