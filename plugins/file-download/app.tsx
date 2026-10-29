import {
  definePluginApp,
  experimental_saveFile,
  useSdk,
  type PluginFileOpenerProps,
} from "@get-bb/plugin-sdk/app";
import { extensions, prepareDownload } from "./download.ts";
import { FileDownload } from "./panel.tsx";

function DownloadFile(props: PluginFileOpenerProps) {
  const sdk = useSdk();
  return (
    <FileDownload
      {...props}
      prepare={(signal) =>
        prepareDownload(sdk, props.path, props.source, signal)
      }
      save={experimental_saveFile}
    />
  );
}

export default definePluginApp((app) => {
  app.slots.fileOpener({
    id: "download",
    title: "Download",
    extensions,
    component: DownloadFile,
  });
});
