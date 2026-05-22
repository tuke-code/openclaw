import "./fs-safe-defaults.js";
import {
  JsonFileReadError,
  readJson as readJsonWithoutRetry,
  readJsonIfExists as readJsonIfExistsWithoutRetry,
  readJsonSync,
  readRootJsonObjectSync,
  readRootJsonSync,
  readRootStructuredFileSync,
  tryReadJson,
  tryReadJsonSync,
  writeJson,
  writeJsonSync,
} from "@openclaw/fs-safe/json";
import { replaceFileAtomic } from "./replace-file.js";

export {
  JsonFileReadError,
  readJsonSync,
  readRootJsonObjectSync,
  readRootJsonSync,
  readRootStructuredFileSync,
  tryReadJson,
  tryReadJson as readJsonFile,
  tryReadJsonSync,
  tryReadJsonSync as readJsonFileSync,
  writeJson,
  writeJson as writeJsonAtomic,
  writeJsonSync,
};

const STABLE_READ_RETRY_LIMIT = 3;
const STABLE_READ_RETRY_DELAY_MS = 5;

function isFileChangedDuringReadError(err: unknown): boolean {
  if (!(err instanceof JsonFileReadError) || err.reason !== "read") {
    return false;
  }
  const cause = err.cause;
  return cause instanceof Error && cause.message.includes("File changed during read:");
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withStableReadRetry<T>(read: () => Promise<T>): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await read();
    } catch (err) {
      attempt += 1;
      if (!isFileChangedDuringReadError(err) || attempt >= STABLE_READ_RETRY_LIMIT) {
        throw err;
      }
      await delay(STABLE_READ_RETRY_DELAY_MS);
    }
  }
}

export async function readJson<T>(filePath: string): Promise<T> {
  return await withStableReadRetry(() => readJsonWithoutRetry<T>(filePath));
}

export const readJsonFileStrict = readJson;

export async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  return await withStableReadRetry(() => readJsonIfExistsWithoutRetry<T>(filePath));
}

export const readDurableJsonFile = readJsonIfExists;

export type WriteTextAtomicOptions = {
  mode?: number;
  dirMode?: number;
  trailingNewline?: boolean;
  durable?: boolean;
};

export async function writeTextAtomic(
  filePath: string,
  content: string,
  options?: WriteTextAtomicOptions,
): Promise<void> {
  const payload = options?.trailingNewline && !content.endsWith("\n") ? `${content}\n` : content;
  await replaceFileAtomic({
    filePath,
    content: payload,
    mode: options?.mode ?? 0o600,
    dirMode: options?.dirMode ?? 0o777 & ~process.umask(),
    copyFallbackOnPermissionError: true,
    syncTempFile: options?.durable !== false,
    syncParentDir: options?.durable !== false,
  });
}
