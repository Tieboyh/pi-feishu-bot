export interface ManagedSession {
  id: string;
  name: string;
  file: string;
  createdAt: string;
  lastUsedAt: string;
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
  | { type: "new"; name?: string }
  | { type: "list" }
  | { type: "current" }
  | { type: "switch"; target: string }
  | { type: "restore" }
  | { type: "delete"; target: string }
  | { type: "confirm-delete"; target?: string }
  | { type: "cancel-delete" };

function cleanText(value: string): string {
  return value.trim().replace(/[。！!？?]+$/u, "").trim();
}

export function normalizeSessionName(value: string): string {
  const name = value.replace(/^[“”"'‘’]+|[“”"'‘’]+$/gu, "").replace(/\s+/gu, " ").trim();
  if (!name) throw new Error("会话名称不能为空。");
  if (name.length > 40) throw new Error("会话名称不能超过 40 个字符。");
  return name;
}

export function parseSessionControlCommand(input: string): SessionControlCommand | undefined {
  const text = cleanText(input);
  if (!text) return undefined;

  if (/^(?:清空|重置)(?:当前)?(?:会话)?上下文$/u.test(text) || /^(?:开|创建|新建)(?:一个)?新会话$/u.test(text)) {
    return { type: "new" };
  }
  let match = text.match(/^(?:开|创建|新建)(?:一个)?(?:名为|叫)[“”"'‘’]?(.+?)[“”"'‘’]?的?新会话$/u);
  if (!match) match = text.match(/^(?:开|创建|新建)(?:一个)?新会话[，,：:\s]+(?:名字?(?:叫|是)|名为)[：:\s]*[“”"'‘’]?(.+?)[“”"'‘’]?$/u);
  if (!match) match = text.match(/^(?:创建|新建)会话[：:\s]+(.+)$/u);
  if (match) return { type: "new", name: normalizeSessionName(match[1]!) };

  if (/^(?:查看|列出|显示)(?:我的|当前聊天的)?(?:历史)?会话(?:列表)?$/u.test(text) || /^会话列表$/u.test(text)) {
    return { type: "list" };
  }
  if (/^(?:当前|现在)(?:是|使用的)?(?:什么|哪个)?会话$/u.test(text) || /^当前会话$/u.test(text)) {
    return { type: "current" };
  }
  if (/^(?:恢复会话|恢复上一个(?:历史)?会话|恢复上一(?:历史)?会话|切回上一个(?:历史)?会话|切回上一(?:历史)?会话)$/u.test(text)) return { type: "restore" };

  match = text.match(/^(?:恢复会话|切换到会话|切换会话|切换到|切换)[：:\s]+[“”"'‘’]?(.+?)[“”"'‘’]?$/u);
  if (match) return { type: "switch", target: normalizeSessionName(match[1]!) };

  if (/^(?:取消删除|取消删除会话)$/u.test(text)) return { type: "cancel-delete" };
  match = text.match(/^确认删除(?:会话)?(?:[：:\s]+[“”"'‘’]?(.+?)[“”"'‘’]?)?$/u);
  if (match) return { type: "confirm-delete", ...(match[1] ? { target: normalizeSessionName(match[1]) } : {}) };
  match = text.match(/^删除(?:历史)?会话[：:\s]*[“”"'‘’]?(.+?)[“”"'‘’]?$/u);
  if (match) return { type: "delete", target: normalizeSessionName(match[1]!) };

  return undefined;
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
