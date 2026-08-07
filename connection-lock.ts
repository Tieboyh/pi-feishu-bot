import lockfile from "proper-lockfile";
import { open, readFile, rename, unlink, writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

const STALE_MS = 30_000;
const UPDATE_MS = 10_000;

export interface FeishuConnectionOwner {
  version: 1;
  pid: number;
  token: string;
  sessionId: string;
  sessionFile?: string;
  cwd: string;
  acquiredAt: string;
}

export interface FeishuConnectionLock extends FeishuConnectionOwner {
  /** proper-lockfile 提供的所有权绑定释放函数。 */
  release: () => Promise<void>;
}

export class FeishuConnectionBusyError extends Error {
  constructor(readonly owner: FeishuConnectionOwner | null) {
    super(
      owner
        ? `飞书已由 PID ${owner.pid} 的 pi 会话占用（session=${owner.sessionId}, cwd=${owner.cwd}）`
        : "飞书连接锁已被其他 pi 会话占用",
    );
    this.name = "FeishuConnectionBusyError";
  }
}

function targetFile(lockPath: string): string {
  return `${lockPath}.target`;
}

function ownerFile(lockPath: string): string {
  return `${lockPath}.owner.json`;
}

async function ensureTarget(lockPath: string): Promise<void> {
  await mkdir(dirname(lockPath), { recursive: true });
  const handle = await open(targetFile(lockPath), "a", 0o600);
  await handle.close();
}

async function writeOwner(lockPath: string, owner: FeishuConnectionOwner): Promise<void> {
  const path = ownerFile(lockPath);
  const temp = `${path}.${owner.token}.tmp`;
  await writeFile(temp, JSON.stringify(owner, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, path);
}

async function readOwnerFile(lockPath: string): Promise<FeishuConnectionOwner | null> {
  try {
    const parsed = JSON.parse(await readFile(ownerFile(lockPath), "utf8"));
    if (
      parsed?.version === 1 &&
      Number.isInteger(parsed.pid) &&
      typeof parsed.token === "string" &&
      typeof parsed.sessionId === "string" &&
      typeof parsed.cwd === "string" &&
      typeof parsed.acquiredAt === "string"
    ) {
      return parsed as FeishuConnectionOwner;
    }
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
  }
  return null;
}

export async function readConnectionLock(
  lockPath: string,
): Promise<FeishuConnectionOwner | null> {
  await ensureTarget(lockPath);
  const locked = await lockfile.check(targetFile(lockPath), {
    realpath: false,
    lockfilePath: lockPath,
    stale: STALE_MS,
  });
  return locked ? readOwnerFile(lockPath) : null;
}

export async function acquireConnectionLock(
  lockPath: string,
  owner: Pick<FeishuConnectionOwner, "sessionId" | "sessionFile" | "cwd">,
): Promise<FeishuConnectionLock> {
  await ensureTarget(lockPath);

  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(targetFile(lockPath), {
      realpath: false,
      lockfilePath: lockPath,
      stale: STALE_MS,
      update: UPDATE_MS,
      retries: 0,
    });
  } catch (error: any) {
    if (error?.code === "ELOCKED") {
      throw new FeishuConnectionBusyError(await readOwnerFile(lockPath));
    }
    throw error;
  }

  const info: FeishuConnectionOwner = {
    version: 1,
    pid: process.pid,
    token: randomUUID(),
    sessionId: owner.sessionId,
    sessionFile: owner.sessionFile,
    cwd: owner.cwd,
    acquiredAt: new Date().toISOString(),
  };

  try {
    await writeOwner(lockPath, info);
  } catch (error) {
    await release().catch(() => {});
    throw error;
  }

  return { ...info, release };
}

export async function releaseConnectionLock(
  lockPath: string,
  ownedLock: FeishuConnectionLock | null,
): Promise<boolean> {
  if (!ownedLock) return false;

  // 在仍持有 proper-lockfile 锁时先删除元数据；若释放失败则恢复元数据。
  await unlink(ownerFile(lockPath)).catch((error: any) => {
    if (error?.code !== "ENOENT") throw error;
  });
  try {
    await ownedLock.release();
    return true;
  } catch (error) {
    await writeOwner(lockPath, ownedLock).catch(() => {});
    throw error;
  }
}
