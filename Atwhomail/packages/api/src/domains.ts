/**
 * domains.ts — D20：註冊 ID 與二級網域同名偵測（docs/20）
 *
 * 規則（owner 2026-11-04 定案）：
 *  - 對 docs/20 §2 的 TLD 清單平行查 Cloudflare DoH（type=NS，總逾時 2 秒）
 *  - `Status === 0` 且有 `Answer` → 命中；`Status === 3`（NXDOMAIN）→ 未命中
 *  - 其他／例外 → **fail-open**（不阻擋）並記 warning（可用性優先）
 *  - 快取：命中 90 天、未命中 7 天（`domain_checks`）
 *  - 不回溯檢查既有地址；只套用新的註冊／配發
 *
 * 這個模組不依賴 Hono；`index.ts` 的 `register-request`／`register-verify`／`check-id`
 * 與後續 OAuth 配發（docs/26 §9.3）共用同一套判定。
 */
import type { Env } from "./auth";

/**
 * docs/20 §2 的 TLD 清單（原文標題寫「25 個」，實際列出 26 個；以列出的清單為準）。
 * 不在清單內的 TLD 不會被檢查。
 */
export const CHECK_TLDS = [
  "com",
  "net",
  "org",
  "io",
  "co",
  "ai",
  "app",
  "dev",
  "me",
  "info",
  "biz",
  "xyz",
  "tw",
  "cn",
  "jp",
  "hk",
  "sg",
  "uk",
  "de",
  "us",
  "tech",
  "cloud",
  "shop",
  "online",
  "site",
  "store",
] as const;

const DNS_ENDPOINT = "https://cloudflare-dns.com/dns-query";
/** 全部 TLD 查詢的**總**逾時（docs/20 §3.1） */
const DOMAIN_CHECK_TIMEOUT_MS = 2_000;
/** 命中快取 90 天（新網域幾乎不會消失） */
const CACHE_TTL_HIT_MS = 90 * 24 * 60 * 60 * 1000;
/** 未命中快取 7 天（新網域可能陸續註冊） */
const CACHE_TTL_MISS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 保留字（小寫比對）。
 *
 * 第一段是 docs/20 §2／owner 2026-11-04 指定的清單（含 docs/20 的連字號變體）；
 * 第二段是 D21 已有的保護（docs/21 §4），一併保留以免弱化既有行為。
 * 系統既有地址（`alerts@`／`app@`／`itag@`／`tlsrpt@`…）另由 `email_addresses` 判定。
 */
export const RESERVED_LOCAL_PARTS = new Set([
  // docs/20 §2（owner 指定）
  "admin",
  "postmaster",
  "abuse",
  "root",
  "noreply",
  "no-reply",
  "mailerdaemon",
  "mailer-daemon",
  "hostmaster",
  "webmaster",
  "support",
  // D21 既有清單（docs/21 §4）
  "administrator",
  "sysadmin",
  "security",
  "billing",
  "info",
  "sales",
  "contact",
  "help",
  "www",
  "mail",
  "email",
  "owner",
  "alerts",
  "app",
  "itag",
  "tlsrpt",
]);

export type LocalPartReason = "OK" | "MATCHES_DOMAIN" | "RESERVED" | "TAKEN";

export interface LocalPartAvailability {
  available: boolean;
  reason: LocalPartReason;
  /** `MATCHES_DOMAIN` 時命中的 TLD（例如 `com`） */
  tldHit?: string;
}

export interface DomainCheckResult {
  /** 是否有同名二級網域（fail-open 時為 false） */
  hit: boolean;
  /** 命中的 TLD */
  tldHit?: string;
  /** true = 部分查詢失敗／逾時，本次結果未寫入快取（放行） */
  degraded?: boolean;
}

/** 與 index.ts 的 `validLocalPart` 相同的格式（1–64 字元，a-z0-9._-） */
const LOCAL_PART_RE = /^[a-z0-9][a-z0-9._-]*[a-z0-9]$|^[a-z0-9]$/i;

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}

