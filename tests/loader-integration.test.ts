import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RpcAgentSession,
  resolveNotifyExtension,
  resolvePolicyExtension,
  resolveSubagentsInstall,
} from "../src/runtime/rpc-agent-session.ts";

test("two active new/restored Feishu sessions have process-isolated extension runtimes", async () => {
  const cwd = process.cwd();
  const sessionDir = await mkdtemp(join(tmpdir(), "feishu-dual-runtime-"));
  const install = resolveSubagentsInstall();
  expect(install.entry).toContain("pi-subagents");
  expect(resolvePolicyExtension()).toEndWith("feishu-subagent-policy.ts");
  expect(resolveNotifyExtension()).toEndWith("tools/notify.ts");

  const pids: number[] = [];
  const a = await RpcAgentSession.create({ cwd, sessionDir });
  const b = await RpcAgentSession.create({ cwd, sessionDir });
  if (a.pid) pids.push(a.pid);
  if (b.pid) pids.push(b.pid);
  try {
    expect(a.pid).not.toBe(b.pid);
    expect(a.runtimeToken).not.toBe(b.runtimeToken);
    expect(a.sessionFile).not.toBe(b.sessionFile);
    const [aCommands, bCommands] = await Promise.all([a.request("get_commands"), b.request("get_commands")]);
    expect(aCommands.commands.some((command: any) => command.name === "subagents")).toBe(true);
    expect(bCommands.commands.some((command: any) => command.name === "subagents")).toBe(true);
    // Exercise the official pi-subagents status command concurrently. This is
    // handled by each process-local extension action binding without a model call.
    let doctorText = "";
    const unsubscribeDoctor = a.subscribe((event: any) => {
      if (event.type === "message_end" && event.message?.role === "custom" && event.message?.customType === "subagent-slash-result" && typeof event.message.content === "string" && event.message.content.includes("Subagents doctor report")) doctorText = event.message.content;
    });
    await Promise.all([a.prompt("/subagents-doctor"), b.prompt("/subagents")]);
    unsubscribeDoctor();
    expect(doctorText).toContain("Subagents doctor report");
    const [afterStatusA, afterStatusB] = await Promise.all([a.request("get_state"), b.request("get_state")]);
    expect(afterStatusA.sessionFile).toBe(a.sessionFile);
    expect(afterStatusB.sessionFile).toBe(b.sessionFile);

    const aFile = a.sessionFile;
    await a.dispose();
    const bState = await b.request("get_state");
    expect(bState.sessionFile).toBe(b.sessionFile);

    const restoredA = await RpcAgentSession.create({ cwd, sessionDir, savedPath: aFile });
    if (restoredA.pid) pids.push(restoredA.pid);
    try {
      expect(restoredA.sessionFile).toBe(aFile);
      expect(restoredA.pid).not.toBe(b.pid);
      const [restoredCommands, liveBCommands] = await Promise.all([
        restoredA.request("get_commands"), b.request("get_commands"),
      ]);
      expect(restoredCommands.commands.some((command: any) => command.name === "subagents")).toBe(true);
      expect(liveBCommands.commands.some((command: any) => command.name === "subagents")).toBe(true);
    } finally {
      await restoredA.dispose();
    }
  } finally {
    await a.dispose();
    await b.dispose();
  }
  for (const pid of pids) {
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    expect(alive).toBe(false);
  }
});
