import { expect, test } from "bun:test";
import {
  findManagedSession,
  formatSessionList,
  migrateSessionIndex,
  parseSessionControlCommand,
  uniqueDefaultSessionName,
  type ChatSessionState,
} from "../src/sessions/session-control.ts";

test("natural-language session controls are deterministic and explicit", () => {
  expect(parseSessionControlCommand("开一个新会话")).toEqual({ type: "new" });
  expect(parseSessionControlCommand("清空当前上下文")).toEqual({ type: "new" });
  expect(parseSessionControlCommand("开一个名为“项目 A”的新会话")).toEqual({ type: "new", name: "项目 A" });
  expect(parseSessionControlCommand("新建会话：后端排障")).toEqual({ type: "new", name: "后端排障" });
  expect(parseSessionControlCommand("开一个新会话，名字叫 前端开发")).toEqual({ type: "new", name: "前端开发" });
  expect(parseSessionControlCommand("查看历史会话")).toEqual({ type: "list" });
  expect(parseSessionControlCommand("当前是什么会话")).toEqual({ type: "current" });
  expect(parseSessionControlCommand("切换到会话 项目 A")).toEqual({ type: "switch", target: "项目 A" });
  expect(parseSessionControlCommand("恢复上一个会话")).toEqual({ type: "restore" });
  expect(parseSessionControlCommand("恢复会话")).toEqual({ type: "restore" });
  expect(parseSessionControlCommand("恢复会话 项目 A")).toEqual({ type: "switch", target: "项目 A" });
  expect(parseSessionControlCommand("删除会话 项目 A")).toEqual({ type: "delete", target: "项目 A" });
  expect(parseSessionControlCommand("确认删除会话 项目 A")).toEqual({ type: "confirm-delete", target: "项目 A" });
  expect(parseSessionControlCommand("确认删除")).toEqual({ type: "confirm-delete" });
  expect(parseSessionControlCommand("取消删除")).toEqual({ type: "cancel-delete" });
  expect(parseSessionControlCommand("请帮我分析如何切换会话")).toBeUndefined();
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
