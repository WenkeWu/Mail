/**
 * forms.ts — 互動式表單的 schema 白名單驗證與 payload 驗證（docs/18 §8、§9）
 *
 * 安全原則：
 *  - 表單 schema **只存 DB**；外部不可自帶 schema（本檔是唯一寫入前的守門員）
 *  - 白名單制：禁止 $ref／anyOf／oneOf／allOf／patternProperties／dependencies 等組合與參照
 *  - 巢狀 ≤ 2 層、欄位 ≤ 40、字串 ≤ 2000、僅基本型別／enum／format: date
 *  - title／description 一律消毒（去標籤與控制字元）；回覆內容永遠當資料，不渲染 HTML
 *  - 不解析、不執行任何 schema 內的程式碼；未知關鍵字一律拒絕
 */

export const FORM_LIMITS = {
  MAX_FIELDS: 40,
  MAX_STRING: 2000,
  MAX_DEPTH: 2,
  MAX_SCHEMA_BYTES: 64 * 1024,
  MAX_PAYLOAD_BYTES: 256 * 1024,
  MAX_ARRAY_ITEMS: 100,
} as const;

export type JsonObject = Record<string, unknown>;

const ROOT_KEYS = new Set([
  "type", "properties", "required", "title", "description", "additionalProperties",
]);
const PRIMITIVE_KEYS: Record<string, Set<string>> = {
  string: new Set(["type", "title", "description", "enum", "format", "maxLength", "minLength"]),
  number: new Set(["type", "title", "description", "enum", "minimum", "maximum"]),
  integer: new Set(["type", "title", "description", "enum", "minimum", "maximum"]),
  boolean: new Set(["type", "title", "description", "enum"]),
  array: new Set(["type", "title", "description", "items", "minItems", "maxItems"]),
};
const OBJECT_KEYS = new Set(["type", "title", "description", "properties", "required", "additionalProperties"]);
const FORBIDDEN_KEYS = new Set([
  "$ref", "$defs", "definitions", "anyOf", "oneOf", "allOf", "not", "if", "then", "else",
  "patternProperties", "dependencies", "dependentSchemas", "dependentRequired",
  "propertyNames", "unevaluatedProperties", "unevaluatedItems", "contains", "prefixItems",
  "pattern", "formatMinimum", "formatMaximum", "$schema", "id", "$id",
]);
const ALLOWED_FORMATS = new Set(["date"]);

export function isPlainObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** title／description 消毒：去控制字元、去 HTML 標籤；React 端仍以純文字渲染 */
export function sanitizeDisplayText(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/<[^>]*>/g, "")
    .trim()
    .slice(0, FORM_LIMITS.MAX_STRING);
}

function bad(message: string): { ok: false; message: string } {
  return { ok: false, message };
}

function validPropertyName(name: string): boolean {
  if (name.length === 0 || name.length > 100) return false;
  if (name === "__proto__" || name === "constructor" || name === "prototype") return false;
  if (/[\u0000-\u001f\u007f<>]/.test(name)) return false;
  return true;
}

interface WalkState {
  fields: number;
}

