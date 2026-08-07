export const INITIAL_PROGRESS = "🤖 收到，正在处理…\n\n";
export const THINKING_PROGRESS = "💭 思考中…\n\n";
export const MAX_CARD_MARKDOWN_CHARS = 28_000;

export function toolProgress(toolName: string, detail = ""): string {
  return `\n🛠 ${toolName}${detail ? " " + detail : ""}\n`;
}

function splitMarkdown(markdown: string, maxChars = MAX_CARD_MARKDOWN_CHARS): string[] {
  if (!markdown) return ["（无文本回复）"];
  const chunks: string[] = [];
  for (let offset = 0; offset < markdown.length; offset += maxChars) {
    chunks.push(markdown.slice(offset, offset + maxChars));
  }
  return chunks;
}

function card(markdown: string, summary: string, streaming: boolean, maxChars = MAX_CARD_MARKDOWN_CHARS): object {
  return {
    schema: "2.0",
    config: { streaming_mode: streaming, summary: { content: summary } },
    body: {
      elements: splitMarkdown(markdown, maxChars).map((content) => ({ tag: "markdown", content })),
    },
  };
}

export function progressMarkdown(content: string, maxChars = MAX_CARD_MARKDOWN_CHARS): string {
  if (content.length <= maxChars) return content;
  const marker = "\n\n…处理中内容已截断，最终回答完成后将完整显示。";
  return content.slice(0, Math.max(0, maxChars - marker.length)) + marker;
}

export function progressCard(markdown: string, maxChars = MAX_CARD_MARKDOWN_CHARS): object {
  return card(progressMarkdown(markdown, maxChars), "处理中", true, maxChars);
}

export function finalMarkdownCard(markdown: string, maxChars = MAX_CARD_MARKDOWN_CHARS): object {
  return card(markdown, summarize(markdown), false, maxChars);
}

export function failureCard(message: string): object {
  return card(`❌ 处理失败：${message}`, "处理失败", false);
}

function summarize(markdown: string): string {
  const text = markdown.replace(/\s+/g, " ").trim();
  if (!text) return "处理完成";
  return text.length > 50 ? text.slice(0, 49) + "…" : text;
}
