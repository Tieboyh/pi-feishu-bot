import { expect, test } from "bun:test";
import { access, mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRestorableSessionFile, secureEnvFileBeforeRead, secureSessionFile, secureSessionStorage } from "../src/sessions/storage-security.ts";

test("env file is restricted before reading and Windows compatibility is controlled", async () => {
  const root = await mkdtemp(join(tmpdir(), "feishu-env-permissions-"));
  const env = join(root, ".env");
  await writeFile(env, "placeholder", { mode: 0o644 });
  secureEnvFileBeforeRead(env, "darwin");
  if (process.platform !== "win32") expect((await stat(env)).mode & 0o777).toBe(0o600);
  secureEnvFileBeforeRead(join(root, "missing.env"), "win32");
  expect(() => secureEnvFileBeforeRead(join(root, "missing.env"), "darwin")).toThrow();
});

test("a Pi-allocated path remains absent until Pi writes its first record", async () => {
  const root = await mkdtemp(join(tmpdir(), "feishu-session-file-"));
  const jsonl = join(root, "not-created-yet.jsonl");
  await secureSessionFile(jsonl);
  await expect(access(jsonl)).rejects.toThrow();
});

test("only non-empty session files are restorable", async () => {
  const root = await mkdtemp(join(tmpdir(), "feishu-restorable-"));
  const empty = join(root, "empty.jsonl");
  const populated = join(root, "populated.jsonl");
  await writeFile(empty, "");
  await writeFile(populated, "{}\n");
  expect(isRestorableSessionFile(undefined)).toBe(false);
  expect(isRestorableSessionFile(join(root, "missing.jsonl"))).toBe(false);
  expect(isRestorableSessionFile(empty)).toBe(false);
  expect(isRestorableSessionFile(populated)).toBe(true);
});

test("session storage is recursively restricted on Unix and remains usable on Windows", async () => {
  const root = await mkdtemp(join(tmpdir(), "feishu-permissions-"));
  const sessions = join(root, "sessions");
  const nested = join(sessions, "nested");
  await mkdir(nested, { recursive: true, mode: 0o755 });
  const index = join(sessions, "index.json");
  const jsonl = join(nested, "session.jsonl");
  await writeFile(index, "{}", { mode: 0o644 });
  await writeFile(jsonl, "", { mode: 0o644 });
  await secureSessionStorage(sessions);
  await access(index);
  await access(jsonl);
  if (process.platform !== "win32") {
    expect((await stat(sessions)).mode & 0o777).toBe(0o700);
    expect((await stat(nested)).mode & 0o777).toBe(0o700);
    expect((await stat(index)).mode & 0o777).toBe(0o600);
    expect((await stat(jsonl)).mode & 0o777).toBe(0o600);
  }
});
