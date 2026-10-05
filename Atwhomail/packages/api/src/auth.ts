/**
 * auth.ts — Model C 認證核心（Phase 11）
 *
 * - 密碼：argon2id（hash-wasm，WASM 於 Workers 內執行）
 * - Session：JWT HS256（hono/jwt），payload：
 *     owner   → { scope: "owner",   sub: <users.id>,        exp }
 *     mailbox → { scope: "mailbox", sub: <email_addresses.id>, email, exp }
 * - 登入鎖定：D1 auth_attempts（連續 5 次失敗 → 鎖 15 分鐘）
 * - 救援通道：ADMIN_TOKEN（保留，僅 owner 權限；Phase 11 後不再用於日常操作）
 */
import { sign, verify } from "hono/jwt";
import type { MiddlewareHandler } from "hono";
import { argon2idAsync } from "@noble/hashes/argon2.js";

/** PHC 風格編碼：$argon2id$v=19$m=19456,t=3,p=1$<saltB64>$<hashB64> */
const ARGON2 = { t: 3, m: 19456, p: 1, dkLen: 32 } as const;

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface Env {
  DB: D1Database;
  MAIL: R2Bucket;
  EMAIL: SendEmail;
  ADMIN_TOKEN?: string;
  JWT_SECRET?: string;
}

export type Scope =
  | { kind: "owner"; userId: number; via: "jwt" | "rescue" }
  | { kind: "mailbox"; addressId: number; email: string };

export type AuthEnv = { Bindings: Env; Variables: { scope: Scope } };

/** session = scope + 簽發時間（iat，秒）+ 簽發時的密碼版本（pca，毫秒）。rescue 不檢查。 */
type SessionInfo = { scope: Scope; iat: number; pca: number };

const JWT_TTL_SEC = 24 * 60 * 60; // 24h
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

