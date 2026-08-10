import { describe, expect, test } from "bun:test";
import {
  FEISHU_AGENT_TOOLS,
  FEISHU_DELEGATE_AGENTS,
  feishuCapabilityCeiling,
  isSubagentProcess,
} from "../src/runtime/agent-runtime.ts";
import {
  encodeSubagentCapabilityCeiling,
  registerSubagentCapabilityCeiling,
  resolveCurrentSubagentCapabilityCeiling,
} from "pi-subagents/capability-ceiling";

describe("isolated Feishu agent runtime", () => {
  test("parent tool allowlist explicitly exposes delegation tools", () => {
    expect(FEISHU_AGENT_TOOLS).toContain("notify");
    expect(FEISHU_AGENT_TOOLS).toContain("subagent");
    expect(FEISHU_AGENT_TOOLS).toContain("subagent_wait");
  });

  test("real registry resolves by session file and intersects inherited ceiling", () => {
    expect(feishuCapabilityCeiling().allowedAgents).toEqual([...FEISHU_DELEGATE_AGENTS]);
    const sessionFile = "/private/sessions/conversation.jsonl";
    const previous = process.env.PI_SUBAGENT_CAPABILITY_CEILING_V1;
    const inherited = {
      version: 1 as const,
      allowedTools: ["read", "subagent"],
      allowedAgents: ["worker", "reviewer", "oracle"],
      denyExtensions: false,
      sources: ["inherited-parent"],
    };
    process.env.PI_SUBAGENT_CAPABILITY_CEILING_V1 = encodeSubagentCapabilityCeiling(inherited);
    const handle = registerSubagentCapabilityCeiling({
      sessionId: sessionFile,
      source: "feishu-test",
      ceiling: feishuCapabilityCeiling(),
    });
    try {
      const resolved = resolveCurrentSubagentCapabilityCeiling(sessionFile)!;
      expect(resolved.allowedAgents).toEqual(["reviewer", "worker"]);
      expect(resolved.allowedTools).toEqual(["read"]);
      expect(resolved.denyExtensions).toBe(true);
      expect(resolved.sources).toEqual(["feishu-test", "inherited-parent"]);
      expect(resolveCurrentSubagentCapabilityCeiling("wrong-session")!.sources).toEqual(["inherited-parent"]);
      expect(resolved.allowedTools).not.toContain("notify");
      expect(resolved.allowedTools).not.toContain("subagent");
      expect(resolved.allowedTools).not.toContain("subagent_wait");
    } finally {
      handle.dispose();
      if (previous === undefined) delete process.env.PI_SUBAGENT_CAPABILITY_CEILING_V1;
      else process.env.PI_SUBAGENT_CAPABILITY_CEILING_V1 = previous;
    }
  });

  test("detects child process before creating a Feishu connection", () => {
    expect(isSubagentProcess({ PI_SUBAGENT_CHILD: "1" })).toBe(true);
    expect(isSubagentProcess({})).toBe(false);
  });
});
