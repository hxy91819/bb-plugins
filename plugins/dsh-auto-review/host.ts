import { experimental_acpProviderBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { withDshAutoReview } from "./src/bridge.js";

export const experimental_providerBridge = withDshAutoReview(
  experimental_acpProviderBridge,
);
