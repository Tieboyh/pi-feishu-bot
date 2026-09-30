import type { ModelControlCommand } from "./model-control.ts";

export interface ManagedSession {
  id: string;
  name: string;
  file: string;
  createdAt: string;
  lastUsedAt: string;
  model?: { provider: string; modelId: string };
}

export interface ChatSessionState {
  activeId?: string;
  previousId?: string;
  sessions: ManagedSession[];
}

export interface SessionIndexV2 {
  version: 2;
  chats: Record<string, ChatSessionState>;
}

export type SessionControlCommand =
  | ModelControlCommand
  | { type: "help"; error?: string }
  | { type: "new"; name?: string }
  | { type: "list" }
  | { type: "current" }
  | { type: "switch"; target: string }
  | { type: "restore" }
  | { type: "delete"; target: string }
  | { type: "confirm-delete"; target?: string }
  | { type: "cancel-delete" };

export function normalizeSessionName(value: string): string {
  const name = value.replace(/^[“”"'‘’]+|[“”"'‘’]+$/gu, "").replace(/\s+/gu, " ").trim();
  if (!name) throw new Error("会话名称不能为空。");
  if (name.length > 40) throw new Error("会话名称不能超过 40 个字符。");
  return name;
}

export function formatSessionHelp(error?: string): string {
  return [
    ...(error ? [error, ""] : []),
    "会话与模型命令（直接发送，不需要让 AI 执行）：",
    "/help — 显示帮助",
    "/new [名称] — 创建并切换到新会话",
    "/list — 查看当前聊天的历史会话",
    "/current — 查看当前会话",
    "/models [页码] — 查看可用模型",
    "/model — 查看当前模型",
    "/model <provider>/<modelId> — 切换当前会话模型",
    "/switch <名称或短 ID> — 切换会话并恢复历史",
    "/restore — 恢复上一个会话",
    "/delete <名称或短 ID> — 发起删除（需要确认）",
    "/confirm [名称或短 ID] — 确认自己在 5 分钟内发起的删除",
    "/cancel — 取消自己发起的删除",
    "",
    "例：/new 项目 A，然后用 /list 查看、/switch 项目 A 切换。",
    "群聊默认需要 @机器人；群内共享会话，私聊按用户隔离。",
    "有任务执行或排队时，需等待完成再新建、切换会话或模型。",
    "模型选择随会话保存；群内切换影响当前群共享会话，不改变全局默认模型。",
    "仅支持以上英文斜杠命令，会话名称可以使用中文。",
  ].join("\n");
}

function parseSlashCommand(input: string): SessionControlCommand {
  const match = input.match(/^\/([a-z-]+)(?:[ \t]+([^\r\n]+))?$/iu);
  if (!match) return { type: "help", error: "命令格式不正确，请单独发送一条命令。" };
  const command = match[1]!.toLowerCase();
  const argument = match[2]?.trim();
  if (command === "models") {
    if (argument && (!/^[1-9]\d*$/u.test(argument) || !Number.isSafeInteger(Number(argument)))) {
      return { type: "help", error: "用法：/models [正整数页码]。" };
    }
    return { type: "models", page: argument ? Number(argument) : 1 };
  }
  if (command === "model") {
    if (!argument) return { type: "model" };
    if (!/^[^\s/]+\/[^\s]+$/u.test(argument)) {
      return { type: "help", error: "用法：/model <provider>/<modelId>，请从 /models 复制完整标识。" };
    }
    return { type: "model", target: argument };
  }
  const noArgument = {
    help: "help", list: "list", current: "current", restore: "restore", cancel: "cancel-delete",
  } as const;
  if (Object.prototype.hasOwnProperty.call(noArgument, command)) {
    if (argument) return { type: "help", error: `/${command} 不接受参数。` };
    return { type: noArgument[command as keyof typeof noArgument] };
  }
  if (!["new", "switch", "delete", "confirm"].includes(command)) {
    return { type: "help", error: `未知命令：/${command}。` };
  }
  if (!argument) {
    if (command === "new") return { type: "new" };
    if (command === "confirm") return { type: "confirm-delete" };
    return { type: "help", error: `用法：/${command} <名称或短 ID>` };
  }
  try {
    const target = normalizeSessionName(argument);
    if (command === "new") return { type: "new", name: target };
    if (command === "confirm") return { type: "confirm-delete", target };
    return { type: command as "switch" | "delete", target };
  } catch (error) {
    return { type: "help", error: error instanceof Error ? error.message : "会话名称无效。" };
  }
}

export function parseSessionControlCommand(input: string): SessionControlCommand | undefined {
  const text = input.trim();
  return text.startsWith("/") ? parseSlashCommand(text) : undefined;
}

export function emptySessionIndex(): SessionIndexV2 {
  return { version: 2, chats: {} };
}

export function migrateSessionIndex(
  parsed: unknown,
  idFactory: () => string,
  now = new Date().toISOString(),
): SessionIndexV2 {
  const value = parsed as any;
  if (value?.version === 2 && value.chats && typeof value.chats === "object") {
    const chats: Record<string, ChatSessionState> = {};
    for (const [key, rawChat] of Object.entries(value.chats as Record<string, any>)) {
      if (!rawChat || !Array.isArray(rawChat.sessions)) continue;
      const sessions = rawChat.sessions.filter((entry: any) =>
        entry && typeof entry.id === "string" && typeof entry.name === "string" && typeof entry.file === "string",
      ).map((entry: any) => ({
        id: entry.id,
        name: entry.name,
        file: entry.file,
        createdAt: typeof entry.createdAt === "string" ? entry.createdAt : now,
        lastUsedAt: typeof entry.lastUsedAt === "string" ? entry.lastUsedAt : now,
        ...(typeof entry.model?.provider === "string" && entry.model.provider && typeof entry.model?.modelId === "string" && entry.model.modelId
          ? { model: { provider: entry.model.provider, modelId: entry.model.modelId } } : {}),
      }));
      const ids = new Set(sessions.map((entry: ManagedSession) => entry.id));
      chats[key] = {
        sessions,
        ...(typeof rawChat.activeId === "string" && ids.has(rawChat.activeId) ? { activeId: rawChat.activeId } : {}),
        ...(typeof rawChat.previousId === "string" && ids.has(rawChat.previousId) ? { previousId: rawChat.previousId } : {}),
      };
    }
    return { version: 2, chats };
  }

  const index = emptySessionIndex();
  if (value?.version === 1 && value.sessions && typeof value.sessions === "object") {
    for (const [key, file] of Object.entries(value.sessions)) {
      if (typeof file !== "string") continue;
      const id = idFactory();
      index.chats[key] = {
        activeId: id,
        sessions: [{ id, name: "历史会话 1", file, createdAt: now, lastUsedAt: now }],
      };
    }
  }
  return index;
}

export function findManagedSession(chat: ChatSessionState | undefined, target: string): ManagedSession | undefined {
  if (!chat) return undefined;
  const normalized = target.trim().toLocaleLowerCase();
  const exact = chat.sessions.find((entry) => entry.id === target || entry.name.toLocaleLowerCase() === normalized);
  if (exact) return exact;
  const idMatches = chat.sessions.filter((entry) => entry.id.startsWith(target));
  return idMatches.length === 1 ? idMatches[0] : undefined;
}

export function uniqueDefaultSessionName(chat: ChatSessionState | undefined): string {
  const used = new Set((chat?.sessions ?? []).map((entry) => entry.name.toLocaleLowerCase()));
  for (let number = 1; ; number++) {
    const candidate = `会话 ${number}`;
    if (!used.has(candidate.toLocaleLowerCase())) return candidate;
  }
}

export function formatSessionList(chat: ChatSessionState | undefined): string {
  if (!chat || chat.sessions.length === 0) return "当前聊天还没有历史会话。";
  const ordered = [...chat.sessions].sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
  return ["📚 当前聊天的历史会话：", ...ordered.map((entry, index) => {
    const active = entry.id === chat.activeId ? "（当前）" : "";
    return `${index + 1}. ${entry.name}${active}\n   ID: ${entry.id.slice(0, 8)} · 最后使用: ${entry.lastUsedAt.replace("T", " ").slice(0, 16)}`;
  })].join("\n");
}
