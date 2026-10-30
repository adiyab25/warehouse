import * as React from "react";

export function FormField({
  label,
  error,
  children,
  htmlFor,
}: {
  label?: string;
  error?: string;
  children: React.ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      {label ? (
        <label htmlFor={htmlFor} className="text-sm font-medium">
          {label}
        </label>
      ) : null}
      {children}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}