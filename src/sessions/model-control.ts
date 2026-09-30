export type ModelControlCommand =
  | { type: "models"; page: number }
  | { type: "model"; target?: string };

interface ModelSummary {
  provider: string;
  id: string;
  name?: string;
  input?: string[];
}

export interface ModelControlSession {
  readonly modelSettingsIsolated: boolean;
  request(type: string, fields?: Record<string, unknown>): Promise<any>;
}

const PAGE_SIZE = 12;
const modelKey = (model: ModelSummary) => `${model.provider}/${model.id}`;
const displayName = (model: ModelSummary) => (model.name ?? model.id).replace(/[\r\n\t]/g, " ");

export async function executeModelControl(
  session: ModelControlSession,
  command: ModelControlCommand,
  saveSelection: (model: { provider: string; modelId: string }) => Promise<void> = async () => {},
): Promise<string> {
  const state = await session.request("get_state");
  if (command.type === "model" && !command.target) {
    return state.model ? `当前模型：${displayName(state.model)}\n${modelKey(state.model)}` : "当前会话尚未选择模型，请发送 /models。";
  }
  if (command.type === "model") {
    if (state.isStreaming || state.isCompacting || state.pendingMessageCount > 0) {
      throw new Error("当前会话仍有任务正在处理，请等待完成后再切换模型。");
    }
    if (!session.modelSettingsIsolated) {
      throw new Error("自定义 Pi 启动器尚未验证配置隔离，暂不支持切换模型。请使用默认 RPC 启动器。");
    }
  }
  const { models } = await session.request("get_available_models") as { models: ModelSummary[] };
  if (command.type === "models") {
    if (models.length === 0) return "没有可用模型，请先在本机配置模型及认证信息。";
    const sorted = [...models].sort((a, b) => modelKey(a).localeCompare(modelKey(b)));
    const pages = Math.ceil(sorted.length / PAGE_SIZE);
    if (command.page > pages) throw new Error(`模型列表共 ${pages} 页，请发送 /models 1。`);
    const selected = sorted.slice((command.page - 1) * PAGE_SIZE, command.page * PAGE_SIZE);
    return [
      `可用模型（${command.page}/${pages} 页，共 ${models.length} 个）：`,
      ...selected.map((model) => `${modelKey(model)}${state.model && modelKey(state.model) === modelKey(model) ? "（当前）" : ""}\n  ${displayName(model)}${model.input?.includes("image") ? " · 支持图片" : ""}`),
      "",
      "切换：/model <provider>/<modelId>",
      ...(command.page < pages ? [`下一页：/models ${command.page + 1}`] : []),
    ].join("\n");
  }
  const target = models.find((model) => modelKey(model) === command.target);
  if (!target) throw new Error("找不到指定的可用模型，请从 /models 列表复制完整标识。");
  if (state.model && modelKey(state.model) === modelKey(target)) {
    await saveSelection({ provider: target.provider, modelId: target.id });
    return `当前已经是模型：${modelKey(target)}。`;
  }
  try {
    await session.request("set_model", { provider: target.provider, modelId: target.id });
  } catch {
    // Provider/extension diagnostics may contain private endpoint information.
    throw new Error("切换模型失败，请检查本机模型配置和认证信息，再用 /model 查看实际模型。");
  }
  const after = await session.request("get_state");
  if (!after.model || modelKey(after.model) !== modelKey(target)) throw new Error("未能确认切换结果，请用 /model 查看实际模型。");
  await saveSelection({ provider: target.provider, modelId: target.id });
  return `✅ 已切换当前会话模型：${modelKey(after.model)}\n保留历史上下文，从下一条消息起生效；不修改全局默认模型。`;
}
