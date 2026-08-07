import { expect, test } from "bun:test";
import { mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { secureEnvFileBeforeRead, secureSessionStorage } from "./storage-security.ts";

test("env file is restricted before reading and Windows compatibility is controlled", async () => {
  const root = await mkdtemp(join(tmpdir(), "feishu-env-permissions-"));
  const env = join(root, ".env");
  await writeFile(env, "placeholder", { mode: 0o644 });
  secureEnvFileBeforeRead(env, "darwin");
  expect((await stat(env)).mode & 0o777).toBe(0o600);
  secureEnvFileBeforeRead(join(root, "missing.env"), "win32");
  expect(() => secureEnvFileBeforeRead(join(root, "missing.env"), "darwin")).toThrow();
});

test("session storage is recursively restricted to 0700/0600", async () => {
  const root = await mkdtemp(join(tmpdir(), "feishu-permissions-"));
  const sessions = join(root, "sessions");
  const nested = join(sessions, "nested");
  await mkdir(nested, { recursive: true, mode: 0o755 });
  const index = join(sessions, "index.json");
  const jsonl = join(nested, "session.jsonl");
  await writeFile(index, "{}", { mode: 0o644 });
  await writeFile(jsonl, "", { mode: 0o644 });
  await secureSessionStorage(sessions);
  expect((await stat(sessions)).mode & 0o777).toBe(0o700);
  expect((await stat(nested)).mode & 0o777).toBe(0o700);
  expect((await stat(index)).mode & 0o777).toBe(0o600);
  expect((await stat(jsonl)).mode & 0o777).toBe(0o600);
});
