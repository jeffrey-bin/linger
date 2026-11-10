import type { InputHTMLAttributes, ReactNode } from "react";
import { useId } from "react";

export const fieldControlClassName =
  "ui-field-control w-full text-sm text-foreground placeholder:text-muted-foreground disabled:cursor-not-allowed";

export function Field({
  className = "",
  error,
  hint,
  id,
  inputClassName = "",
  label,
  labelClassName = "",
  prefix,
  suffix,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "prefix" | "size"> & {
  error?: string | null;
  hint?: string;
  inputClassName?: string;
  label: string;
  labelClassName?: string;
  prefix?: ReactNode;
  suffix?: ReactNode;
}) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className={`ui-field ${className}`}>
      <label
        className={`mb-1.5 block text-sm font-medium text-foreground ${labelClassName}`}
        htmlFor={inputId}
      >
        {label}
      </label>
      <div className="ui-field-frame">
        <input
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          className={`${fieldControlClassName} ${prefix ? "pl-12" : ""} ${suffix ? "pr-11" : ""} ${inputClassName}`}
          id={inputId}
          {...props}
        />
        {prefix ? (
          <span className="pointer-events-none absolute inset-y-0 left-0 flex w-12 items-center justify-center text-muted-foreground">
            {prefix}
          </span>
        ) : null}
        {suffix ? (
          <span className="absolute inset-y-0 right-0 flex w-11 items-center justify-center">
            {suffix}
          </span>
        ) : null}
      </div>
      {hint ? (
        <p className="mt-1.5 text-xs text-muted-foreground" id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="mt-1.5 text-xs text-destructive" id={errorId}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
