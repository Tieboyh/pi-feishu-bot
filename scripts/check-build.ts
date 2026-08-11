import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const outdir = await mkdtemp(join(tmpdir(), "pi-feishu-bot-check-"));
try {
  const result = await Bun.build({
    entrypoints: ["src/index.ts"],
    target: "node",
    outdir,
    external: [
      "@earendil-works/pi-coding-agent",
      "@larksuiteoapi/node-sdk",
    ],
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exitCode = 1;
  }
} finally {
  await rm(outdir, { recursive: true, force: true });
}
