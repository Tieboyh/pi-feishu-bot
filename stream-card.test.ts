import { describe, expect, test } from "bun:test";
import {
  failureCard,
  finalMarkdownCard,
  INITIAL_PROGRESS,
  THINKING_PROGRESS,
  toolProgress,
} from "./stream-card.ts";

function cardText(card: any): string {
  return card.body.elements.map((element: any) => element.content ?? "").join("\n");
}

describe("stream cards", () => {
  test("intermediate feed includes status, thinking, and tools", () => {
    const intermediate = INITIAL_PROGRESS + THINKING_PROGRESS + toolProgress("read", "index.ts") + "正文片段";
    expect(intermediate).toContain("收到，正在处理");
    expect(intermediate).toContain("思考中");
    expect(intermediate).toContain("🛠 read index.ts");
    expect(intermediate).toContain("正文片段");
  });

  test("success replaces all progress with final answer only", () => {
    const card = finalMarkdownCard("最终答案 **完成**") as any;
    expect(card.config.streaming_mode).toBe(false);
    expect(cardText(card)).toBe("最终答案 **完成**");
    expect(JSON.stringify(card)).not.toContain("收到，正在处理");
    expect(JSON.stringify(card)).not.toContain("思考中");
    expect(JSON.stringify(card)).not.toContain("🛠");
  });

  test("failure replaces progress with a concise error", () => {
    const card = failureCard("模型暂时不可用") as any;
    expect(card.config.streaming_mode).toBe(false);
    expect(cardText(card)).toBe("❌ 处理失败：模型暂时不可用");
    expect(JSON.stringify(card)).not.toContain("收到，正在处理");
  });
});
