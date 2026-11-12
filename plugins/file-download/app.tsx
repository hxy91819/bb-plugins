import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { FileDownload } from "./panel.tsx";

export default definePluginApp((app) => {
  app.slots.fileOpener({
    id: "download",
    title: "Download",
    extensions: ["html", "htm", "txt", "md", "json", "csv", "pdf", "zip"],
    component: FileDownload,
  });
});
