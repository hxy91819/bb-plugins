import {
  experimental_acpLaunchSpecSchema,
  type AcpLaunchSpec,
} from "@get-bb/plugin-sdk/provider-bridge/acp";
import { z } from "zod";
import { adapterIdSchema, type AdapterId } from "./adapters/index.js";
export const launchInputSchema = z
  .object({
    adapter: adapterIdSchema,
    launch: experimental_acpLaunchSpecSchema,
  })
  .strict();
export function wrapLaunch(
  launch: AcpLaunchSpec,
  adapter: AdapterId,
  node: string,
  entry: string,
): AcpLaunchSpec {
  const prefix = [entry, `--acp-compat-proxy=${adapter}`, launch.command];
  if (launch.args.some((arg) => arg.startsWith("--acp-compat-proxy=")))
    throw new Error(
      "Launch is already wrapped; use the original agent launch.",
    );
  return experimental_acpLaunchSpecSchema.parse({
    ...launch,
    command: node,
    args: [...prefix, ...launch.args],
    ...(launch.permissionCli
      ? {
          permissionCli: {
            ...launch.permissionCli,
            insertAfterArgs:
              (launch.permissionCli.insertAfterArgs ?? 0) + prefix.length,
          },
        }
      : {}),
    ...(launch.modelCli
      ? {
          modelCli: {
            ...launch.modelCli,
            listArgs: [...prefix, ...launch.modelCli.listArgs],
          },
        }
      : {}),
  });
}
