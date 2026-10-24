import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { QuoteControls } from "./quote-controls";
import "./app.css";

export default definePluginApp((app) => {
  app.composer.customize({
    id: "draft-tools",
    scopes: ["thread", "new-thread"],
    banners: [
      { id: "quote-controls", chrome: "bare", component: QuoteControls },
    ],
    plusMenu: [
      {
        id: "clear-all",
        label: "Clear all",
        icon: "Trash2",
        description:
          "Remove all text, quotes, mentions and attached files from this draft.",
        disabled: (composer) => composer.isEmpty || composer.isSubmitting,
        run: ({ composer }) => {
          composer.replace({ text: "", mentions: [], attachments: [] });
        },
      },
    ],
  });
});