/** 驗證單一 schema 節點（回傳消毒後的副本） */
function validateNode(
  raw: unknown,
  depth: number,
  path: string,
  state: WalkState,
  isRoot = false
): JsonObject | { error: string } {
  if (!isPlainObject(raw)) return { error: `${path} 必須是物件` };

  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_KEYS.has(key)) return { error: `${path} 使用了禁止的關鍵字 ${key}` };
  }

  const type = raw.type;
  if (typeof type !== "string") return { error: `${path}.type 必填` };
  if (isRoot && type !== "object") return { error: "schema 根層必須是 object" };
  if (!["object", "string", "number", "integer", "boolean", "array"].includes(type)) {
    return { error: `${path}.type 不支援：${type}` };
  }

  // 巢狀深度：根 object = 第 1 層；object／array 屬性各加一層
  if (depth > FORM_LIMITS.MAX_DEPTH) return { error: `巢狀超過 ${FORM_LIMITS.MAX_DEPTH} 層` };

  const allowed = type === "object" ? OBJECT_KEYS : type === "array" ? PRIMITIVE_KEYS.array! : PRIMITIVE_KEYS[type]!;
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    if (!allowed.has(key)) return { error: `${path}.${key} 不在白名單內` };
  }

  const out: JsonObject = { type };
  if (raw.title !== undefined) {
    if (typeof raw.title !== "string") return { error: `${path}.title 必須是字串` };
    out.title = sanitizeDisplayText(raw.title);
  }
  if (raw.description !== undefined) {
    if (typeof raw.description !== "string") return { error: `${path}.description 必須是字串` };
    out.description = sanitizeDisplayText(raw.description);
  }

  if (type === "object") {
    const props = raw.properties;
    if (!isPlainObject(props)) return { error: `${path}.properties 必填且必須是物件` };
    const keys = Object.keys(props);
    if (keys.length === 0) return { error: `${path}.properties 至少需要一個欄位` };
    if (raw.additionalProperties !== undefined) {
      if (typeof raw.additionalProperties !== "boolean") {
        return { error: `${path}.additionalProperties 僅允許 boolean` };
      }
      out.additionalProperties = raw.additionalProperties;
    }

    const cleanProps: JsonObject = {};
    for (const key of keys) {
      if (!validPropertyName(key)) return { error: `${path} 有不合法的欄位名稱` };
      state.fields += 1;
      if (state.fields > FORM_LIMITS.MAX_FIELDS) {
        return { error: `欄位數超過上限 ${FORM_LIMITS.MAX_FIELDS}` };
      }
      const rawChild = (props as JsonObject)[key];
      const childType = isPlainObject(rawChild) ? rawChild.type : undefined;
      // 只有「容器」才增加巢狀層級；物件內的基本欄位不額外計層
      const childDepth = childType === "object" || childType === "array" ? depth + 1 : depth;
      if (childDepth > FORM_LIMITS.MAX_DEPTH) return { error: `巢狀超過 ${FORM_LIMITS.MAX_DEPTH} 層` };
      const child = validateNode(rawChild, childDepth, `${path}.${key}`, state);
      if ("error" in child) return child;
      cleanProps[key] = child;
    }
    out.properties = cleanProps;

    if (raw.required !== undefined) {
      if (!Array.isArray(raw.required) || raw.required.some((r) => typeof r !== "string")) {
        return { error: `${path}.required 必須是字串陣列` };
      }
      const required = [...new Set(raw.required as string[])];
      for (const r of required) {
        if (!(r in cleanProps)) return { error: `${path}.required 指向不存在的欄位 ${r}` };
      }
      out.required = required;
    }
    return out;
  }

  if (type === "array") {
    const items = raw.items;
    if (!isPlainObject(items)) return { error: `${path}.items 必填且必須是物件` };
    // 只允許基本型別的陣列（docs/18 §8「array（基本）」）
    if (!["string", "number", "integer", "boolean"].includes(String(items.type))) {
      return { error: `${path}.items 僅允許基本型別（不支援物件陣列）` };
    }
    // 陣列本身已佔一層；items 是基本型別，不再增加層級
    const cleanItems = validateNode(items, depth, `${path}.items`, state);
    if ("error" in cleanItems) return cleanItems;
    out.items = cleanItems;
    if (raw.minItems !== undefined) {
      if (!Number.isInteger(raw.minItems) || (raw.minItems as number) < 0) {
        return { error: `${path}.minItems 必須是非負整數` };
      }
      out.minItems = raw.minItems;
    }
    if (raw.maxItems !== undefined) {
      if (!Number.isInteger(raw.maxItems) || (raw.maxItems as number) < 0) {
        return { error: `${path}.maxItems 必須是非負整數` };
      }
      if ((raw.maxItems as number) > FORM_LIMITS.MAX_ARRAY_ITEMS) {
        return { error: `${path}.maxItems 不得超過 ${FORM_LIMITS.MAX_ARRAY_ITEMS}` };
      }
      out.maxItems = raw.maxItems;
    }
    return out;
  }

  // 基本型別
  if (type === "string") {
    if (raw.format !== undefined) {
      if (typeof raw.format !== "string" || !ALLOWED_FORMATS.has(raw.format)) {
        return { error: `${path}.format 僅允許 date` };
      }
      out.format = "date";
    }
    if (raw.maxLength !== undefined) {
      if (!Number.isInteger(raw.maxLength) || (raw.maxLength as number) < 0) {
        return { error: `${path}.maxLength 必須是非負整數` };
      }
      if ((raw.maxLength as number) > FORM_LIMITS.MAX_STRING) {
        return { error: `${path}.maxLength 不得超過 ${FORM_LIMITS.MAX_STRING}` };
      }
      out.maxLength = raw.maxLength;
    }
    if (raw.minLength !== undefined) {
      if (!Number.isInteger(raw.minLength) || (raw.minLength as number) < 0) {
        return { error: `${path}.minLength 必須是非負整數` };
      }
      out.minLength = raw.minLength;
    }
  } else if (type === "number" || type === "integer") {
    for (const key of ["minimum", "maximum"] as const) {
      if (raw[key] !== undefined) {
        if (typeof raw[key] !== "number" || !Number.isFinite(raw[key])) {
          return { error: `${path}.${key} 必須是有限數字` };
        }
        out[key] = raw[key];
      }
    }
  }

  if (raw.enum !== undefined) {
    if (!Array.isArray(raw.enum) || raw.enum.length === 0) {
      return { error: `${path}.enum 必須是非空陣列` };
    }
    if (raw.enum.length > 50) return { error: `${path}.enum 選項過多` };
    for (const v of raw.enum) {
      if (type === "string") {
        if (typeof v !== "string") return { error: `${path}.enum 值型別不符` };
        if (v.length > FORM_LIMITS.MAX_STRING) return { error: `${path}.enum 字串過長` };
      } else if (type === "number" || type === "integer") {
        if (typeof v !== "number" || !Number.isFinite(v)) return { error: `${path}.enum 值型別不符` };
        if (type === "integer" && !Number.isInteger(v)) return { error: `${path}.enum 值必須是整數` };
      } else if (type === "boolean") {
        if (typeof v !== "boolean") return { error: `${path}.enum 值型別不符` };
      } else {
        return { error: `${path}.enum 只能用在基本型別` };
      }
    }
    out.enum = raw.enum;
  }

  return out;
}

