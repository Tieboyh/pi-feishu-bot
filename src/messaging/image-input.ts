export interface RpcImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ImageResource {
  type: "image";
  fileKey: string;
}

export interface ImageInputLimits {
  maxImages: number;
  maxBytesPerImage: number;
  maxTotalBytes: number;
}

export const DEFAULT_IMAGE_LIMITS: ImageInputLimits = {
  maxImages: 4,
  maxBytesPerImage: 10 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
};

export function detectImageMimeType(buffer: Buffer): string | undefined {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

export function sanitizeImageMessageText(content: string, imageCount: number): string {
  const cleaned = content
    .replace(/!\[image\]\([^\r\n)]+\)/giu, "")
    .replace(/<image\b[^>]*\/?\s*>/giu, "")
    .replace(/\[image\]/giu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  const instruction = imageCount === 1 ? "请查看并分析我发送的图片。" : `请查看并分析我发送的 ${imageCount} 张图片。`;
  return cleaned ? `${cleaned}\n\n[已附加 ${imageCount} 张图片]` : instruction;
}

export async function downloadRpcImages(
  resources: readonly ImageResource[],
  download: (fileKey: string) => Promise<Buffer>,
  limits: ImageInputLimits = DEFAULT_IMAGE_LIMITS,
): Promise<RpcImageContent[]> {
  if (resources.length === 0) return [];
  if (resources.length > limits.maxImages) throw new Error(`单条消息最多支持 ${limits.maxImages} 张图片。`);

  const images: RpcImageContent[] = [];
  let totalBytes = 0;
  for (const resource of resources) {
    const buffer = await download(resource.fileKey);
    if (buffer.length === 0) throw new Error("飞书返回了空图片。");
    if (buffer.length > limits.maxBytesPerImage) {
      throw new Error(`单张图片不能超过 ${Math.floor(limits.maxBytesPerImage / 1024 / 1024)} MB。`);
    }
    totalBytes += buffer.length;
    if (totalBytes > limits.maxTotalBytes) {
      throw new Error(`单条消息图片总大小不能超过 ${Math.floor(limits.maxTotalBytes / 1024 / 1024)} MB。`);
    }
    const mimeType = detectImageMimeType(buffer);
    if (!mimeType) throw new Error("仅支持 PNG、JPEG、GIF 和 WebP 图片。");
    images.push({ type: "image", data: buffer.toString("base64"), mimeType });
  }
  return images;
}
