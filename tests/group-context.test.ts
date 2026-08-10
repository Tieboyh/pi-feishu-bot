import { describe, expect, test } from "bun:test";
import {
  buildSafeLarkCliEnv,
  fetchRecentGroupContext,
  fetchRecentGroupContextViaLarkCli,
  readableMessageContent,
  type GroupHistoryClient,
} from "../src/messaging/group-context.ts";

test("lark-cli 子进程环境不会继承飞书机器人凭据", () => {
  const env = buildSafeLarkCliEnv({
    PATH: "/bin",
    HOME: "/home/example",
    FEISHU_APP_SECRET: "secret",
    LARK_APP_ID: "app",
    RANDOM_SECRET: "hidden",
  });
  expect(env.PATH).toBe("/bin");
  expect(env.HOME).toBe("/home/example");
  expect(env.FEISHU_APP_SECRET).toBeUndefined();
  expect(env.LARK_APP_ID).toBeUndefined();
  expect(env.RANDOM_SECRET).toBeUndefined();
});

describe("readableMessageContent", () => {
  test("解析文字、富文本和附件占位符", () => {
    expect(readableMessageContent({ msg_type: "text", body: { content: JSON.stringify({ text: " 你好\n世界 " }) } })).toBe("你好 世界");
    expect(readableMessageContent({
      msg_type: "post",
      body: { content: JSON.stringify({ zh_cn: { title: "进展", content: [[{ tag: "text", text: "已完成" }]] } }) },
    })).toBe("进展 已完成");
    expect(readableMessageContent({ msg_type: "image" })).toBe("[图片]");
  });
});

describe("fetchRecentGroupContext", () => {
  test("只保留触发消息之前的人类消息，并按时间正序返回", async () => {
    let params: Record<string, unknown> | undefined;
    const client: GroupHistoryClient = {
      im: { v1: { message: { list: async (payload) => {
        params = payload.params;
        return {
          code: 0,
          data: {
            items: [
              { message_id: "trigger", msg_type: "text", sender: { sender_type: "user", sender_name: "李四" }, body: { content: JSON.stringify({ text: "@机器人 总结" }) } },
              { message_id: "bot", msg_type: "text", sender: { sender_type: "app", sender_name: "机器人" }, body: { content: JSON.stringify({ text: "旧回复" }) } },
              { message_id: "previous-trigger", msg_type: "text", sender: { sender_type: "user", sender_name: "王五" }, mentions: [{ id: "bot-open-id" }], body: { content: JSON.stringify({ text: "@机器人 旧请求" }) } },
              { message_id: "m2", msg_type: "image", sender: { sender_type: "user", sender_name: "李四" } },
              { message_id: "m1", msg_type: "text", sender: { sender_type: "user", sender_name: "张三" }, body: { content: JSON.stringify({ text: "讨论方案 A" }) } },
            ],
          },
        };
      } } } },
    };

    const context = await fetchRecentGroupContext(client, {
      chatId: "oc_group",
      triggerMessageId: "trigger",
      messageLimit: 20,
      lookbackMs: 30 * 60_000,
      botOpenId: "bot-open-id",
      nowMs: 1_800_000,
    });

    expect(context).toBe("- 张三：讨论方案 A\n- 李四：[图片]");
    expect(params).toMatchObject({
      container_id_type: "chat",
      container_id: "oc_group",
      start_time: "0",
      end_time: "1800",
      sort_type: "ByCreateTimeDesc",
      page_size: 40,
      with_sender_name: true,
    });
  });

  test("禁用时不请求接口", async () => {
    let called = false;
    const client: GroupHistoryClient = {
      im: { v1: { message: { list: async () => {
        called = true;
        return { code: 0 };
      } } } },
    };
    expect(await fetchRecentGroupContext(client, {
      chatId: "oc_group",
      triggerMessageId: "trigger",
      messageLimit: 0,
      lookbackMs: 30 * 60_000,
    })).toBeUndefined();
    expect(called).toBeFalse();
  });

  test("通过 lark-cli 用户身份拉取并规范化消息", async () => {
    let args: string[] = [];
    const context = await fetchRecentGroupContextViaLarkCli({
      chatId: "oc_group",
      triggerMessageId: "trigger",
      messageLimit: 10,
      lookbackMs: 30 * 60_000,
      nowMs: Date.parse("2026-08-10T04:00:00.000Z"),
    }, async (received) => {
      args = received;
      return JSON.stringify([
        { message_id: "m2", msg_type: "image", deleted: false, sender: { sender_type: "user", name: "李四" }, content: "![Image](img_xxx)", mentions: null },
        { message_id: "m1", msg_type: "text", deleted: false, sender: { sender_type: "user", name: "张三" }, content: "讨论方案 A", mentions: null },
      ]);
    });

    expect(context).toBe("- 张三：讨论方案 A\n- 李四：[图片]");
    expect(args).not.toContain("lark-cli-user");
    expect(args).toEqual(expect.arrayContaining([
      "im", "+chat-messages-list", "--as", "user", "--chat-id", "oc_group",
      "--start", "2026-08-10T03:30:00.000Z", "--end", "2026-08-10T04:00:00.000Z",
    ]));
  });

  test("接口错误会向调用方抛出清晰错误", async () => {
    const client: GroupHistoryClient = {
      im: { v1: { message: { list: async () => ({ code: 999, msg: "forbidden" }) } } },
    };
    await expect(fetchRecentGroupContext(client, {
      chatId: "oc_group",
      triggerMessageId: "trigger",
      messageLimit: 10,
      lookbackMs: 30 * 60_000,
    })).rejects.toThrow("forbidden");
  });
});