export type SchemaValidation =
  | { ok: true; schema: JsonObject; fields: number }
  | { ok: false; message: string };

/**
 * 驗證並消毒 schema。成功回傳**只含白名單欄位**的新物件（可直接 JSON.stringify 存 DB）。
 */
export function validateFormSchema(input: unknown): SchemaValidation {
  if (!isPlainObject(input)) return bad("schema 必須是物件");
  let encoded: string;
  try {
    encoded = JSON.stringify(input);
  } catch {
    return bad("schema 無法序列化");
  }
  if (encoded.length > FORM_LIMITS.MAX_SCHEMA_BYTES) return bad("schema 過大");

  const state: WalkState = { fields: 0 };
  const node = validateNode(input, 1, "schema", state, true);
  if ("error" in node) {
    const message = (node as { error?: unknown }).error;
    if (typeof message === "string") return bad(message);
  }
  return { ok: true, schema: node as JsonObject, fields: state.fields };
}

// ───────────────────────── 回覆 payload 驗證 ─────────────────────────

function isValidDateString(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function validateValue(
  schema: JsonObject,
  value: unknown,
  path: string,
  depth: number
): { ok: true; value: unknown } | { ok: false; message: string } {
  if (depth > FORM_LIMITS.MAX_DEPTH) return { ok: false, message: `${path} 巢狀過深` };
  const type = schema.type;

  if (type === "object") {
    if (!isPlainObject(value)) return { ok: false, message: `${path} 必須是物件` };
    const props = schema.properties as JsonObject;
    const required = (schema.required as string[] | undefined) ?? [];
    for (const key of Object.keys(value)) {
      if (!(key in props)) return { ok: false, message: `${path} 含未知欄位 ${key}` };
    }
    for (const key of required) {
      const v = value[key];
      if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) {
        return { ok: false, message: `${path}.${key} 為必填` };
      }
    }
    const out: JsonObject = {};
    for (const [key, child] of Object.entries(props)) {
      if (!(key in value) || value[key] === undefined || value[key] === null) continue;
      const childSchema = child as JsonObject;
      const childDepth = childSchema.type === "object" || childSchema.type === "array" ? depth + 1 : depth;
      const r = validateValue(childSchema, value[key], `${path}.${key}`, childDepth);
      if (!r.ok) return r;
      out[key] = r.value;
    }
    return { ok: true, value: out };
  }

  if (type === "array") {
    if (!Array.isArray(value)) return { ok: false, message: `${path} 必須是陣列` };
    if (value.length > (schema.maxItems as number | undefined ?? FORM_LIMITS.MAX_ARRAY_ITEMS)) {
      return { ok: false, message: `${path} 項目過多` };
    }
    if (value.length < ((schema.minItems as number | undefined) ?? 0)) {
      return { ok: false, message: `${path} 項目過少` };
    }
    const itemSchema = schema.items as JsonObject;
    const out: unknown[] = [];
    for (let i = 0; i < value.length; i += 1) {
      // items 僅允許基本型別（schema 已驗證）→ 不增加巢狀層級
      const r = validateValue(itemSchema, value[i], `${path}[${i}]`, depth);
      if (!r.ok) return r;
      out.push(r.value);
    }
    return { ok: true, value: out };
  }

  if (type === "string") {
    if (typeof value !== "string") return { ok: false, message: `${path} 必須是字串` };
    const max = (schema.maxLength as number | undefined) ?? FORM_LIMITS.MAX_STRING;
    if (value.length > max) return { ok: false, message: `${path} 超過長度上限 ${max}` };
    if (schema.minLength !== undefined && value.length < (schema.minLength as number)) {
      return { ok: false, message: `${path} 低於長度下限` };
    }
    if (schema.format === "date" && !isValidDateString(value)) {
      return { ok: false, message: `${path} 日期格式需為 YYYY-MM-DD` };
    }
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      return { ok: false, message: `${path} 不在允許選項內` };
    }
    return { ok: true, value };
  }

  if (type === "number" || type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { ok: false, message: `${path} 必須是數字` };
    }
    if (type === "integer" && !Number.isInteger(value)) {
      return { ok: false, message: `${path} 必須是整數` };
    }
    if (schema.minimum !== undefined && value < (schema.minimum as number)) {
      return { ok: false, message: `${path} 小於最小值` };
    }
    if (schema.maximum !== undefined && value > (schema.maximum as number)) {
      return { ok: false, message: `${path} 大於最大值` };
    }
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      return { ok: false, message: `${path} 不在允許選項內` };
    }
    return { ok: true, value };
  }

  if (type === "boolean") {
    if (typeof value !== "boolean") return { ok: false, message: `${path} 必須是布林值` };
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      return { ok: false, message: `${path} 不在允許選項內` };
    }
    return { ok: true, value };
  }

  return { ok: false, message: `${path} 型別不支援` };
}

