"use client";

import { ArrowUp, PencilLine, Square } from "lucide-react";
import { useExtracted } from "next-intl";
import { useEffect, useRef, type FormEvent, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";

/**
 * The composer.
 *
 * Pinned to the bottom of the column, growing with the question but never
 * pushing the transcript off screen. Enter sends, Shift+Enter breaks the line,
 * and the send button turns into a stop button while the analyst is working.
 */

export function ChatComposer({
  value,
  onChange,
  onSubmit,
  onStop,
  streaming,
  disabled,
  placeholder,
  inputRef,
  editing,
  onCancelEdit,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  streaming: boolean;
  disabled?: boolean;
  placeholder?: string;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  /** A re-ask is in progress: the question is loaded and Enter replaces it. */
  editing?: boolean;
  onCancelEdit?: () => void;
}) {
  const t = useExtracted();
  const localRef = useRef<HTMLTextAreaElement>(null);
  const ref = inputRef ?? localRef;

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "0px";
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  }, [value]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (streaming || !value.trim()) return;
    onSubmit();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape" && editing) {
      event.preventDefault();
      onCancelEdit?.();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form
      onSubmit={submit}
      className="border-t border-neutral-150 bg-white px-3 py-3 dark:border-neutral-850 dark:bg-neutral-900 md:px-4"
    >
      {editing && (
        <div className="mx-auto mb-1.5 flex w-full max-w-[100rem] items-center gap-2 px-2 text-[11px] text-neutral-500 lg:px-6 dark:text-neutral-400">
          <PencilLine className="size-3" />
          <span>{t("Editing question — sending replaces it and every answer after it")}</span>
          <button
            type="button"
            onClick={onCancelEdit}
            className="ml-auto underline underline-offset-2 hover:text-neutral-700 dark:hover:text-neutral-200"
          >
            {t("Cancel")}
          </button>
        </div>
      )}
      {/* The column matches the thread, and the box inside it starts on the same
          edge as the prose and the artifacts rather than on a third one. */}
      <div className="mx-auto w-full max-w-[100rem] px-2 lg:px-6">
        <div className="flex max-w-4xl items-end gap-2 rounded-lg border border-neutral-150 bg-white px-2 py-1.5 focus-within:ring-1 focus-within:ring-neutral-400 dark:border-neutral-800 dark:bg-neutral-950">
          <textarea
            ref={ref}
            rows={1}
            value={value}
            onChange={event => onChange(event.target.value)}
            onKeyDown={onKeyDown}
            maxLength={4000}
            disabled={disabled}
            aria-label={t("Ask about your analytics")}
            placeholder={placeholder ?? t("Ask about this site's analytics")}
            className="max-h-[200px] min-h-9 flex-1 resize-none bg-transparent px-1.5 py-1.5 text-sm outline-none placeholder:text-neutral-400"
          />
          {streaming ? (
            <button
              type="button"
              onClick={onStop}
              aria-label={t("Stop generating")}
              className="flex size-8 shrink-0 items-center justify-center rounded-md border border-neutral-150 text-neutral-600 hover:bg-neutral-100 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              <Square className="size-3.5 fill-current" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!value.trim() || disabled}
              aria-label={t("Send")}
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-md transition-colors",
                value.trim() && !disabled
                  ? "bg-neutral-900 text-neutral-50 hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
                  : "cursor-not-allowed text-neutral-300 dark:text-neutral-700"
              )}
            >
              <ArrowUp className="size-4" />
            </button>
          )}
        </div>
      </div>
    </form>
  );
}
