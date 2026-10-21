/**
 * FormRenderer — RJSF 渲染互動式表單（docs/18 §8／§12）
 *
 * 設計約束：
 *  - 使用 `@rjsf/core` ＋ `@rjsf/validator-ajv8`；自訂 widgets 與手寫 CSS，不引入 UI 框架。
 *  - `title`／`description` 在後端已消毒；前端再消毒一次並以 React 文字節點渲染。
 *  - 只呼叫呼叫端提供的 `onSubmit`（呼叫端只打自家 `/api/forms/:id/responses`）。
 *  - 不使用 `dangerouslySetInnerHTML`；回覆內容永遠當資料。
 */
import { useMemo } from "react";
import Form from "@rjsf/core";
import validator from "@rjsf/validator-ajv8";
import type { RJSFSchema, WidgetProps } from "@rjsf/utils";
import type { FormSchema } from "../api/types";
import { sanitizeSchemaForDisplay } from "../lib/formText";

function controlClass(props: WidgetProps): string {
  const errors = props.rawErrors?.length ? " has-error" : "";
  return `form-control${errors}`;
}

/** 文字／數字輸入；長字串自動改用 textarea（仍以 maxLength 約束） */
function TextWidget(props: WidgetProps) {
  const { id, value, onChange, disabled, readonly, placeholder, schema } = props;
  const text = value === undefined || value === null ? "" : String(value);
  const long = typeof schema.maxLength === "number" && schema.maxLength > 200;
  if (long) {
    return (
      <textarea
        id={id}
        className={controlClass(props)}
        value={text}
        rows={4}
        maxLength={schema.maxLength}
        placeholder={placeholder}
        disabled={disabled || readonly}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <input
      id={id}
      className={controlClass(props)}
      type="text"
      value={text}
      maxLength={schema.maxLength}
      placeholder={placeholder}
      disabled={disabled || readonly}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** format: date（後端只允許此 format） */
function DateWidget(props: WidgetProps) {
  const { id, value, onChange, disabled, readonly } = props;
  return (
    <input
      id={id}
      className={controlClass(props)}
      type="date"
      value={typeof value === "string" ? value : ""}
      disabled={disabled || readonly}
      onChange={(e) => onChange(e.target.value || undefined)}
    />
  );
}

/** enum → select（值仍為原始型別，避免數字 enum 變成字串） */
function SelectWidget(props: WidgetProps) {
  const { id, value, onChange, disabled, readonly, options, placeholder } = props;
  const opts = options.enumOptions ?? [];
  const index = opts.findIndex((o) => String(o.value) === String(value));
  return (
    <select
      id={id}
      className={controlClass(props)}
      value={index >= 0 ? String(index) : ""}
      disabled={disabled || readonly}
      onChange={(e) => {
        const i = Number(e.target.value);
        onChange(Number.isInteger(i) && opts[i] ? opts[i]!.value : undefined);
      }}
    >
      <option value="">{placeholder ?? "請選擇"}</option>
      {opts.map((o, i) => (
        <option key={`${String(o.value)}-${i}`} value={String(i)}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function CheckboxWidget(props: WidgetProps) {
  const { id, value, onChange, disabled, readonly } = props;
  return (
    <input
      id={id}
      className="form-checkbox"
      type="checkbox"
      checked={value === true}
      disabled={disabled || readonly}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

function TextareaWidget(props: WidgetProps) {
  const { id, value, onChange, disabled, readonly, placeholder, schema } = props;
  return (
    <textarea
      id={id}
      className={controlClass(props)}
      value={typeof value === "string" ? value : ""}
      rows={5}
      maxLength={typeof schema.maxLength === "number" ? schema.maxLength : undefined}
      placeholder={placeholder}
      disabled={disabled || readonly}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

const WIDGETS = {
  TextWidget,
  DateWidget,
  SelectWidget,
  CheckboxWidget,
  TextareaWidget,
};

interface Props {
  schema: FormSchema;
  onSubmit: (data: Record<string, unknown>) => void;
  submitting?: boolean;
  submitLabel?: string;
}

export function FormRenderer({ schema, onSubmit, submitting = false, submitLabel = "送出回覆" }: Props) {
  // 縱深防禦：後端已消毒，前端再消毒一次；RJSF 只以文字渲染 title／description
  const safeSchema = useMemo(() => sanitizeSchemaForDisplay(schema) as RJSFSchema, [schema]);

  return (
    <div className="form-renderer">
      <Form
        schema={safeSchema}
        validator={validator}
        widgets={WIDGETS}
        disabled={submitting}
        noHtml5Validate
        showErrorList="top"
        onSubmit={(e) => onSubmit((e.formData ?? {}) as Record<string, unknown>)}
      >
        <div className="form-actions">
          <button type="submit" className="btn-primary" disabled={submitting}>
            {submitting ? "送出中…" : submitLabel}
          </button>
        </div>
      </Form>
    </div>
  );
}
