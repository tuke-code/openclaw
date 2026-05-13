import * as childProcess from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveOAuthDir, resolveStateDir } from "../../config/paths.js";
import { coerceSecretRef } from "../../config/types.secrets.js";
import { loadJsonFile, saveJsonFile } from "../../infra/json-file.js";
import type {
  OpenClawStateDatabase,
  OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { normalizeProviderId } from "../provider-id.js";
import { AUTH_STORE_VERSION, log } from "./constants.js";
import {
  isLegacyOAuthRef,
  loadLegacyOAuthSidecarMaterial,
  type LegacyOAuthSecretMaterial,
} from "./legacy-oauth-sidecar.js";
import {
  hasOAuthIdentity,
  hasUsableOAuthCredential,
  isSafeToAdoptMainStoreOAuthIdentity,
  normalizeAuthEmailToken,
  normalizeAuthIdentityToken,
} from "./oauth-shared.js";
import { resolveAuthProfileStoreAgentDir, resolveAuthProfileStoreKey } from "./paths.js";
import {
  readAuthProfileStorePayloadResult,
  readAuthProfileStorePayloadResultFromDatabase,
  writeAuthProfileStorePayload,
  writeAuthProfileStorePayloadInTransaction,
  type AuthProfilePayloadValue,
} from "./sqlite-storage.js";
import {
  coerceAuthProfileState,
  loadPersistedAuthProfileState,
  loadPersistedAuthProfileStateFromDatabase,
  mergeAuthProfileState,
} from "./state.js";
import type {
  AuthProfileCredential,
  AuthProfileFailureReason,
  AuthProfileSecretsStore,
  AuthProfileStore,
  OAuthCredential,
  OAuthCredentialRef,
  ProfileUsageStats,
} from "./types.js";

export function authProfileStoreKey(agentDir?: string): string {
  return resolveAuthProfileStoreKey(agentDir);
}

export type PersistedAuthProfileStoreEntry = {
  store: AuthProfileStore;
  updatedAt: number;
};

type LoadPersistedAuthProfileStoreOptions = OpenClawStateDatabaseOptions & {
  allowKeychainPrompt?: boolean;
  resolveLegacyOAuthSidecars?: boolean;
};

type CredentialRejectReason = "non_object" | "invalid_type" | "missing_provider";
type RejectedCredentialEntry = { key: string; reason: CredentialRejectReason };

const AUTH_PROFILE_TYPES = new Set<AuthProfileCredential["type"]>(["api_key", "oauth", "token"]);
const REDACTED_OAUTH_TOKEN_PROVIDER_IDS = new Set(["openai-codex"]);
const OAUTH_PROFILE_SECRET_REF_SOURCE = "openclaw-credentials" as const;
const LEGACY_OAUTH_REF_PROVIDER = "openai-codex";
const OAUTH_PROFILE_SECRET_DIRNAME = "auth-profiles";
const OAUTH_PROFILE_SECRET_VERSION = 1;
const OAUTH_PROFILE_SECRET_ALGORITHM = "aes-256-gcm" as const;
const OAUTH_PROFILE_SECRET_KEY_ENV = "OPENCLAW_AUTH_PROFILE_SECRET_KEY";
const OAUTH_PROFILE_SECRET_KEYCHAIN_SERVICE = "OpenClaw Auth Profile Secrets";
const OAUTH_PROFILE_SECRET_KEYCHAIN_ACCOUNT = "oauth-profile-master-key";
const OAUTH_PROFILE_SECRET_KEY_FILE_NAME = "auth-profile-secret-key";
const LEGACY_AUTH_PROFILE_FILENAME = "auth-profiles.json";
const UNSAFE_LEGACY_AUTH_PROFILE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const runtimeLegacyOAuthSidecarCredentials = new WeakSet<OAuthCredential>();
const runtimeLegacyOAuthSidecarMaterialFingerprints = new Map<string, string>();

type OAuthProfileSecretMaterial = {
  access?: string;
  refresh?: string;
  idToken?: string;
};

type OAuthProfileEncryptedSecretPayload = {
  algorithm: typeof OAUTH_PROFILE_SECRET_ALGORITHM;
  iv: string;
  tag: string;
  ciphertext: string;
};

type OAuthProfileSecretPayload = OAuthProfileSecretMaterial & {
  version: typeof OAUTH_PROFILE_SECRET_VERSION;
  profileId: string;
  provider: string;
  encrypted?: OAuthProfileEncryptedSecretPayload;
};

type OAuthProfileSecretPathOptions = Pick<OpenClawStateDatabaseOptions, "env">;

type OAuthProfileSecretKeySeedOptions = { create?: boolean };

type OAuthProfileSecretKeySeedDeps = {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  readMacKeychain: () => string | undefined;
  readFile: () => string | undefined;
  createFile: () => string | undefined;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeOptionalCredentialString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? value : undefined;
}

function normalizeOptionalCredentialBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeExpiryField(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function normalizeCredentialMetadata(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const metadata: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      metadata[key] = entry;
    }
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function normalizeSecretBackedField(params: {
  entry: Record<string, unknown>;
  valueField: "key" | "token";
  refField: "keyRef" | "tokenRef";
}): void {
  const value = params.entry[params.valueField];
  if (value == null || typeof value === "string") {
    return;
  }
  const ref = coerceSecretRef(value);
  if (ref && !coerceSecretRef(params.entry[params.refField])) {
    params.entry[params.refField] = ref;
  }
  delete params.entry[params.valueField];
}

function normalizeCommonCredentialFields(entry: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {
    provider: typeof entry.provider === "string" ? normalizeProviderId(entry.provider) : "",
  };
  const copyToAgents = normalizeOptionalCredentialBoolean(entry.copyToAgents);
  if (copyToAgents !== undefined) {
    normalized.copyToAgents = copyToAgents;
  }
  const email = normalizeOptionalCredentialString(entry.email);
  if (email !== undefined) {
    normalized.email = email;
  }
  const displayName = normalizeOptionalCredentialString(entry.displayName);
  if (displayName !== undefined) {
    normalized.displayName = displayName;
  }
  return normalized;
}

function normalizeRawCredentialEntry(raw: Record<string, unknown>): Partial<AuthProfileCredential> {
  const entry = { ...raw } as Record<string, unknown>;
  if (!("type" in entry) && typeof entry["mode"] === "string") {
    entry["type"] = entry["mode"];
  }
  if (!("key" in entry) && typeof entry["apiKey"] === "string") {
    entry["key"] = entry["apiKey"];
  }
  normalizeSecretBackedField({ entry, valueField: "key", refField: "keyRef" });
  normalizeSecretBackedField({ entry, valueField: "token", refField: "tokenRef" });
  if (entry.type === "api_key") {
    const normalized: Record<string, unknown> = {
      type: "api_key",
      ...normalizeCommonCredentialFields(entry),
    };
    const key = normalizeOptionalCredentialString(entry.key);
    const keyRef = coerceSecretRef(entry.keyRef);
    const metadata = normalizeCredentialMetadata(entry.metadata);
    if (key !== undefined) {
      normalized.key = key;
    }
    if (keyRef) {
      normalized.keyRef = keyRef;
    }
    if (metadata) {
      normalized.metadata = metadata;
    }
    return normalized as Partial<AuthProfileCredential>;
  }
  if (entry.type === "token") {
    const normalized: Record<string, unknown> = {
      type: "token",
      ...normalizeCommonCredentialFields(entry),
    };
    const token = normalizeOptionalCredentialString(entry.token);
    const tokenRef = coerceSecretRef(entry.tokenRef);
    const expires = normalizeExpiryField(entry.expires);
    if (token !== undefined) {
      normalized.token = token;
    }
    if (tokenRef) {
      normalized.tokenRef = tokenRef;
    }
    if (expires !== undefined) {
      normalized.expires = expires;
    }
    return normalized as Partial<AuthProfileCredential>;
  }
  if (entry.type === "oauth") {
    const normalized: Record<string, unknown> = {
      type: "oauth",
      ...normalizeCommonCredentialFields(entry),
    };
    for (const field of [
      "access",
      "refresh",
      "idToken",
      "clientId",
      "enterpriseUrl",
      "projectId",
      "accountId",
      "chatgptPlanType",
    ] as const) {
      const value = normalizeOptionalCredentialString(entry[field]);
      if (value !== undefined) {
        normalized[field] = value;
      }
    }
    const expires = normalizeExpiryField(entry.expires);
    if (expires !== undefined) {
      normalized.expires = expires;
    }
    if (isOAuthProfileSecretRef(entry.oauthRef)) {
      normalized.oauthRef = entry.oauthRef;
    }
    return normalized;
  }
  return entry as Partial<AuthProfileCredential>;
}

function shouldPersistOAuthWithoutInlineSecrets(
  credential: AuthProfileCredential,
): credential is OAuthCredential {
  return (
    credential.type === "oauth" &&
    REDACTED_OAUTH_TOKEN_PROVIDER_IDS.has(normalizeProviderId(credential.provider))
  );
}

function resolveOAuthProfileSecretId(params: { agentDir?: string; profileId: string }): string {
  return createHash("sha256")
    .update(`${resolveAuthProfileStoreKey(params.agentDir)}\0${params.profileId}`)
    .digest("hex")
    .slice(0, 32);
}

function resolveOAuthProfileSecretPath(
  ref: OAuthCredentialRef,
  options: OAuthProfileSecretPathOptions = {},
): string {
  return path.join(resolveOAuthDir(options.env), OAUTH_PROFILE_SECRET_DIRNAME, `${ref.id}.json`);
}

function isOAuthProfileSecretRef(value: unknown): value is OAuthCredentialRef {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<OAuthCredentialRef>;
  return (
    record.source === OAUTH_PROFILE_SECRET_REF_SOURCE &&
    record.provider === "openai-codex" &&
    typeof record.id === "string" &&
    /^[a-f0-9]{32}$/u.test(record.id)
  );
}

function resolveOAuthProfileSecretRef(params: {
  agentDir?: string;
  profileId: string;
}): OAuthCredentialRef {
  return {
    source: OAUTH_PROFILE_SECRET_REF_SOURCE,
    provider: "openai-codex",
    id: resolveOAuthProfileSecretId(params),
  };
}

function hasInlineOAuthTokenMaterial(credential: OAuthCredential): boolean {
  return [credential.access, credential.refresh, credential.idToken].some(
    (value) => typeof value === "string" && value.trim().length > 0,
  );
}

function buildRuntimeLegacyOAuthSidecarFingerprintKey(params: {
  storeKey?: string;
  profileId: string;
}): string {
  return `${params.storeKey ?? ""}\0${params.profileId}`;
}

function buildLegacyOAuthSecretMaterialFingerprint(
  material: Pick<OAuthCredential, "access" | "refresh" | "idToken">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([material.access ?? null, material.refresh ?? null, material.idToken ?? null]),
    )
    .digest("hex");
}

function normalizeOAuthProfileSecretMaterial(
  credential: Partial<Pick<OAuthCredential, "access" | "refresh" | "idToken">>,
): OAuthProfileSecretMaterial | null {
  const material: OAuthProfileSecretMaterial = {
    ...(typeof credential.access === "string" && credential.access.trim()
      ? { access: credential.access }
      : {}),
    ...(typeof credential.refresh === "string" && credential.refresh.trim()
      ? { refresh: credential.refresh }
      : {}),
    ...(typeof credential.idToken === "string" && credential.idToken.trim()
      ? { idToken: credential.idToken }
      : {}),
  };
  return Object.keys(material).length > 0 ? material : null;
}

function buildOAuthProfileSecretAad(params: {
  ref: OAuthCredentialRef;
  profileId: string;
  provider: string;
}): Buffer {
  return Buffer.from(`${params.ref.id}\0${params.profileId}\0${params.provider}`, "utf8");
}

function readMacOAuthProfileSecretKey(): string | undefined {
  if (process.platform !== "darwin") {
    return undefined;
  }
  try {
    return childProcess
      .execFileSync(
        "security",
        [
          "find-generic-password",
          "-s",
          OAUTH_PROFILE_SECRET_KEYCHAIN_SERVICE,
          "-a",
          OAUTH_PROFILE_SECRET_KEYCHAIN_ACCOUNT,
          "-w",
        ],
        { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
      )
      .trim();
  } catch {
    return undefined;
  }
}

function isPathInsideOrEqual(parentDir: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(parentDir), path.resolve(candidatePath));
  return (
    relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function uniquePaths(paths: Array<string | undefined>): string[] {
  return Array.from(new Set(paths.filter((entry): entry is string => Boolean(entry))));
}

function resolveFallbackOAuthProfileSecretKeyFileCandidates(): string[] {
  if (process.platform === "win32") {
    const home = process.env.USERPROFILE?.trim() || os.homedir();
    const root =
      process.env.APPDATA?.trim() || (home ? path.join(home, "AppData", "Roaming") : undefined);
    return uniquePaths([
      root ? path.join(root, "OpenClaw", OAUTH_PROFILE_SECRET_KEY_FILE_NAME) : undefined,
      home
        ? path.join(home, ".openclaw-auth-profile-secrets", OAUTH_PROFILE_SECRET_KEY_FILE_NAME)
        : undefined,
    ]);
  }

  if (process.platform === "darwin") {
    const home = process.env.HOME?.trim() || os.homedir();
    return uniquePaths([
      home
        ? path.join(
            home,
            "Library",
            "Application Support",
            "OpenClaw",
            OAUTH_PROFILE_SECRET_KEY_FILE_NAME,
          )
        : undefined,
      home
        ? path.join(home, ".openclaw-auth-profile-secrets", OAUTH_PROFILE_SECRET_KEY_FILE_NAME)
        : undefined,
    ]);
  }

  const home = process.env.HOME?.trim() || os.homedir();
  const root =
    process.env.XDG_CONFIG_HOME?.trim() || (home ? path.join(home, ".config") : undefined);
  return uniquePaths([
    root ? path.join(root, "openclaw", OAUTH_PROFILE_SECRET_KEY_FILE_NAME) : undefined,
    home
      ? path.join(home, ".openclaw-auth-profile-secrets", OAUTH_PROFILE_SECRET_KEY_FILE_NAME)
      : undefined,
  ]);
}

function resolveFallbackOAuthProfileSecretKeyFilePath(): string | undefined {
  const stateDir = resolveStateDir();
  return resolveFallbackOAuthProfileSecretKeyFileCandidates().find(
    (candidate) => !isPathInsideOrEqual(stateDir, candidate),
  );
}

function readFallbackOAuthProfileSecretKeyFile(): string | undefined {
  const keyPath = resolveFallbackOAuthProfileSecretKeyFilePath();
  if (!keyPath) {
    return undefined;
  }
  return readFallbackOAuthProfileSecretKeyFileAtPath(keyPath);
}

function readFallbackOAuthProfileSecretKeyFileAtPath(keyPath: string): string | undefined {
  try {
    const value = fs.readFileSync(keyPath, "utf8").trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isSafeLegacyProviderKey(key: string): boolean {
  return key.trim().length > 0 && !UNSAFE_LEGACY_AUTH_PROFILE_KEYS.has(key);
}

function inferLegacyCredentialType(
  record: Record<string, unknown>,
): AuthProfileCredential["type"] | undefined {
  const explicit = readNonEmptyString(record.type) ?? readNonEmptyString(record.mode);
  if (explicit === "api_key" || explicit === "token" || explicit === "oauth") {
    return explicit;
  }
  if (readNonEmptyString(record.key) ?? readNonEmptyString(record.apiKey)) {
    return "api_key";
  }
  if (readNonEmptyString(record.token)) {
    return "token";
  }
  if (
    readNonEmptyString(record.access) &&
    readNonEmptyString(record.refresh) &&
    typeof record.expires === "number"
  ) {
    return "oauth";
  }
  return undefined;
}

function coerceLegacyFlatCredential(
  providerId: string,
  raw: unknown,
): AuthProfileCredential | null {
  if (!isRecord(raw)) {
    return null;
  }
  const provider = readNonEmptyString(raw.provider) ?? providerId;
  const type = inferLegacyCredentialType(raw);
  const email = readNonEmptyString(raw.email);
  if (type === "api_key") {
    const key = readNonEmptyString(raw.key) ?? readNonEmptyString(raw.apiKey);
    return key ? { type, provider, key, ...(email ? { email } : {}) } : null;
  }
  if (type === "token") {
    const token = readNonEmptyString(raw.token);
    return token
      ? {
          type,
          provider,
          token,
          ...(typeof raw.expires === "number" ? { expires: raw.expires } : {}),
          ...(email ? { email } : {}),
        }
      : null;
  }
  if (type === "oauth") {
    const access = readNonEmptyString(raw.access);
    const refresh = readNonEmptyString(raw.refresh);
    if (!access || !refresh || typeof raw.expires !== "number") {
      return null;
    }
    return {
      type,
      provider,
      access,
      refresh,
      expires: raw.expires,
      ...(readNonEmptyString(raw.enterpriseUrl)
        ? { enterpriseUrl: readNonEmptyString(raw.enterpriseUrl) }
        : {}),
      ...(readNonEmptyString(raw.projectId)
        ? { projectId: readNonEmptyString(raw.projectId) }
        : {}),
      ...(readNonEmptyString(raw.accountId)
        ? { accountId: readNonEmptyString(raw.accountId) }
        : {}),
      ...(email ? { email } : {}),
    };
  }
  return null;
}

function createFallbackOAuthProfileSecretKeyFile(): string | undefined {
  const keyPath = resolveFallbackOAuthProfileSecretKeyFilePath();
  if (!keyPath) {
    return undefined;
  }
  const generated = randomBytes(32).toString("base64url");
  let fd: number | undefined;
  try {
    fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
    fd = fs.openSync(keyPath, "wx", 0o600);
    fs.writeFileSync(fd, `${generated}\n`, "utf8");
    try {
      fs.chmodSync(keyPath, 0o600);
    } catch {
      // Best effort only; some platforms ignore POSIX modes.
    }
    return generated;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
      return readFallbackOAuthProfileSecretKeyFileAtPath(keyPath);
    }
    log.warn("failed to create oauth profile secret key file", { err });
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Best effort only.
      }
    }
  }
}

function shouldReadMacKeychainForOAuthProfileSecrets(params?: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): boolean {
  const env = params?.env ?? process.env;
  const platform = params?.platform ?? process.platform;
  return platform === "darwin" && env.VITEST !== "true" && env.VITEST_WORKER_ID === undefined;
}

function resolveOAuthProfileSecretKeySeedWithDeps(
  options: OAuthProfileSecretKeySeedOptions | undefined,
  deps: OAuthProfileSecretKeySeedDeps,
): string | undefined {
  const externalKey = deps.env[OAUTH_PROFILE_SECRET_KEY_ENV]?.trim();
  if (externalKey) {
    return externalKey;
  }
  if (deps.env.NODE_ENV === "test" && deps.env.VITEST === "true") {
    return "openclaw-test-oauth-profile-secret-key";
  }
  if (shouldReadMacKeychainForOAuthProfileSecrets({ env: deps.env, platform: deps.platform })) {
    const keychainKey = deps.readMacKeychain();
    if (keychainKey) {
      return keychainKey;
    }
  }
  const fileKey = deps.readFile() ?? (options?.create === true ? deps.createFile() : undefined);
  if (fileKey) {
    return fileKey;
  }
  return undefined;
}

function resolveOAuthProfileSecretKeySeed(
  options?: OAuthProfileSecretKeySeedOptions,
): string | undefined {
  return resolveOAuthProfileSecretKeySeedWithDeps(options, {
    env: process.env,
    platform: process.platform,
    readMacKeychain: readMacOAuthProfileSecretKey,
    readFile: readFallbackOAuthProfileSecretKeyFile,
    createFile: createFallbackOAuthProfileSecretKeyFile,
  });
}

function buildOAuthProfileSecretKey(options?: { create?: boolean }): Buffer | null {
  const externalKey = resolveOAuthProfileSecretKeySeed(options);
  if (!externalKey) {
    return null;
  }
  return createHash("sha256").update(`openclaw:auth-profile-oauth:${externalKey}`).digest();
}

export const __testing = {
  resolveOAuthProfileSecretKeySeedWithDeps,
  shouldReadMacKeychainForOAuthProfileSecrets,
};

function encryptOAuthProfileSecretMaterial(params: {
  ref: OAuthCredentialRef;
  profileId: string;
  provider: string;
  material: OAuthProfileSecretMaterial;
}): OAuthProfileEncryptedSecretPayload {
  const key = buildOAuthProfileSecretKey({ create: true });
  if (!key) {
    throw new Error("OAuth profile secret key source is required to persist OAuth profile secrets");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv(OAUTH_PROFILE_SECRET_ALGORITHM, key, iv);
  cipher.setAAD(
    buildOAuthProfileSecretAad({
      ref: params.ref,
      profileId: params.profileId,
      provider: params.provider,
    }),
  );
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(params.material), "utf8"),
    cipher.final(),
  ]);
  return {
    algorithm: OAUTH_PROFILE_SECRET_ALGORITHM,
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

function decryptOAuthProfileSecretMaterial(params: {
  ref: OAuthCredentialRef;
  profileId: string;
  provider: string;
  encrypted: OAuthProfileEncryptedSecretPayload;
}): OAuthProfileSecretMaterial | null {
  if (params.encrypted.algorithm !== OAUTH_PROFILE_SECRET_ALGORITHM) {
    return null;
  }
  const key = buildOAuthProfileSecretKey();
  if (!key) {
    return null;
  }
  try {
    const decipher = createDecipheriv(
      OAUTH_PROFILE_SECRET_ALGORITHM,
      key,
      Buffer.from(params.encrypted.iv, "base64url"),
    );
    decipher.setAAD(
      buildOAuthProfileSecretAad({
        ref: params.ref,
        profileId: params.profileId,
        provider: params.provider,
      }),
    );
    decipher.setAuthTag(Buffer.from(params.encrypted.tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(params.encrypted.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    const raw = JSON.parse(plaintext) as unknown;
    if (!raw || typeof raw !== "object") {
      return null;
    }
    return normalizeOAuthProfileSecretMaterial(raw as OAuthProfileSecretMaterial);
  } catch {
    return null;
  }
}

function writeOAuthProfileSecretMaterial(params: {
  ref: OAuthCredentialRef;
  profileId: string;
  provider: string;
  material: OAuthProfileSecretMaterial;
  options?: OAuthProfileSecretPathOptions;
}): void {
  const secretPath = resolveOAuthProfileSecretPath(params.ref, params.options);
  fs.mkdirSync(path.dirname(secretPath), { recursive: true, mode: 0o700 });
  const payload: OAuthProfileSecretPayload = {
    version: OAUTH_PROFILE_SECRET_VERSION,
    profileId: params.profileId,
    provider: params.provider,
    encrypted: encryptOAuthProfileSecretMaterial(params),
  };
  saveJsonFile(secretPath, payload);
  try {
    fs.chmodSync(secretPath, 0o600);
  } catch {
    // Best effort only; some platforms ignore POSIX modes.
  }
}

function persistOAuthProfileSecrets(params: {
  agentDir?: string;
  profileId: string;
  credential: OAuthCredential;
  options?: OAuthProfileSecretPathOptions;
}): OAuthCredentialRef | undefined {
  const expectedRef = resolveOAuthProfileSecretRef({
    agentDir: params.agentDir,
    profileId: params.profileId,
  });
  const existingRef = isOAuthProfileSecretRef(params.credential.oauthRef)
    ? params.credential.oauthRef
    : undefined;
  const targetRef = existingRef?.id === expectedRef.id ? existingRef : expectedRef;
  if (!hasInlineOAuthTokenMaterial(params.credential)) {
    return existingRef?.id === expectedRef.id ? existingRef : undefined;
  }
  const material = normalizeOAuthProfileSecretMaterial(params.credential);
  if (!material) {
    return existingRef?.id === expectedRef.id ? existingRef : undefined;
  }
  writeOAuthProfileSecretMaterial({
    ref: targetRef,
    profileId: params.profileId,
    provider: params.credential.provider,
    material,
    options: params.options,
  });
  return targetRef;
}

function omitInlineOAuthSecrets(params: {
  agentDir?: string;
  profileId: string;
  credential: OAuthCredential;
  options?: OAuthProfileSecretPathOptions;
}): AuthProfileCredential {
  const oauthRef = persistOAuthProfileSecrets(params);
  if (!oauthRef) {
    return params.credential;
  }
  const sanitized = { ...params.credential } as Record<string, unknown>;
  delete sanitized.access;
  delete sanitized.refresh;
  delete sanitized.idToken;
  sanitized.oauthRef = oauthRef;
  return sanitized as AuthProfileCredential;
}

function parseCredentialEntry(
  raw: unknown,
  fallbackProvider?: string,
): { ok: true; credential: AuthProfileCredential } | { ok: false; reason: CredentialRejectReason } {
  if (!raw || typeof raw !== "object") {
    return { ok: false, reason: "non_object" };
  }
  const typed = normalizeRawCredentialEntry(raw as Record<string, unknown>);
  if (!AUTH_PROFILE_TYPES.has(typed.type as AuthProfileCredential["type"])) {
    return { ok: false, reason: "invalid_type" };
  }
  const provider = typed.provider ?? fallbackProvider;
  if (typeof provider !== "string" || provider.trim().length === 0) {
    return { ok: false, reason: "missing_provider" };
  }
  return {
    ok: true,
    credential: {
      ...typed,
      provider: normalizeProviderId(provider),
    } as AuthProfileCredential,
  };
}

function warnRejectedCredentialEntries(source: string, rejected: RejectedCredentialEntry[]): void {
  if (rejected.length === 0) {
    return;
  }
  const reasons = rejected.reduce<Partial<Record<CredentialRejectReason, number>>>(
    (acc, current) => {
      acc[current.reason] = (acc[current.reason] ?? 0) + 1;
      return acc;
    },
    {},
  );
  log.warn("ignored invalid auth profile entries during store load", {
    source,
    dropped: rejected.length,
    reasons,
    keys: rejected.slice(0, 10).map((entry) => entry.key),
  });
}

function resolveLegacyOAuthSidecarCredential(params: {
  profileId: string;
  raw: unknown;
  credential: AuthProfileCredential;
  storeKey?: string;
  options?: LoadPersistedAuthProfileStoreOptions;
}): AuthProfileCredential {
  if (
    params.credential.type !== "oauth" ||
    normalizeProviderId(params.credential.provider) !== LEGACY_OAUTH_REF_PROVIDER ||
    hasInlineOAuthTokenMaterial(params.credential) ||
    !isRecord(params.raw) ||
    !isLegacyOAuthRef(params.raw.oauthRef)
  ) {
    return params.credential;
  }
  // Compatibility for legacy Codex OAuth sidecars; doctor remains the explicit
  // migration path that writes canonical inline credentials.
  const material = loadLegacyOAuthSidecarMaterial({
    ref: params.raw.oauthRef,
    profileId: params.profileId,
    provider: params.credential.provider,
    allowKeychainPrompt: params.options?.allowKeychainPrompt,
  });
  if (!material) {
    return params.credential;
  }
  const credential = {
    ...params.credential,
    ...(material.access ? { access: material.access } : {}),
    ...(material.refresh ? { refresh: material.refresh } : {}),
    ...(material.idToken ? { idToken: material.idToken } : {}),
  };
  runtimeLegacyOAuthSidecarCredentials.add(credential);
  runtimeLegacyOAuthSidecarMaterialFingerprints.set(
    buildRuntimeLegacyOAuthSidecarFingerprintKey({
      storeKey: params.storeKey,
      profileId: params.profileId,
    }),
    buildLegacyOAuthSecretMaterialFingerprint(credential),
  );
  return credential;
}

export function isRuntimeLegacyOAuthSidecarCredential(
  credential: AuthProfileCredential | undefined,
): boolean {
  return credential?.type === "oauth" && runtimeLegacyOAuthSidecarCredentials.has(credential);
}

export function matchesRuntimeLegacyOAuthSidecarMaterial(params: {
  storeKey?: string;
  profileId: string;
  credential: AuthProfileCredential | undefined;
}): boolean {
  if (params.credential?.type !== "oauth") {
    return false;
  }
  if (runtimeLegacyOAuthSidecarCredentials.has(params.credential)) {
    return true;
  }
  const fingerprint = runtimeLegacyOAuthSidecarMaterialFingerprints.get(
    buildRuntimeLegacyOAuthSidecarFingerprintKey({
      storeKey: params.storeKey,
      profileId: params.profileId,
    }),
  );
  return (
    fingerprint !== undefined &&
    fingerprint === buildLegacyOAuthSecretMaterialFingerprint(params.credential)
  );
}

export function coercePersistedAuthProfileStore(
  raw: unknown,
  options?: LoadPersistedAuthProfileStoreOptions,
  storeKey?: string,
): AuthProfileStore | null {
  if (!isRecord(raw)) {
    return null;
  }
  const record = raw;
  if (!isRecord(record.profiles)) {
    return null;
  }
  const profiles = record.profiles;
  const normalized: Record<string, AuthProfileCredential> = {};
  const rejected: RejectedCredentialEntry[] = [];
  for (const [key, value] of Object.entries(profiles)) {
    const parsed = parseCredentialEntry(value);
    if (!parsed.ok) {
      rejected.push({ key, reason: parsed.reason });
      continue;
    }
    normalized[key] =
      options?.resolveLegacyOAuthSidecars === true
        ? resolveLegacyOAuthSidecarCredential({
            profileId: key,
            raw: value,
            credential: parsed.credential,
            storeKey,
            options,
          })
        : parsed.credential;
  }
  warnRejectedCredentialEntries("SQLite auth profile store", rejected);
  return {
    version:
      typeof record.version === "number" && Number.isFinite(record.version)
        ? record.version
        : AUTH_STORE_VERSION,
    profiles: normalized,
    ...coerceAuthProfileState(record),
  };
}

function coerceLegacyFlatAuthProfileStore(raw: unknown): AuthProfileStore | null {
  if (!isRecord(raw) || "profiles" in raw) {
    return null;
  }
  const store: AuthProfileStore = {
    version: AUTH_STORE_VERSION,
    profiles: {},
  };
  for (const [key, value] of Object.entries(raw)) {
    const providerId = key.trim();
    if (!isSafeLegacyProviderKey(providerId)) {
      continue;
    }
    const credential = coerceLegacyFlatCredential(providerId, value);
    if (!credential) {
      continue;
    }
    store.profiles[`${providerId}:default`] = credential;
  }
  return Object.keys(store.profiles).length > 0 ? store : null;
}

function mergeRecord<T>(
  base?: Record<string, T>,
  override?: Record<string, T>,
): Record<string, T> | undefined {
  if (!base && !override) {
    return undefined;
  }
  if (!base) {
    return { ...override };
  }
  if (!override) {
    return { ...base };
  }
  return { ...base, ...override };
}

function dedupeMergedProfileOrder(profileIds: string[]): string[] {
  return Array.from(new Set(profileIds));
}

function hasComparableOAuthIdentityConflict(
  existing: OAuthCredential,
  candidate: OAuthCredential,
): boolean {
  const existingAccountId = normalizeAuthIdentityToken(existing.accountId);
  const candidateAccountId = normalizeAuthIdentityToken(candidate.accountId);
  if (
    existingAccountId !== undefined &&
    candidateAccountId !== undefined &&
    existingAccountId !== candidateAccountId
  ) {
    return true;
  }

  const existingEmail = normalizeAuthEmailToken(existing.email);
  const candidateEmail = normalizeAuthEmailToken(candidate.email);
  return (
    existingEmail !== undefined && candidateEmail !== undefined && existingEmail !== candidateEmail
  );
}

function isLegacyDefaultOAuthProfile(profileId: string, credential: OAuthCredential): boolean {
  return profileId === `${normalizeProviderId(credential.provider)}:default`;
}

function isNewerUsableOAuthCredential(
  existing: OAuthCredential,
  candidate: OAuthCredential,
): boolean {
  if (!hasUsableOAuthCredential(candidate)) {
    return false;
  }
  if (!hasUsableOAuthCredential(existing)) {
    return true;
  }
  return (
    Number.isFinite(candidate.expires) &&
    (!Number.isFinite(existing.expires) || candidate.expires > existing.expires)
  );
}

const AUTH_INVALIDATION_REASONS = new Set<AuthProfileFailureReason>([
  "auth",
  "auth_permanent",
  "session_expired",
]);

function hasAuthInvalidationSignal(stats: ProfileUsageStats | undefined): boolean {
  if (!stats) {
    return false;
  }
  if (
    (stats.cooldownReason && AUTH_INVALIDATION_REASONS.has(stats.cooldownReason)) ||
    (stats.disabledReason && AUTH_INVALIDATION_REASONS.has(stats.disabledReason))
  ) {
    return true;
  }
  return Object.entries(stats.failureCounts ?? {}).some(
    ([reason, count]) =>
      AUTH_INVALIDATION_REASONS.has(reason as AuthProfileFailureReason) &&
      typeof count === "number" &&
      count > 0,
  );
}

function isProfileReferencedByAuthState(store: AuthProfileStore, profileId: string): boolean {
  if (Object.values(store.order ?? {}).some((profileIds) => profileIds.includes(profileId))) {
    return true;
  }
  return Object.values(store.lastGood ?? {}).some((value) => value === profileId);
}

function resolveProviderAuthStateValue<T>(
  values: Record<string, T> | undefined,
  providerKey: string,
): T | undefined {
  if (!values) {
    return undefined;
  }
  for (const [key, value] of Object.entries(values)) {
    if (normalizeProviderId(key) === providerKey) {
      return value;
    }
  }
  return undefined;
}

function findMainStoreOAuthReplacementForInvalidatedProfile(params: {
  base: AuthProfileStore;
  override: AuthProfileStore;
  profileId: string;
  credential: OAuthCredential;
}): string | undefined {
  const providerKey = normalizeProviderId(params.credential.provider);
  if (
    providerKey !== "openai-codex" ||
    !isProfileReferencedByAuthState(params.override, params.profileId) ||
    !hasAuthInvalidationSignal(params.override.usageStats?.[params.profileId])
  ) {
    return undefined;
  }

  const candidates = Object.entries(params.base.profiles)
    .flatMap(([profileId, credential]): Array<[string, OAuthCredential]> => {
      if (
        profileId === params.profileId ||
        credential.type !== "oauth" ||
        normalizeProviderId(credential.provider) !== providerKey ||
        !hasUsableOAuthCredential(credential)
      ) {
        return [];
      }
      return [[profileId, credential]];
    })
    .toSorted(([leftId, leftCredential], [rightId, rightCredential]) => {
      const leftExpires = Number.isFinite(leftCredential.expires) ? leftCredential.expires : 0;
      const rightExpires = Number.isFinite(rightCredential.expires) ? rightCredential.expires : 0;
      if (rightExpires !== leftExpires) {
        return rightExpires - leftExpires;
      }
      return leftId.localeCompare(rightId);
    });
  if (candidates.length === 0) {
    return undefined;
  }

  const candidateIds = new Set(candidates.map(([profileId]) => profileId));
  const orderedProfileId = resolveProviderAuthStateValue(params.base.order, providerKey)?.find(
    (profileId) => candidateIds.has(profileId),
  );
  if (orderedProfileId) {
    return orderedProfileId;
  }

  const lastGoodProfileId = resolveProviderAuthStateValue(params.base.lastGood, providerKey);
  if (lastGoodProfileId && candidateIds.has(lastGoodProfileId)) {
    return lastGoodProfileId;
  }

  return candidates.length === 1 ? candidates[0]?.[0] : undefined;
}

function findMainStoreOAuthReplacement(params: {
  base: AuthProfileStore;
  legacyProfileId: string;
  legacyCredential: OAuthCredential;
}): string | undefined {
  const providerKey = normalizeProviderId(params.legacyCredential.provider);
  const candidates = Object.entries(params.base.profiles)
    .flatMap(([profileId, credential]): Array<[string, OAuthCredential]> => {
      if (
        profileId === params.legacyProfileId ||
        credential.type !== "oauth" ||
        normalizeProviderId(credential.provider) !== providerKey
      ) {
        return [];
      }
      return [[profileId, credential]];
    })
    .filter(([, credential]) => isNewerUsableOAuthCredential(params.legacyCredential, credential))
    .toSorted(([leftId, leftCredential], [rightId, rightCredential]) => {
      const leftExpires = Number.isFinite(leftCredential.expires) ? leftCredential.expires : 0;
      const rightExpires = Number.isFinite(rightCredential.expires) ? rightCredential.expires : 0;
      if (rightExpires !== leftExpires) {
        return rightExpires - leftExpires;
      }
      return leftId.localeCompare(rightId);
    });

  const exactIdentityCandidates = candidates.filter(([, credential]) =>
    isSafeToAdoptMainStoreOAuthIdentity(params.legacyCredential, credential),
  );
  if (exactIdentityCandidates.length > 0) {
    if (!hasOAuthIdentity(params.legacyCredential) && exactIdentityCandidates.length > 1) {
      return undefined;
    }
    return exactIdentityCandidates[0]?.[0];
  }

  if (hasUsableOAuthCredential(params.legacyCredential)) {
    return undefined;
  }
  const fallbackCandidates = candidates.filter(
    ([, credential]) => !hasComparableOAuthIdentityConflict(params.legacyCredential, credential),
  );
  if (fallbackCandidates.length !== 1) {
    return undefined;
  }
  return fallbackCandidates[0]?.[0];
}

function replaceMergedProfileReferences(params: {
  store: AuthProfileStore;
  base: AuthProfileStore;
  replacements: Map<string, string>;
}): AuthProfileStore {
  const { store, base, replacements } = params;
  if (replacements.size === 0) {
    return store;
  }

  const profiles = { ...store.profiles };
  for (const [legacyProfileId, replacementProfileId] of replacements) {
    const baseCredential = base.profiles[legacyProfileId];
    if (baseCredential) {
      profiles[legacyProfileId] = baseCredential;
    } else {
      delete profiles[legacyProfileId];
    }
    const replacementBaseCredential = base.profiles[replacementProfileId];
    const replacementCredential = profiles[replacementProfileId];
    if (
      replacementBaseCredential &&
      (!replacementCredential ||
        (replacementCredential.type === "oauth" &&
          replacementBaseCredential.type === "oauth" &&
          isNewerUsableOAuthCredential(replacementCredential, replacementBaseCredential)))
    ) {
      profiles[replacementProfileId] = replacementBaseCredential;
    }
  }

  const order = store.order
    ? Object.fromEntries(
        Object.entries(store.order).map(([provider, profileIds]) => [
          provider,
          dedupeMergedProfileOrder(
            profileIds.map((profileId) => replacements.get(profileId) ?? profileId),
          ),
        ]),
      )
    : undefined;

  const lastGood = store.lastGood
    ? Object.fromEntries(
        Object.entries(store.lastGood).map(([provider, profileId]) => [
          provider,
          replacements.get(profileId) ?? profileId,
        ]),
      )
    : undefined;

  const usageStats = store.usageStats ? { ...store.usageStats } : undefined;
  if (usageStats) {
    for (const legacyProfileId of replacements.keys()) {
      const baseStats = base.usageStats?.[legacyProfileId];
      if (baseStats) {
        usageStats[legacyProfileId] = baseStats;
      } else {
        delete usageStats[legacyProfileId];
      }
    }
  }

  return {
    ...store,
    profiles,
    ...(order && Object.keys(order).length > 0 ? { order } : { order: undefined }),
    ...(lastGood && Object.keys(lastGood).length > 0 ? { lastGood } : { lastGood: undefined }),
    ...(usageStats && Object.keys(usageStats).length > 0
      ? { usageStats }
      : { usageStats: undefined }),
  };
}

function reconcileMainStoreOAuthProfileDrift(params: {
  base: AuthProfileStore;
  override: AuthProfileStore;
  merged: AuthProfileStore;
}): AuthProfileStore {
  const replacements = new Map<string, string>();
  for (const [profileId, credential] of Object.entries(params.override.profiles)) {
    if (credential.type !== "oauth") {
      continue;
    }
    const replacementProfileId = isLegacyDefaultOAuthProfile(profileId, credential)
      ? findMainStoreOAuthReplacement({
          base: params.base,
          legacyProfileId: profileId,
          legacyCredential: credential,
        })
      : findMainStoreOAuthReplacementForInvalidatedProfile({
          base: params.base,
          override: params.override,
          profileId,
          credential,
        });
    if (replacementProfileId) {
      replacements.set(profileId, replacementProfileId);
    }
  }
  return replaceMergedProfileReferences({
    store: params.merged,
    base: params.base,
    replacements,
  });
}

export function mergeAuthProfileStores(
  base: AuthProfileStore,
  override: AuthProfileStore,
): AuthProfileStore {
  if (
    Object.keys(override.profiles).length === 0 &&
    !override.order &&
    !override.lastGood &&
    !override.usageStats
  ) {
    return base;
  }
  const merged = {
    version: Math.max(base.version, override.version ?? base.version),
    profiles: { ...base.profiles, ...override.profiles },
    order: mergeRecord(base.order, override.order),
    lastGood: mergeRecord(base.lastGood, override.lastGood),
    usageStats: mergeRecord(base.usageStats, override.usageStats),
  };
  return reconcileMainStoreOAuthProfileDrift({ base, override, merged });
}

export function buildPersistedAuthProfileSecretsStore(
  store: AuthProfileStore,
  shouldPersistProfile?: (params: {
    profileId: string;
    credential: AuthProfileCredential;
  }) => boolean,
  options?: {
    agentDir?: string;
    existingRaw?: unknown;
    runtimeLegacyOAuthSidecarProfileIds?: ReadonlySet<string>;
  } & OAuthProfileSecretPathOptions,
): AuthProfileSecretsStore {
  const profiles = Object.fromEntries(
    Object.entries(store.profiles).flatMap(([profileId, credential]) => {
      if (shouldPersistProfile && !shouldPersistProfile({ profileId, credential })) {
        return [];
      }
      if (credential.type === "api_key" && credential.keyRef && credential.key !== undefined) {
        const sanitized = { ...credential } as Record<string, unknown>;
        delete sanitized.key;
        return [[profileId, sanitized]];
      }
      if (credential.type === "token" && credential.tokenRef && credential.token !== undefined) {
        const sanitized = { ...credential } as Record<string, unknown>;
        delete sanitized.token;
        return [[profileId, sanitized]];
      }
      if (shouldPersistOAuthWithoutInlineSecrets(credential)) {
        return [
          [
            profileId,
            omitInlineOAuthSecrets({
              agentDir: options?.agentDir,
              profileId,
              credential,
              options,
            }),
          ],
        ];
      }
      return [[profileId, credential]];
    }),
  ) as AuthProfileSecretsStore["profiles"];

  const payload = {
    version: AUTH_STORE_VERSION,
    profiles,
  };
  return preserveLegacyOAuthRefsForDoctorMigration(payload, options);
}

function preserveLegacyOAuthRefsForDoctorMigration(
  payload: AuthProfileSecretsStore,
  options:
    | {
        existingRaw?: unknown;
        runtimeLegacyOAuthSidecarProfileIds?: ReadonlySet<string>;
      }
    | undefined,
): AuthProfileSecretsStore {
  const existingRaw = options?.existingRaw;
  if (!isRecord(existingRaw) || !isRecord(existingRaw.profiles)) {
    return payload;
  }
  let profiles: AuthProfileSecretsStore["profiles"] | undefined;
  for (const [profileId, rawProfile] of Object.entries(existingRaw.profiles)) {
    if (!isRecord(rawProfile) || !isLegacyOAuthRef(rawProfile.oauthRef)) {
      continue;
    }
    const credential = payload.profiles[profileId];
    if (
      credential?.type !== "oauth" ||
      normalizeProviderId(credential.provider) !== LEGACY_OAUTH_REF_PROVIDER
    ) {
      continue;
    }
    if (hasInlineOAuthTokenMaterial(credential)) {
      const isRuntimeSidecarMaterial =
        options?.runtimeLegacyOAuthSidecarProfileIds?.has(profileId) === true;
      if (
        !isRuntimeSidecarMaterial &&
        !isUnchangedLegacyOAuthSidecarMaterial({ profileId, rawProfile, credential })
      ) {
        continue;
      }
    } else if (
      isOAuthProfileSecretRef(credential.oauthRef) &&
      options?.runtimeLegacyOAuthSidecarProfileIds?.has(profileId) !== true
    ) {
      continue;
    }
    profiles ??= { ...payload.profiles };
    const sanitized = { ...credential } as Record<string, unknown>;
    delete sanitized.access;
    delete sanitized.refresh;
    delete sanitized.idToken;
    profiles[profileId] = {
      ...sanitized,
      oauthRef: rawProfile.oauthRef,
    } as unknown as AuthProfileCredential;
  }
  return profiles ? { ...payload, profiles } : payload;
}

function isUnchangedLegacyOAuthSidecarMaterial(params: {
  profileId: string;
  rawProfile: Record<string, unknown>;
  credential: OAuthCredential;
}): boolean {
  if (!isLegacyOAuthRef(params.rawProfile.oauthRef)) {
    return false;
  }
  const material = loadLegacyOAuthSidecarMaterial({
    ref: params.rawProfile.oauthRef,
    profileId: params.profileId,
    provider: params.credential.provider,
    allowKeychainPrompt: false,
  });
  if (!material) {
    return false;
  }
  return isSameLegacyOAuthSecretMaterial(params.credential, material);
}

function isSameLegacyOAuthSecretMaterial(
  credential: OAuthCredential,
  material: LegacyOAuthSecretMaterial,
): boolean {
  return (["access", "refresh", "idToken"] as const).every(
    (field) => (credential[field] ?? undefined) === (material[field] ?? undefined),
  );
}

function collectPersistedOAuthProfileSecretIds(
  store: AuthProfileStore | AuthProfileSecretsStore,
): Set<string> {
  const ids = new Set<string>();
  for (const credential of Object.values(store.profiles)) {
    if (credential.type === "oauth" && isOAuthProfileSecretRef(credential.oauthRef)) {
      ids.add(credential.oauthRef.id);
    }
  }
  return ids;
}

export function removeDetachedOAuthProfileSecrets(params: {
  previousRaw: unknown;
  nextStore: AuthProfileSecretsStore;
  options?: OAuthProfileSecretPathOptions;
}): void {
  const previousStore = coercePersistedAuthProfileStore(params.previousRaw);
  if (!previousStore) {
    return;
  }
  const previousIds = collectPersistedOAuthProfileSecretIds(previousStore);
  if (previousIds.size === 0) {
    return;
  }
  const nextIds = collectPersistedOAuthProfileSecretIds(params.nextStore);
  for (const id of previousIds) {
    if (nextIds.has(id)) {
      continue;
    }
    const secretPath = resolveOAuthProfileSecretPath(
      {
        source: OAUTH_PROFILE_SECRET_REF_SOURCE,
        provider: "openai-codex",
        id,
      },
      params.options,
    );
    fs.rmSync(secretPath, { force: true });
  }
}

function coerceOAuthProfileEncryptedSecretPayload(
  raw: unknown,
): OAuthProfileEncryptedSecretPayload | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Partial<OAuthProfileEncryptedSecretPayload>;
  return record.algorithm === OAUTH_PROFILE_SECRET_ALGORITHM &&
    typeof record.iv === "string" &&
    typeof record.tag === "string" &&
    typeof record.ciphertext === "string"
    ? {
        algorithm: record.algorithm,
        iv: record.iv,
        tag: record.tag,
        ciphertext: record.ciphertext,
      }
    : null;
}

function coerceOAuthProfileSecretPayload(params: {
  raw: unknown;
  ref: OAuthCredentialRef;
  profileId: string;
  provider: string;
}): OAuthProfileSecretMaterial | null {
  const { raw, ref, profileId, provider } = params;
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Partial<OAuthProfileSecretPayload>;
  if (
    record.version !== OAUTH_PROFILE_SECRET_VERSION ||
    record.profileId !== profileId ||
    record.provider !== provider
  ) {
    return null;
  }
  const encrypted = coerceOAuthProfileEncryptedSecretPayload(record.encrypted);
  if (encrypted) {
    return decryptOAuthProfileSecretMaterial({
      ref,
      profileId,
      provider,
      encrypted,
    });
  }
  return normalizeOAuthProfileSecretMaterial(record);
}

function resolvePersistedOAuthSecrets(
  credential: OAuthCredential,
  profileId: string,
  options: OAuthProfileSecretPathOptions = {},
): OAuthCredential {
  if (!isOAuthProfileSecretRef(credential.oauthRef)) {
    return credential;
  }
  const secret = coerceOAuthProfileSecretPayload({
    raw: loadJsonFile(resolveOAuthProfileSecretPath(credential.oauthRef, options)),
    ref: credential.oauthRef,
    profileId,
    provider: credential.provider,
  });
  if (!secret) {
    return credential;
  }
  return {
    ...credential,
    ...(secret.access ? { access: secret.access } : {}),
    ...(secret.refresh ? { refresh: secret.refresh } : {}),
    ...(secret.idToken ? { idToken: secret.idToken } : {}),
  } as OAuthCredential;
}

function resolvePersistedOAuthProfileSecrets(
  store: AuthProfileStore,
  options: OAuthProfileSecretPathOptions = {},
): AuthProfileStore {
  const profiles = Object.fromEntries(
    Object.entries(store.profiles).map(([profileId, credential]) => [
      profileId,
      credential.type === "oauth"
        ? resolvePersistedOAuthSecrets(credential, profileId, options)
        : credential,
    ]),
  ) as AuthProfileStore["profiles"];
  return {
    ...store,
    profiles,
  };
}

export function loadPersistedAuthProfileStoreEntryFromDatabase(
  database: OpenClawStateDatabase,
  agentDir?: string,
  options: LoadPersistedAuthProfileStoreOptions = {},
): PersistedAuthProfileStoreEntry | null {
  const result = readAuthProfileStorePayloadResultFromDatabase(
    database,
    authProfileStoreKey(agentDir),
  );
  if (!result.exists || result.value === undefined) {
    return null;
  }
  const raw = result.value;
  const store = coercePersistedAuthProfileStore(raw, options, authProfileStoreKey(agentDir));
  if (!store) {
    return null;
  }
  const merged = {
    ...store,
    ...mergeAuthProfileState(
      coerceAuthProfileState(raw),
      loadPersistedAuthProfileStateFromDatabase(database, agentDir),
    ),
  };
  return {
    store: resolvePersistedOAuthProfileSecrets(merged, options),
    updatedAt: result.updatedAt,
  };
}

export function loadPersistedAuthProfileStoreEntry(
  agentDir?: string,
  options: LoadPersistedAuthProfileStoreOptions = {},
): PersistedAuthProfileStoreEntry | null {
  const result = readAuthProfileStorePayloadResult(authProfileStoreKey(agentDir), options);
  if (!result.exists || result.value === undefined) {
    return null;
  }
  const raw = result.value;
  const store = coercePersistedAuthProfileStore(raw, options, authProfileStoreKey(agentDir));
  if (!store) {
    return null;
  }
  const merged = {
    ...store,
    ...mergeAuthProfileState(
      coerceAuthProfileState(raw),
      loadPersistedAuthProfileState(agentDir, options),
    ),
  };
  return {
    store: resolvePersistedOAuthProfileSecrets(merged, options),
    updatedAt: result.updatedAt,
  };
}

export function loadLegacyAuthProfileStoreEntry(
  agentDir?: string,
  options: LoadPersistedAuthProfileStoreOptions = {},
): PersistedAuthProfileStoreEntry | null {
  const authPath = path.join(
    resolveAuthProfileStoreAgentDir(agentDir),
    LEGACY_AUTH_PROFILE_FILENAME,
  );
  const raw = loadJsonFile(authPath);
  const store =
    coercePersistedAuthProfileStore(raw, options, authProfileStoreKey(agentDir)) ??
    coerceLegacyFlatAuthProfileStore(raw);
  if (!store) {
    return null;
  }
  let updatedAt = Date.now();
  try {
    updatedAt = fs.statSync(authPath).mtimeMs;
  } catch {
    // Missing stat is harmless: the payload already loaded successfully.
  }
  return {
    store: resolvePersistedOAuthProfileSecrets(store, options),
    updatedAt,
  };
}

export function loadPersistedAuthProfileStore(
  agentDir?: string,
  options: LoadPersistedAuthProfileStoreOptions = {},
): AuthProfileStore | null {
  return loadPersistedAuthProfileStoreEntry(agentDir, options)?.store ?? null;
}

export function savePersistedAuthProfileSecretsStore(
  store: AuthProfileSecretsStore,
  agentDir?: string,
  options: OpenClawStateDatabaseOptions = {},
): void {
  const payload = buildPersistedAuthProfileSecretsStore(store, undefined, {
    agentDir,
    env: options.env,
  });
  writeAuthProfileStorePayload(
    authProfileStoreKey(agentDir),
    payload as unknown as AuthProfilePayloadValue,
    options,
  );
}

export function savePersistedAuthProfileSecretsStoreInTransaction(
  database: OpenClawStateDatabase,
  store: AuthProfileSecretsStore,
  agentDir?: string,
  updatedAt: number = Date.now(),
): void {
  writeAuthProfileStorePayloadInTransaction(
    database,
    authProfileStoreKey(agentDir),
    store as unknown as AuthProfilePayloadValue,
    updatedAt,
  );
}

export function hasPersistedAuthProfileSecretsStore(
  agentDir?: string,
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  return readAuthProfileStorePayloadResult(authProfileStoreKey(agentDir), options).exists;
}
