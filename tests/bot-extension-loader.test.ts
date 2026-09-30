import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePiRpcEntry, RpcAgentSession } from "../src/runtime/rpc-agent-session.ts";

test("official Pi loader loads the changed bot extension without connecting to Feishu", async () => {
  const root = await mkdtemp(join(tmpdir(), "feishu-bot-loader-"));
  const extension = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  const child = spawn(process.execPath, [resolvePiRpcEntry(), "--no-extensions", "--extension", extension,
    "--no-session", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"], {
    cwd: root,
    env: {
      PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: root, PI_OFFLINE: "1",
      FEISHU_APP_ID: "cli_fake_loader_test", FEISHU_APP_SECRET: "fake-loader-test-not-a-secret",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const session = RpcAgentSession.fromProcessForTest(child, { requestTimeoutMs: 15_000 });
  try {
    const { commands } = await session.request("get_commands");
    for (const name of ["feishu-setup", "connect-feishu", "disconnect-feishu", "feishu"]) {
      const command = commands.find((command: any) => command.name === name);
      expect(command).toBeDefined();
      expect(command.sourceInfo.path).toBe(extension);
    }
  } finally {
    await session.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
