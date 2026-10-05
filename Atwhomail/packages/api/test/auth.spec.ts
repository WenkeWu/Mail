import { describe, it, expect } from "vitest";
import { verify } from "hono/jwt";
import {
  hashPassword,
  verifyPassword,
  validatePasswordPolicy,
  signOwnerToken,
  signMailboxToken,
  type Env,
} from "../src/auth";

const env = { JWT_SECRET: "test-jwt-secret" } as unknown as Env;

describe("argon2id 密碼雜湊（@noble/hashes）", () => {
  it("雜湊格式為 PHC argon2id（m=19456,t=3,p=1）", async () => {
    const h = await hashPassword("correct horse");
    expect(h.startsWith("$argon2id$v=19$m=19456,t=3,p=1$")).toBe(true);
    expect(h.split("$")).toHaveLength(6);
  });

  it("正確密碼驗證通過", async () => {
    const h = await hashPassword("s3cret-pw");
    expect(await verifyPassword("s3cret-pw", h)).toBe(true);
  });

  it("錯誤密碼不通過", async () => {
    const h = await hashPassword("s3cret-pw");
    expect(await verifyPassword("wrong-pw", h)).toBe(false);
  });

  it("每個雜湊 salt 不同（相同密碼 ≠ 相同雜湊）", async () => {
    const [a, b] = await Promise.all([hashPassword("same"), hashPassword("same")]);
    expect(a).not.toBe(b);
  });

  it("畸形雜湊不拋錯，回 false", async () => {
    expect(await verifyPassword("x", "PLACEHOLDER")).toBe(false);
    expect(await verifyPassword("x", "$argon2id$v=19$m=1,t=1,p=1$bad$bad")).toBe(false);
  });
});

describe("密碼政策", () => {
  it("太短拒絕", () => expect(validatePasswordPolicy("short")).toContain("8"));
  it("太長拒絕", () => expect(validatePasswordPolicy("x".repeat(129))).toContain("過長"));
  it("合格通過", () => expect(validatePasswordPolicy("goodpassword")).toBeNull());
});

describe("JWT 簽發", () => {
  it("owner token：HS256 三段、payload 正確、exp > iat", async () => {
    const token = await signOwnerToken(env, 7, 0);
    expect(token.split(".")).toHaveLength(3);
    const payload = (await verify(token, env.JWT_SECRET!, "HS256")) as {
      scope: string;
      sub: number;
      iat: number;
      exp: number;
    };
    expect(payload.scope).toBe("owner");
    expect(payload.sub).toBe(7);
    expect(payload.exp).toBeGreaterThan(payload.iat);
  });

  it("mailbox token：scope=mailbox + email", async () => {
    const token = await signMailboxToken(env, 3, "a@atwho.org", 0);
    const payload = (await verify(token, env.JWT_SECRET!, "HS256")) as {
      scope: string;
      sub: number;
      email: string;
    };
    expect(payload).toMatchObject({ scope: "mailbox", sub: 3, email: "a@atwho.org" });
  });

  it("token 帶 pca（密碼版本）作為失效依據，而非秒精度 iat", async () => {
    const now = Date.now();
    const token = await signOwnerToken(env, 7, now);
    const payload = (await verify(token, env.JWT_SECRET!, "HS256")) as { pca: number; iat: number };
    expect(payload.pca).toBe(now);
    expect(payload.pca).toBeGreaterThan(payload.iat * 1000); // 毫秒 > 秒*1000（同秒內也精確）
  });

  it("錯誤密鑰驗簽失敗", async () => {
    const token = await signOwnerToken(env, 1, 0);
    await expect(verify(token, "wrong-secret", "HS256")).rejects.toThrow();
  });
});
