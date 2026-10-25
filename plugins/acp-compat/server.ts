import { cliCommand, defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { hostContract, rpcContract } from "./src/contract.js";
import { launchInputSchema } from "./src/launch.js";
export default function acpCompatPlugin(bb: BbPluginApi): void {
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const prepareLaunch = (
    input: typeof rpcContract.prepareLaunch.input._output,
    signal?: AbortSignal,
  ) =>
    host.call(
      "prepareLaunch",
      { adapter: input.adapter, launch: input.launch },
      { hostId: input.hostId, signal },
    );
  bb.rpc.register(rpcContract, {
    prepareLaunch: (input) => prepareLaunch(input),
  });
  bb.cli.register(
    defineCli({
      name: "acp-compat",
      summary: "Prepare plugin-managed ACP compatibility launches",
      commands: {
        launch: cliCommand({
          summary:
            "Wrap an ACP launch on its execution host without changing provider settings",
          options: {
            host: {
              type: "string",
              required: true,
              description: "Execution host ID",
            },
            adapter: {
              type: "enum",
              values: ["passthrough", "codebuddy"],
              required: true,
              description: "Protocol adapter",
            },
            launch: {
              type: "string",
              required: true,
              description: "Original ACP launch specification as JSON",
            },
            json: { type: "boolean", description: "Emit JSON" },
          },
          async run(input, context) {
            const value = launchInputSchema.parse({
              adapter: input.options.adapter,
              launch: JSON.parse(input.options.launch),
            });
            const launch = await prepareLaunch(
              { ...value, hostId: input.options.host },
              context.signal,
            );
            return { exitCode: 0, stdout: JSON.stringify(launch) };
          },
        }),
      },
    }),
  );
}