export type PayloadValidation =
  | { ok: true; payload: JsonObject }
  | { ok: false; message: string };

/** 以已驗證的 schema 驗證回覆 payload（未知欄位一律拒絕；長度上限同上） */
export function validateFormPayload(schema: JsonObject, input: unknown): PayloadValidation {
  if (!isPlainObject(input)) return { ok: false, message: "payload 必須是物件" };
  let encoded: string;
  try {
    encoded = JSON.stringify(input);
  } catch {
    return { ok: false, message: "payload 無法序列化" };
  }
  if (encoded.length > FORM_LIMITS.MAX_PAYLOAD_BYTES) {
    return { ok: false, message: "payload 過大" };
  }
  const r = validateValue(schema, input, "payload", 1);
  if (!r.ok) return r;
  return { ok: true, payload: r.value as JsonObject };
}

// ───────────────────────── 靜態文字版（轉寄／外部閱讀）─────────────────────────

const TYPE_LABEL: Record<string, string> = {
  string: "文字",
  number: "數字",
  integer: "整數",
  boolean: "是／否",
  array: "清單",
  object: "群組",
};

/**
 * 由 schema 產生**純文字**表單摘要（供 text_preview／raw .eml／轉寄降級使用）。
 * 不輸出 HTML；所有 title／description 已經消毒。
 */
export function buildFormStaticText(schema: JsonObject): string {
  const title = typeof schema.title === "string" && schema.title ? schema.title : "互動式表單";
  const description = typeof schema.description === "string" ? schema.description : "";
  const required = new Set((schema.required as string[] | undefined) ?? []);
  const lines: string[] = [`互動式表單：${title}`];
  if (description) lines.push(description);
  lines.push("", "欄位：");
  let i = 0;
  for (const [key, raw] of Object.entries((schema.properties as JsonObject) ?? {})) {
    const prop = raw as JsonObject;
    i += 1;
    const label = typeof prop.title === "string" && prop.title ? prop.title : key;
    const req = required.has(key) ? "（必填）" : "（選填）";
    const type = TYPE_LABEL[String(prop.type)] ?? String(prop.type);
    const options = Array.isArray(prop.enum) ? `，選項：${prop.enum.map((v) => String(v)).join("／")}` : "";
    lines.push(`${i}. ${label}${req}［${type}${options}］`);
  }
  lines.push("", "請在 AtWhoMail 中開啟此信填寫；此文字版僅供轉寄或外部閱讀。");
  return lines.join("\n");
}
