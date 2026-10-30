import * as React from "react";

export function ErrorState({
  title,
  description,
  onRetry,
  retryLabel = "Retry",
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
      <p className="text-base font-medium">{title ?? "Something went wrong"}</p>
      {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="h-11 min-w-11 rounded-lg border px-4 text-sm"
        >
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}