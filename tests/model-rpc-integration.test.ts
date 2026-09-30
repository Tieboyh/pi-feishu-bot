import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcAgentSession } from "../src/runtime/rpc-agent-session.ts";
import { executeModelControl } from "../src/sessions/model-control.ts";

// Fully temporary provider/settings/history; no real credentials or LLM calls.
test("real RPC model selection isolates settings and other chats, restores history and empty-session choices", async () => {
  const root = await mkdtemp(join(tmpdir(), "feishu-model-rpc-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  const sessionDir = join(root, "sessions");
  await Promise.all([mkdir(agentDir), mkdir(join(cwd, ".pi"), { recursive: true }), mkdir(sessionDir)]);
  const settingsFile = join(agentDir, "settings.json");
  const projectFile = join(cwd, ".pi", "settings.json");
  const settings = JSON.stringify({ defaultProvider: "feishu-test", defaultModel: "model-a", defaultThinkingLevel: "off", packages: [], enableInstallTelemetry: false });
  const projectSettings = JSON.stringify({ compaction: { enabled: false } });
  await writeFile(settingsFile, settings);
  await writeFile(projectFile, projectSettings);
  const model = (id: string) => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: {
    "feishu-test": { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "fake-test-key-not-a-real-credential", models: [model("model-a"), model("org/model-b")] },
  } }));
  const envKeys = ["PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_SUBAGENT_PI_BINARY"] as const;
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = "1";
  delete process.env.PI_SUBAGENT_PI_BINARY;
  const sessions: RpcAgentSession[] = [];
  const create = async (options: { savedPath?: string; selectedModel?: { provider: string; modelId: string } } = {}) => {
    const session = await RpcAgentSession.create({ cwd, sessionDir, ...options });
    sessions.push(session);
    return session;
  };
  try {
    const a = await create();
    const b = await create();
    expect(a.modelSettingsIsolated).toBe(true);
    expect(await executeModelControl(a, { type: "models", page: 1 })).toContain("feishu-test/model-a");
    let selected: { provider: string; modelId: string } | undefined;
    await executeModelControl(a, { type: "model", target: "feishu-test/org/model-b" }, async (value) => { selected = value; });
    expect((await a.request("get_state")).model.id).toBe("org/model-b");
    expect((await b.request("get_state")).model.id).toBe("model-a");
    expect(await readFile(settingsFile, "utf8")).toBe(settings);
    expect(await readFile(projectFile, "utf8")).toBe(projectSettings);
    // No assistant response yet: Pi intentionally has not flushed a JSONL.
    expect(existsSync(a.sessionFile)).toBe(false);
    await a.dispose();
    const emptyRestored = await create({ selectedModel: selected });
    expect((await emptyRestored.request("get_state")).model.id).toBe("org/model-b");
    const newChat = await create();
    expect((await newChat.request("get_state")).model.id).toBe("model-a");

    // Seed a local finalized transcript so genuine JSONL model persistence and
    // restart behavior can be tested without a paid/network model response.
    const historyFile = join(sessionDir, "history.jsonl");
    const now = new Date().toISOString();
    const header = { type: "session", version: 3, id: "history-test", timestamp: now, cwd };
    const entries = [
      header,
      { type: "model_change", id: "00000001", parentId: null, timestamp: now, provider: "feishu-test", modelId: "model-a" },
      { type: "message", id: "00000002", parentId: "00000001", timestamp: now, message: { role: "user", content: "history sentinel", timestamp: Date.now() } },
      { type: "message", id: "00000003", parentId: "00000002", timestamp: now, message: { role: "assistant", content: [{ type: "text", text: "local test response" }], api: "openai-completions", provider: "feishu-test", model: "model-a", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() } },
    ];
    await writeFile(historyFile, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", { mode: 0o600 });
    const history = await create({ savedPath: historyFile });
    await executeModelControl(history, { type: "model", target: "feishu-test/org/model-b" });
    await history.dispose();
    const restored = await create({ savedPath: historyFile });
    expect((await restored.request("get_state")).model.id).toBe("org/model-b");
    expect(JSON.stringify((await restored.request("get_messages")).messages)).toContain("history sentinel");
    expect(await readFile(historyFile, "utf8")).toContain('"modelId":"org/model-b"');
    expect(await readFile(settingsFile, "utf8")).toBe(settings);
    expect(await readFile(projectFile, "utf8")).toBe(projectSettings);
    await expect(executeModelControl(restored, { type: "model", target: "feishu-test/missing" })).rejects.toThrow("找不到");
  } finally {
    await Promise.allSettled(sessions.map((session) => session.dispose()));
    for (const key of envKeys) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
