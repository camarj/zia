import { InteractiveMode } from "@earendil-works/pi-coding-agent";

import { createZiaAgent, type CreateZiaAgentOptions } from "./agent.ts";

export async function runZiaAgentTui(opts: CreateZiaAgentOptions): Promise<void> {
  const { runtime } = await createZiaAgent(opts);
  const mode = new InteractiveMode(runtime);
  await mode.run();
}
