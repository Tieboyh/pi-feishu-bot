import { expect, test } from "bun:test";
import {
  findManagedSession,
  formatSessionList,
  formatSessionHelp,
  migrateSessionIndex,
  parseSessionControlCommand,
  uniqueDefaultSessionName,
  type ChatSessionState,
} from "../src/sessions/session-control.ts";

test("Chinese phrases are ordinary messages, not session commands", () => {
  for (const input of [
    "开一个新会话", "开一个的新会话", "清空当前上下文", "重置会话上下文",
    "开一个名为“项目 A”的新会话", "新建会话：后端排障", "开一个新会话，名字叫 前端开发",
    "查看历史会话", "会话列表", "当前是什么会话", "当前会话", "切换到会话 项目 A",
    "恢复上一个会话", "恢复会话", "恢复会话 项目 A", "删除会话 项目 A",
    "确认删除会话 项目 A", "确认删除", "取消删除", "请帮我分析如何切换会话", "", "   ",
  ]) {
    expect(parseSessionControlCommand(input)).toBeUndefined();
  }
});

test("version 1 indexes migrate without losing the active session path", () => {
  let next = 0;
  const index = migrateSessionIndex({ version: 1, sessions: { "user:u1": "/tmp/one.jsonl" } }, () => `id-${++next}`, "2026-01-02T03:04:05.000Z");
  expect(index.version).toBe(2);
  expect(index.chats["user:u1"]?.activeId).toBe("id-1");
  expect(index.chats["user:u1"]?.sessions[0]).toEqual({
    id: "id-1",
    name: "历史会话 1",
    file: "/tmp/one.jsonl",
    createdAt: "2026-01-02T03:04:05.000Z",
    lastUsedAt: "2026-01-02T03:04:05.000Z",
  });
});

test("session lookup accepts names, full IDs, and unique displayed ID prefixes", () => {
  const chat: ChatSessionState = {
    activeId: "12345678-aaaa",
    sessions: [
      { id: "12345678-aaaa", name: "项目 A", file: "/a", createdAt: "2026", lastUsedAt: "2026" },
      { id: "87654321-bbbb", name: "项目 B", file: "/b", createdAt: "2026", lastUsedAt: "2026" },
    ],
  };
  expect(findManagedSession(chat, "项目 A")?.id).toBe("12345678-aaaa");
  expect(findManagedSession(chat, "87654321")?.name).toBe("项目 B");
  expect(uniqueDefaultSessionName(chat)).toBe("会话 1");
  expect(formatSessionList(chat)).toContain("项目 A（当前）");
});


test("slash commands reuse session actions and preserve names", () => {
  const cases = [
    ["/help", { type: "help" }],
    [" /HELP ", { type: "help" }],
    ["/new", { type: "new" }],
    ["/new 项目 A", { type: "new", name: "项目 A" }],
    ['/new "Release!"', { type: "new", name: "Release!" }],
    ["/list", { type: "list" }],
    ["/current", { type: "current" }],
    ["/models", { type: "models", page: 1 }],
    ["/MODELS 2", { type: "models", page: 2 }],
    ["/model", { type: "model" }],
    ["/MODEL example/org/very-long-model-id-more-than-forty-characters", { type: "model", target: "example/org/very-long-model-id-more-than-forty-characters" }],
    ["/switch 项目 A", { type: "switch", target: "项目 A" }],
    ["/switch bb618197", { type: "switch", target: "bb618197" }],
    ["/restore", { type: "restore" }],
    ["/delete 项目 A", { type: "delete", target: "项目 A" }],
    ["/confirm", { type: "confirm-delete" }],
    ["/confirm bb618197", { type: "confirm-delete", target: "bb618197" }],
    ["/cancel", { type: "cancel-delete" }],
  ] as const;
  for (const [input, expected] of cases) expect(parseSessionControlCommand(input)).toEqual(expected);
});

test("invalid slash commands show usage instead of executing or reaching the model", () => {
  for (const input of ["/switch", "/delete", "/list extra", "/confirm-delete", "/unknown", "/new\n/delete A", "/new " + "a".repeat(41), '/new ""', "/model incomplete", "/model /id", "/model provider/", "/model p/id extra", "/models 0", "/models -1", "/models 1.5", "/models all", "/models 999999999999999999999"]) {
    const command = parseSessionControlCommand(input);
    expect(command?.type).toBe("help");
    if (command?.type === "help") expect(command.error).toBeTruthy();
  }
  for (const input of ["解释 /new 的用途", "请分析如何创建会话", "不要执行 /delete A", "`/new`", "https://example.com/help"]) {
    expect(parseSessionControlCommand(input)).toBeUndefined();
  }
});

test("help includes every supported command and deletion confirmation boundary", () => {
  const help = formatSessionHelp("参数缺失");
  expect(help.startsWith("参数缺失\n")).toBe(true);
  for (const command of ["/help", "/new", "/list", "/current", "/switch", "/restore", "/delete", "/confirm", "/cancel", "/models", "/model"]) {
    expect(help).toContain(command);
  }
  expect(help).toContain("5 分钟");
  expect(help).toContain("群内共享");
  expect(help).toContain("不改变全局默认模型");
});

test("index round trips explicit model choices for sessions without JSONL history", () => {
  const now = "2026-01-02T03:04:05.000Z";
  const session = { id: "s1", name: "空会话", file: "/missing.jsonl", createdAt: now, lastUsedAt: now, model: { provider: "example", modelId: "org/model-b" } };
  const input = { version: 2, chats: { "user:u1": { activeId: "s1", sessions: [session] }, "user:u2": { activeId: "s2", sessions: [{ ...session, id: "s2", model: { provider: "", modelId: 123 } }] } } };
  const index = migrateSessionIndex(JSON.parse(JSON.stringify(input)), () => "unused", now);
  expect(index.chats["user:u1"]?.sessions[0]).toEqual(session);
  expect(index.chats["user:u2"]?.sessions[0]?.model).toBeUndefined();
});
