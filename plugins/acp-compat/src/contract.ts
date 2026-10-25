import { defineRpcContract } from "@get-bb/plugin-sdk";
import { experimental_acpLaunchSpecSchema } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { z } from "zod";
import { launchInputSchema } from "./launch.js";
export const hostContract = defineRpcContract({
  prepareLaunch: {
    input: launchInputSchema,
    output: experimental_acpLaunchSpecSchema,
  },
});
export const rpcContract = defineRpcContract({
  prepareLaunch: {
    input: launchInputSchema.extend({ hostId: z.string().min(1) }),
    output: experimental_acpLaunchSpecSchema,
  },
});
