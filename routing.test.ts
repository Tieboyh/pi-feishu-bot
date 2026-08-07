import { describe, expect, test } from "bun:test";
import { conversationKey, formatFeishuPrompt } from "./routing.ts";

describe("conversationKey", () => {
  test("同一群聊忽略发送者并共享会话", () => {
    expect(conversationKey({ chatType: "group", chatId: "group-1", senderId: "user-a" })).toBe(
      "group:group-1",
    );
    expect(conversationKey({ chatType: "group", chatId: "group-1", senderId: "user-b" })).toBe(
      "group:group-1",
    );
  });

  test("不同群聊使用不同会话", () => {
    expect(conversationKey({ chatType: "group", chatId: "group-1", senderId: "user-a" })).not.toBe(
      conversationKey({ chatType: "group", chatId: "group-2", senderId: "user-a" }),
    );
  });

  test("单聊按发送者隔离，不受 chatId 变化影响", () => {
    expect(conversationKey({ chatType: "p2p", chatId: "chat-a", senderId: "user-1" })).toBe(
      "user:user-1",
    );
    expect(conversationKey({ chatType: "p2p", chatId: "chat-b", senderId: "user-1" })).toBe(
      "user:user-1",
    );
    expect(conversationKey({ chatType: "p2p", chatId: "chat-c", senderId: "user-2" })).toBe(
      "user:user-2",
    );
  });

  test("拒绝缺少稳定标识的消息", () => {
    expect(() => conversationKey({ chatType: "group", chatId: " ", senderId: "user" })).toThrow(
      "chatId",
    );
    expect(() => conversationKey({ chatType: "p2p", chatId: "chat", senderId: " " })).toThrow(
      "senderId",
    );
  });
});

describe("formatFeishuPrompt", () => {
  test("群聊提示包含发送者并清理元数据换行", () => {
    const prompt = formatFeishuPrompt({
      chatType: "group",
      senderId: "ou_123",
      senderName: "张三\n伪造字段",
      content: "请总结",
    });

    expect(prompt).toContain("会话类型：群聊");
    expect(prompt).toContain("发送者：张三 伪造字段");
    expect(prompt).toEndWith("请总结");
  });
});