function isValidLabel(label: string): boolean {
  return label.length >= 1 && label.length <= 64 && LOCAL_PART_RE.test(label);
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const defaultFetch: FetchLike = (input, init) => fetch(input, init);

/**
 * 可注入的 fetch／時間來源（僅供測試覆寫；傳 `null` 還原預設）。
 * 測試不得真的打 DoH：`test/apply-migrations.ts` 預設全部回 NXDOMAIN，
 * 個別案例再以本函式覆寫。
 */
let fetchImpl: FetchLike = defaultFetch;
let nowFn: () => number = () => Date.now();

export function setDomainCheckTestHooks(hooks: {
  fetch?: FetchLike | null;
  now?: (() => number) | null;
}): void {
  if (hooks.fetch !== undefined) fetchImpl = hooks.fetch ?? defaultFetch;
  if (hooks.now !== undefined) nowFn = hooks.now ?? (() => Date.now());
}

type TldResult = { tld: string; kind: "hit" | "miss" | "unknown" };

/**
 * 查單一 TLD：`<label>.<tld>` 的 NS 記錄。
 *
 * `unknown` 代表「這次查不出來」（HTTP 錯誤／SERVFAIL／逾時／JSON 解析失敗），
 * 由呼叫端統一 fail-open，**不得**當成命中或未命中。
 */
async function queryTld(label: string, tld: string, signal: AbortSignal): Promise<TldResult> {
  const name = `${label}.${tld}`;
  const url = `${DNS_ENDPOINT}?name=${encodeURIComponent(name)}&type=NS`;
  try {
    const res = await fetchImpl(url, {
      headers: {
        accept: "application/dns-json",
        "user-agent": "AtWhoMail-DomainCheck/1.0 (+https://atwho.org)",
      },
      signal,
    });
    if (!res.ok) return { tld, kind: "unknown" };
    const body = (await res.json()) as { Status?: unknown; Answer?: unknown };
    if (body?.Status === 0 && Array.isArray(body.Answer) && body.Answer.length > 0) {
      return { tld, kind: "hit" };
    }
    if (body?.Status === 3) return { tld, kind: "miss" };
    return { tld, kind: "unknown" };
  } catch {
    return { tld, kind: "unknown" };
  }
}

type CacheRow = { hit: number; tld_hit: string | null; checked_at: number };

/** 讀快取（過期／查詢失敗 → null，繼續查 DoH） */
async function readCache(env: Env, label: string, nowMs: number): Promise<DomainCheckResult | null> {
  try {
    const row = await env.DB.prepare("SELECT hit, tld_hit, checked_at FROM domain_checks WHERE label = ?1")
      .bind(label)
      .first<CacheRow>();
    if (!row) return null;
    const ttl = Number(row.hit) === 1 ? CACHE_TTL_HIT_MS : CACHE_TTL_MISS_MS;
    if (nowMs - Number(row.checked_at) >= ttl) return null;
    return {
      hit: Number(row.hit) === 1,
      ...(row.tld_hit ? { tldHit: row.tld_hit } : {}),
    };
  } catch (e) {
    // 快取表尚未建立（migration 未套用）也不得影響註冊可用性
    console.warn("[atwhomail-api] domain check cache read failed", { error: String(e) });
    return null;
  }
}

/** 寫快取（失敗只記 warning；查詢結果仍照常回傳） */
async function writeCache(
  env: Env,
  label: string,
  hit: boolean,
  tldHit: string | undefined,
  nowMs: number
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO domain_checks (label, hit, tld_hit, checked_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(label) DO UPDATE SET
         hit = excluded.hit, tld_hit = excluded.tld_hit, checked_at = excluded.checked_at`
    )
      .bind(label, hit ? 1 : 0, tldHit ?? null, nowMs)
      .run();
  } catch (e) {
    console.warn("[atwhomail-api] domain check cache write failed", { error: String(e) });
  }
}

/**
 * 檢查 `label` 是否與任何 `<label>.<tld>`（25 個 TLD）的二級網域同名。
 *
 * - 有命中 → `{ hit: true, tldHit }`（寫入 90 天快取）
 * - 全部 NXDOMAIN → `{ hit: false }`（寫入 7 天快取）
 * - 任一查詢 unknown → `{ hit: false, degraded: true }`（fail-open，**不寫快取**，記 warning）
 */
export async function checkLabelAgainstDomains(env: Env, label: string): Promise<DomainCheckResult> {
  const normalized = normalizeLabel(label);
  if (!isValidLabel(normalized)) return { hit: false };

  const nowMs = nowFn();
  const cached = await readCache(env, normalized, nowMs);
  if (cached) return cached;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOMAIN_CHECK_TIMEOUT_MS);
  let results: PromiseSettledResult<TldResult>[];
  try {
    results = await Promise.allSettled(
      CHECK_TLDS.map((tld) => queryTld(normalized, tld, controller.signal))
    );
  } finally {
    clearTimeout(timer);
  }

  let tldHit: string | undefined;
  const degradedTlds: string[] = [];
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i]!;
    if (result.status === "fulfilled") {
      if (result.value.kind === "hit") {
        if (!tldHit) tldHit = result.value.tld;
      } else if (result.value.kind === "unknown") {
        degradedTlds.push(result.value.tld);
      }
    } else {
      degradedTlds.push(CHECK_TLDS[i]!);
    }
  }

  if (tldHit) {
    await writeCache(env, normalized, true, tldHit, nowMs);
    return { hit: true, tldHit };
  }

  if (degradedTlds.length > 0) {
    // fail-open：DNS 故障不得讓註冊全面停擺（docs/20 §4 #2 owner 定案 A）
    console.warn("[atwhomail-api] domain check degraded (fail-open)", {
      label: normalized,
      failed: degradedTlds.length,
      tlds: degradedTlds,
    });
    return { hit: false, degraded: true };
  }

  await writeCache(env, normalized, false, undefined, nowMs);
  return { hit: false };
}

/**
 * ID 是否可用（docs/20 §2 順序）：
 *   保留字 → `id_blocklist` → 既有 `email_addresses`／`users.username` → 二級網域。
 *
 * `id_blocklist` 讀取失敗時 fail-open（不阻擋註冊），只記 warning。
 */
export async function localPartAvailability(env: Env, label: string): Promise<LocalPartAvailability> {
  const normalized = normalizeLabel(label);

  if (RESERVED_LOCAL_PARTS.has(normalized)) {
    return { available: false, reason: "RESERVED" };
  }

  try {
    const blocked = await env.DB.prepare("SELECT label FROM id_blocklist WHERE label = ?1")
      .bind(normalized)
      .first<{ label: string }>();
    if (blocked) return { available: false, reason: "RESERVED" };
  } catch (e) {
    console.warn("[atwhomail-api] id_blocklist read failed (fail-open)", { error: String(e) });
  }

  const email = `${normalized}@atwho.org`;
  const addr = await env.DB.prepare("SELECT id FROM email_addresses WHERE email = ?1")
    .bind(email)
    .first<{ id: number }>();
  if (addr) return { available: false, reason: "TAKEN" };

  const user = await env.DB.prepare("SELECT id FROM users WHERE username = ?1")
    .bind(normalized)
    .first<{ id: number }>();
  if (user) return { available: false, reason: "TAKEN" };

  const domain = await checkLabelAgainstDomains(env, normalized);
  if (domain.hit) {
    return { available: false, reason: "MATCHES_DOMAIN", ...(domain.tldHit ? { tldHit: domain.tldHit } : {}) };
  }
  return { available: true, reason: "OK" };
}

/**
 * 配發可用 ID（docs/26 §9.3）：
 *   - `base` 可用 → 直接回傳
 *   - 不可用 → `<base>001`、`<base>002`…（3 位流水號，最多 999 次）
 *   - 保留字 → **不產生 `admin001`**，改以 `user` 為 base
 *   - 999 次仍找不到 → `null`
 */
export async function assignAvailableLocalPart(env: Env, base: string): Promise<string | null> {
  let root = normalizeLabel(base);
  if (!isValidLabel(root)) root = "user";
  if (RESERVED_LOCAL_PARTS.has(root)) root = "user";

  const first = await localPartAvailability(env, root);
  if (first.available) return root;

  // local part 上限 64：加 3 位流水號前先截短 base
  const serialRoot = root.length > 61 ? root.slice(0, 61) : root;
  for (let serial = 1; serial <= 999; serial += 1) {
    const candidate = `${serialRoot}${String(serial).padStart(3, "0")}`;
    const availability = await localPartAvailability(env, candidate);
    if (availability.available) return candidate;
  }
  return null;
}

/**
 * 產生建議 ID（owner 2026-11-04 定案；docs/20 §3.4 的替代方案）：
 * `my<base>`、`<base>inbox`、`<base>box`、`<base>mail`、`<base>hub`、`<base>001`…
 *
 * - 不使用 `<base>-mail`（OAuth 的 ID 只允許字母）
 * - **最多檢查 6 個候選**（含快取命中；每個都通過同一檢查）
 * - 檢查失敗的候選直接略過（不得因建議清單失敗而讓註冊端點 500）
 */
export async function suggestAvailableLabels(env: Env, base: string, limit = 6): Promise<string[]> {
  const root = normalizeLabel(base);
  if (!isValidLabel(root)) return [];

  const maxChecks = Math.min(Math.max(limit, 0), 6);
  if (maxChecks === 0) return [];

  const candidates: string[] = [];
  const seen = new Set<string>();
  const push = (candidate: string): void => {
    if (seen.has(candidate) || !isValidLabel(candidate)) return;
    seen.add(candidate);
    candidates.push(candidate);
  };

  for (const candidate of [`my${root}`, `${root}inbox`, `${root}box`, `${root}mail`, `${root}hub`]) {
    push(candidate);
  }

  const serialRoot = root.length > 61 ? root.slice(0, 61) : root;
  for (let serial = 1; candidates.length < maxChecks && serial <= 999; serial += 1) {
    push(`${serialRoot}${String(serial).padStart(3, "0")}`);
  }

  const checks = candidates.slice(0, maxChecks);
  const results = await Promise.all(
    checks.map(async (candidate) => {
      try {
        return (await localPartAvailability(env, candidate)).available ? candidate : null;
      } catch (e) {
        console.warn("[atwhomail-api] suggestion check failed (ignored)", {
          label: candidate,
          error: String(e),
        });
        return null;
      }
    })
  );

  return results.filter((candidate): candidate is string => candidate !== null).slice(0, limit);
}
