import { expect, test } from "bun:test";
import { Readable } from "node:stream";
import {
  detectImageMimeType,
  downloadFeishuMessageImage,
  downloadRpcImages,
  sanitizeImageMessageText,
} from "../src/messaging/image-input.ts";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
const gif = Buffer.from("GIF89a payload", "ascii");
const webp = Buffer.from("RIFFxxxxWEBPpayload", "ascii");

test("image MIME types are derived from bytes rather than untrusted names", () => {
  expect(detectImageMimeType(png)).toBe("image/png");
  expect(detectImageMimeType(jpeg)).toBe("image/jpeg");
  expect(detectImageMimeType(gif)).toBe("image/gif");
  expect(detectImageMimeType(webp)).toBe("image/webp");
  expect(detectImageMimeType(Buffer.from("not an image"))).toBeUndefined();
});

test("Feishu image keys are removed from the model-visible prompt", () => {
  const key = "img_v3_secret-resource-key";
  const prompt = sanitizeImageMessageText(`帮我看一下\n![image](${key})`, 1);
  expect(prompt).toContain("帮我看一下");
  expect(prompt).toContain("已附加 1 张图片");
  expect(prompt).not.toContain(key);
  expect(sanitizeImageMessageText(`![image](${key})`, 1)).toBe("请查看并分析我发送的图片。");
});

test("incoming images use the message resource endpoint, not bot-owned image.get", async () => {
  let payload: unknown;
  const buffer = await downloadFeishuMessageImage({
    im: { v1: { messageResource: { get: async (next) => {
      payload = next;
      return { getReadableStream: () => Readable.from([png.subarray(0, 4), png.subarray(4)]) };
    } } } },
  }, "om_message", "img_user_resource");
  expect(payload).toEqual({
    path: { message_id: "om_message", file_key: "img_user_resource" },
    params: { type: "image" },
  });
  expect(buffer).toEqual(png);
});

test("downloaded images are validated, bounded, and encoded for Pi RPC", async () => {
  const images = await downloadRpcImages(
    [{ type: "image", fileKey: "one" }, { type: "image", fileKey: "two" }],
    async (key) => key === "one" ? png : jpeg,
  );
  expect(images).toEqual([
    { type: "image", data: png.toString("base64"), mimeType: "image/png" },
    { type: "image", data: jpeg.toString("base64"), mimeType: "image/jpeg" },
  ]);
  await expect(downloadRpcImages(
    [{ type: "image", fileKey: "bad" }],
    async () => Buffer.from("bad"),
  )).rejects.toThrow("仅支持");
  await expect(downloadRpcImages(
    Array.from({ length: 5 }, (_, index) => ({ type: "image" as const, fileKey: String(index) })),
    async () => png,
  )).rejects.toThrow("最多支持 4 张");
});
