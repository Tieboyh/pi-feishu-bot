import { expect, test } from "bun:test";
import { executeModelControl } from "../src/sessions/model-control.ts";

const a = { provider: "example", id: "model-a", name: "Model A", input: ["text"] };
const b = { provider: "example", id: "org/model-b", name: "Model B", input: ["text", "image"] };
function mockSession(options: { models?: typeof a[]; state?: Record<string, unknown>; failure?: boolean; mismatch?: boolean; isolated?: boolean } = {}) {
  let model = a;
  const calls: Array<{ type: string; fields?: Record<string, unknown> }> = [];
  return {
    calls,
    modelSettingsIsolated: options.isolated ?? true,
    async request(type: string, fields?: Record<string, unknown>) {
      calls.push({ type, fields });
      if (type === "get_state") return { model, isStreaming: false, isCompacting: false, pendingMessageCount: 0, ...options.state };
      if (type === "get_available_models") return { models: options.models ?? [b, a] };
      if (type === "set_model") {
        if (options.failure) throw new Error("private-endpoint-and-secret");
        if (!options.mismatch) model = b;
        return model;
      }
      throw new Error("Unexpected RPC");
    },
  };
}

test("model query and paginated lists project only public model metadata", async () => {
  const session = mockSession();
  expect(await executeModelControl(session, { type: "model" })).toContain("example/model-a");
  const list = await executeModelControl(session, { type: "models", page: 1 });
  expect(list).toContain("example/model-a（当前）");
  expect(list).toContain("支持图片");
  expect(list.indexOf("example/model-a")).toBeLessThan(list.indexOf("example/org/model-b"));
  const privateModel = { ...b, baseUrl: "private-base-url", apiKey: "private-key" };
  const safe = await executeModelControl(mockSession({ models: [privateModel] }), { type: "models", page: 1 });
  expect(safe).not.toContain("private-base-url");
  expect(safe).not.toContain("private-key");
  const many = mockSession({ models: Array.from({ length: 25 }, (_, i) => ({ ...a, id: `model-${String(i).padStart(2, "0")}` })) });
  expect(await executeModelControl(many, { type: "models", page: 1 })).toContain("下一页：/models 2");
  const last = await executeModelControl(many, { type: "models", page: 3 });
  expect(last).toContain("model-24");
  expect(last).not.toContain("下一页");
  await expect(executeModelControl(many, { type: "models", page: 4 })).rejects.toThrow("3 页");
  expect(await executeModelControl(mockSession({ models: [] }), { type: "models", page: 1 })).toContain("没有可用模型");
});

test("switch uses the exact provider/id and verifies state before saving or announcing success", async () => {
  const session = mockSession();
  const saved: unknown[] = [];
  const result = await executeModelControl(session, { type: "model", target: "example/org/model-b" }, async (model) => { saved.push(model); });
  expect(session.calls.map((call) => call.type)).toEqual(["get_state", "get_available_models", "set_model", "get_state"]);
  expect(session.calls[2]?.fields).toEqual({ provider: "example", modelId: "org/model-b" });
  expect(saved).toEqual([{ provider: "example", modelId: "org/model-b" }]);
  expect(result).toContain("已切换当前会话模型");
  const other = mockSession();
  expect(await executeModelControl(other, { type: "model" })).toContain("example/model-a");
});

test("busy or unisolated runtimes cannot switch; unknown IDs do not reach set_model", async () => {
  for (const state of [{ isStreaming: true }, { isCompacting: true }, { pendingMessageCount: 1 }]) {
    const session = mockSession({ state });
    await expect(executeModelControl(session, { type: "model", target: "example/org/model-b" })).rejects.toThrow("等待完成");
    expect(session.calls.map((call) => call.type)).toEqual(["get_state"]);
  }
  await expect(executeModelControl(mockSession({ isolated: false }), { type: "model", target: "example/org/model-b" })).rejects.toThrow("自定义 Pi");
  const session = mockSession();
  await expect(executeModelControl(session, { type: "model", target: "unknown/id" })).rejects.toThrow("找不到");
  expect(session.calls.some((call) => call.type === "set_model")).toBe(false);
});

test("failed or unverified switches never save selections and do not expose private diagnostics", async () => {
  for (const options of [{ failure: true }, { mismatch: true }]) {
    let saves = 0;
    try {
      await executeModelControl(mockSession(options), { type: "model", target: "example/org/model-b" }, async () => { saves++; });
      throw new Error("Expected failure");
    } catch (error) {
      expect(String(error)).not.toContain("private-endpoint-and-secret");
      expect(String(error)).not.toContain("Expected failure");
    }
    expect(saves).toBe(0);
  }
});

test("selecting the current model still saves empty-session preferences without a redundant RPC switch", async () => {
  const session = mockSession();
  let saved: unknown;
  expect(await executeModelControl(session, { type: "model", target: "example/model-a" }, async (model) => { saved = model; })).toContain("当前已经是");
  expect(saved).toEqual({ provider: "example", modelId: "model-a" });
  expect(session.calls.some((call) => call.type === "set_model")).toBe(false);
  await expect(executeModelControl(session, { type: "model", target: "example/model-a" }, async () => { throw new Error("save failed"); })).rejects.toThrow("save failed");
});