// ───────────────────────── 密碼 ─────────────────────────
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await argon2idAsync(password, salt, { ...ARGON2, maxmem: 64 * 1024 * 1024 });
  return `$argon2id$v=19$m=${ARGON2.m},t=${ARGON2.t},p=${ARGON2.p}$${toB64(salt)}$${toB64(hash)}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  try {
    const parts = encoded.split("$");
    // ["", "argon2id", "v=19", "m=...,t=...,p=...", saltB64, hashB64]
    if (parts.length !== 6 || parts[1] !== "argon2id") return false;
    const params = Object.fromEntries(parts[3]!.split(",").map((kv) => kv.split("=") as [string, string]));
    const salt = fromB64(parts[4]!);
    const expected = fromB64(parts[5]!);
    const actual = await argon2idAsync(password, salt, {
      t: Number(params.t ?? ARGON2.t),
      m: Number(params.m ?? ARGON2.m),
      p: Number(params.p ?? ARGON2.p),
      dkLen: expected.length,
      maxmem: 64 * 1024 * 1024,
    });
    // 常數時間比較
    if (actual.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < actual.length; i++) diff |= actual[i]! ^ expected[i]!;
    return diff === 0;
  } catch {
    return false;
  }
}

export function validatePasswordPolicy(pw: string): string | null {
  if (typeof pw !== "string") return "密碼格式錯誤";
  if (pw.length < 8) return "密碼至少 8 個字元";
  if (pw.length > 128) return "密碼過長（≤128）";
  return null;
}

// ───────────────────────── JWT ─────────────────────────
/**
 * JWT 附帶 `pca`（簽發當下的 password_changed_at，毫秒）= **token 版本**。
 * 驗證時比對 DB 現值：`pca >= current` 才有效。
 * 為何不用 iat？iat 為秒精度，同一秒內改密碼再登入會被誤判為過期（曾為真實 bug）。
 */
export async function signOwnerToken(env: Env, userId: number, pca: number): Promise<string> {
  if (!env.JWT_SECRET) throw new Error("JWT_SECRET not configured");
  const iat = Math.floor(Date.now() / 1000);
  return sign({ scope: "owner", sub: userId, pca, iat, exp: iat + JWT_TTL_SEC }, env.JWT_SECRET, "HS256");
}

export async function signMailboxToken(env: Env, addressId: number, email: string, pca: number): Promise<string> {
  if (!env.JWT_SECRET) throw new Error("JWT_SECRET not configured");
  const iat = Math.floor(Date.now() / 1000);
  return sign({ scope: "mailbox", sub: addressId, email, pca, iat, exp: iat + JWT_TTL_SEC }, env.JWT_SECRET, "HS256");
}

async function parseBearer(env: Env, token: string): Promise<SessionInfo | null> {
  if (!env.JWT_SECRET) return null;
  try {
    const p = (await verify(token, env.JWT_SECRET, "HS256")) as {
      scope?: string;
      sub?: number;
      email?: string;
      iat?: number;
      pca?: number;
    };
    const iat = typeof p.iat === "number" ? p.iat : 0;
    const pca = typeof p.pca === "number" ? p.pca : -1;
    if (p.scope === "owner" && typeof p.sub === "number") {
      return { scope: { kind: "owner", userId: p.sub, via: "jwt" }, iat, pca };
    }
    if (p.scope === "mailbox" && typeof p.sub === "number" && typeof p.email === "string") {
      return { scope: { kind: "mailbox", addressId: p.sub, email: p.email }, iat, pca };
    }
    return null;
  } catch {
    return null;
  }
}

/** 密碼重設後舊 token 失效（08 #44）：token 的 pca 必須 >= DB 現值 */
async function isFresh(env: Env, s: SessionInfo): Promise<boolean> {
  if (s.scope.kind === "owner" && s.scope.via === "rescue") return true;
  const current =
    s.scope.kind === "owner"
      ? (await env.DB.prepare("SELECT password_changed_at AS pca FROM users WHERE id = ?1").bind(s.scope.userId).first<{ pca: number }>())?.pca
      : (await env.DB.prepare("SELECT password_changed_at AS pca FROM email_addresses WHERE id = ?1").bind(s.scope.addressId).first<{ pca: number }>())?.pca;
  return s.pca >= Number(current ?? 0);
}

// ───────────────────────── 登入鎖定 ─────────────────────────
export async function checkLocked(db: D1Database, key: string): Promise<number> {
  const row = await db
    .prepare("SELECT locked_until FROM auth_attempts WHERE key = ?1")
    .bind(key)
    .first<{ locked_until: number }>();
  const until = row?.locked_until ?? 0;
  return until > Date.now() ? until : 0;
}

export async function recordFailure(db: D1Database, key: string): Promise<void> {
  const ts = Date.now();
  const row = await db
    .prepare("SELECT fail_count FROM auth_attempts WHERE key = ?1")
    .bind(key)
    .first<{ fail_count: number }>();
  const fails = (row?.fail_count ?? 0) + 1;
  const lockedUntil = fails >= MAX_FAILS ? ts + LOCK_MS : 0;
  await db
    .prepare(
      `INSERT INTO auth_attempts (key, fail_count, locked_until, updated_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(key) DO UPDATE SET fail_count = ?2, locked_until = ?3, updated_at = ?4`
    )
    .bind(key, fails, lockedUntil, ts)
    .run();
}

export async function clearFailures(db: D1Database, key: string): Promise<void> {
  await db.prepare("DELETE FROM auth_attempts WHERE key = ?1").bind(key).run();
}

// ───────────────────────── 中介層 ─────────────────────────
async function rescueScope(env: Env, provided: string): Promise<SessionInfo | null> {
  const token = env.ADMIN_TOKEN;
  if (!token) return null;
  const a = new TextEncoder().encode(provided);
  const b = new TextEncoder().encode(token);
  if (a.length !== b.length) return null;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  if (diff !== 0) return null;
  const owner = await env.DB.prepare("SELECT id FROM users WHERE username = 'owner'").first<{ id: number }>();
  return owner
    ? { scope: { kind: "owner", userId: owner.id, via: "rescue" }, iat: Math.floor(Date.now() / 1000), pca: Number.MAX_SAFE_INTEGER }
    : null;
}

/** 解析 session：Bearer JWT（owner/mailbox）或 x-admin-token rescue。無 session → null */
export async function resolveSession(c: {
  req: { header: (n: string) => string | undefined };
  env: Env;
}): Promise<SessionInfo | null> {
  const rescue = c.req.header("x-admin-token");
  if (rescue) {
    const s = await rescueScope(c.env, rescue);
    if (s) return s;
  }
  const auth = c.req.header("authorization") ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    return parseBearer(c.env, auth.slice(7).trim());
  }
  return null;
}

/** 舊介面（僅回 scope） */
export async function resolveScope(c: { req: { header: (n: string) => string | undefined }; env: Env }): Promise<Scope | null> {
  const s = await resolveSession(c);
  return s ? s.scope : null;
}

/** owner 權限（JWT owner 或 rescue）；含 token 新鮮度檢查 */
export const requireOwner: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const s = await resolveSession(c);
  if (!s) return c.json({ error: { code: "UNAUTHORIZED", message: "needs owner session or rescue token" } }, 401);
  if (s.scope.kind !== "owner") return c.json({ error: { code: "FORBIDDEN", message: "owner scope required" } }, 403);
  if (!(await isFresh(c.env, s))) {
    return c.json({ error: { code: "TOKEN_STALE", message: "session 已失效（密碼已變更），請重新登入" } }, 401);
  }
  c.set("scope", s.scope);
  await next();
};

/** 需登入（owner 或 mailbox）─ 信件類端點用，於 handler 內依 scope 過濾 */
export const requireSession: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const s = await resolveSession(c);
  if (!s) return c.json({ error: { code: "UNAUTHORIZED", message: "needs session" } }, 401);
  if (!(await isFresh(c.env, s))) {
    return c.json({ error: { code: "TOKEN_STALE", message: "session 已失效（密碼已變更），請重新登入" } }, 401);
  }
  c.set("scope", s.scope);
  await next();
};
