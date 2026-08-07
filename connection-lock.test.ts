import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  acquireConnectionLock,
  FeishuConnectionBusyError,
  readConnectionLock,
  releaseConnectionLock,
} from "./connection-lock.ts";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function lockPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "feishu-lock-test-"));
  tempDirs.push(dir);
  return join(dir, "connection.lock");
}

const owner = { sessionId: "session-a", sessionFile: "/tmp/a.jsonl", cwd: "/workspace/a" };

describe("connection lock", () => {
  test("同一时间只允许一个持有者", async () => {
    const path = await lockPath();
    const lock = await acquireConnectionLock(path, owner);

    await expect(acquireConnectionLock(path, { ...owner, sessionId: "session-b" })).rejects.toBeInstanceOf(
      FeishuConnectionBusyError,
    );
    expect((await readConnectionLock(path))?.token).toBe(lock.token);
    expect(await releaseConnectionLock(path, lock)).toBe(true);
  });

  test("释放后其他会话可以获取", async () => {
    const path = await lockPath();
    const first = await acquireConnectionLock(path, owner);
    expect(await releaseConnectionLock(path, first)).toBe(true);

    const second = await acquireConnectionLock(path, { ...owner, sessionId: "session-b" });
    expect(second.sessionId).toBe("session-b");
    await releaseConnectionLock(path, second);
  });

  test("自动回收超过 stale 时间的崩溃锁", async () => {
    const path = await lockPath();
    // proper-lockfile 使用 lockPath 目录及其 mtime 作为租约。
    await mkdir(path);
    const old = new Date(Date.now() - 60_000);
    await utimes(path, old, old);
    await writeFile(
      `${path}.owner.json`,
      JSON.stringify({
        version: 1,
        pid: 2_147_483_647,
        token: "stale",
        sessionId: "old",
        cwd: "/old",
        acquiredAt: new Date(0).toISOString(),
      }),
    );

    const lock = await acquireConnectionLock(path, owner);
    expect(lock.sessionId).toBe("session-a");
    await releaseConnectionLock(path, lock);
  });

  test("多进程竞争时只有一个进程获取锁", async () => {
    const path = await lockPath();
    const contender = join(import.meta.dir, "lock-contender.ts");
    const processes = Array.from({ length: 20 }, () =>
      Bun.spawn([process.execPath, contender, path, "500"], {
        stdout: "pipe",
        stderr: "pipe",
      }),
    );

    const outputs = await Promise.all(
      processes.map(async (child) => ({
        exitCode: await child.exited,
        stdout: await new Response(child.stdout).text(),
        stderr: await new Response(child.stderr).text(),
      })),
    );

    expect(outputs.filter((result) => result.stdout.includes("ACQUIRED"))).toHaveLength(1);
    expect(outputs.every((result) => result.exitCode === 0)).toBe(true);
  }, 10_000);
});
