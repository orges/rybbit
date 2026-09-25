"use client";

import { CalendarDays, Copy, Filter, Globe, RefreshCw, ThumbsDown, ThumbsUp, TriangleAlert } from "lucide-react";
import { useExtracted } from "next-intl";
import { useState, type ReactNode } from "react";
import type { AnalystArtifact, ChatMessage, MessageContext } from "@/api/analyst/endpoints/analyst";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ArtifactCard } from "./ArtifactCard";
import { resultLink } from "./links";
import { Markdown } from "./Markdown";
import { ToolActivity } from "./ToolActivity";

/**
 * One turn of the conversation.
 *
 * The user message carries the dashboard context it was asked from, so an answer
 * that used a filter or a date range is auditable after the fact instead of
 * being a claim with no provenance.
 */

function ContextChips({ context }: { context?: MessageContext }) {
  if (!context) return null;
  const t = useExtracted();
  const chips: Array<{ icon: ReactNode; label: string }> = [];
  if (context.rangeLabel || context.startDate) {
    chips.push({
      icon: <CalendarDays className="size-3" />,
      label: context.rangeLabel || `${context.startDate} → ${context.endDate}`,
    });
  }
  if (context.filters?.length) {
    chips.push({
      icon: <Filter className="size-3" />,
      label: t("{count} filter(s)", { count: String(context.filters.length) }),
    });
  }
  if (context.page) {
    chips.push({ icon: <Globe className="size-3" />, label: context.page });
  }
  if (!chips.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap justify-end gap-1">
      {chips.map(chip => (
        <span
          key={chip.label}
          className="flex items-center gap-1 rounded-md border border-neutral-150 bg-white px-1.5 py-0.5 text-[10px] text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400"
        >
          {chip.icon}
          {chip.label}
        </span>
      ))}
    </div>
  );
}

function MessageActions({
  message,
  onRetry,
  onFeedback,
}: {
  message: ChatMessage;
  onRetry: () => void;
  onFeedback: (rating: number) => void;
}) {
  const t = useExtracted();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
      <Button
        type="button"
        variant="ghost"
        size="smIcon"
        aria-label={t("Copy answer")}
        onClick={() => {
          void navigator.clipboard?.writeText(message.content);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        <Copy className={cn("size-3.5", copied && "text-emerald-500")} />
      </Button>
      <Button type="button" variant="ghost" size="smIcon" aria-label={t("Try again")} onClick={onRetry}>
        <RefreshCw className="size-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="smIcon"
        aria-label={t("Good answer")}
        onClick={() => onFeedback(1)}
        className={cn(message.rating === 1 && "opacity-100 text-emerald-500")}
      >
        <ThumbsUp className="size-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="smIcon"
        aria-label={t("Bad answer")}
        onClick={() => onFeedback(-1)}
        className={cn(message.rating === -1 && "opacity-100 text-red-500")}
      >
        <ThumbsDown className="size-3.5" />
      </Button>
    </div>
  );
}

export function MessageItem({
  message,
  onRetry,
  onFeedback,
  onFollowup,
  siteId,
}: {
  message: ChatMessage;
  onRetry: () => void;
  onFeedback: (rating: number) => void;
  onFollowup: (value: string) => void;
  siteId: number;
}) {
  // A chart or table is drawn by show_chart/show_table, but the data came from an
  // analytics tool — the artifact carries that name so the link goes to the page
  // that owns the data, not to a page for the drawing tool.
  const linkFor = (artifact: AnalystArtifact) => {
    if (!("source" in artifact) || !artifact.source) return null;
    // The breakdown's dimension (which page it opens) is an argument of the
    // analytics call that fetched the rows.
    const sourceCall = message.toolCalls?.find(call => call.name === artifact.source);
    return resultLink(artifact.source, sourceCall?.input, siteId);
  };
  const t = useExtracted();

  if (message.role === "user") {
    return (
      <div className="group flex flex-col items-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-lg rounded-br-sm bg-neutral-100 px-3 py-2 text-sm dark:bg-neutral-800">
          {message.content}
        </div>
        <ContextChips context={message.context} />
      </div>
    );
  }

  const hasContent = message.content.trim().length > 0;
  return (
    <div className="group space-y-2.5">
      <ToolActivity reasoning={message.reasoning} toolCalls={message.toolCalls} running={message.pending && !hasContent} />
      {hasContent && <Markdown>{message.content}</Markdown>}
      {(message.artifacts ?? []).map((artifact, index) => (
        <ArtifactCard key={index} artifact={artifact} onFollowup={onFollowup} link={linkFor(artifact)} siteId={siteId} />
      ))}
      {message.error && (
        <p role="alert" className="flex items-start gap-1.5 text-xs text-red-600 dark:text-red-400">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          {message.error}
        </p>
      )}
      {message.pending && !hasContent && !message.toolCalls?.length && <ThinkingDots />}
      {message.stopped && <p className="text-[11px] text-neutral-500 dark:text-neutral-400">{t("Stopped")}</p>}
      {hasContent && !message.pending && <MessageActions message={message} onRetry={onRetry} onFeedback={onFeedback} />}
      {message.usage?.completion_tokens ? (
        <p className="text-[10px] tabular-nums text-neutral-400">
          {`${message.usage.prompt_tokens ?? 0} in · ${message.usage.completion_tokens} out`}
          {message.model ? ` · ${message.model}` : ""}
        </p>
      ) : null}
    </div>
  );
}

function ThinkingDots() {
  return (
    <div className="flex items-center gap-1 py-1" aria-label="Thinking">
      {[0, 1, 2].map(index => (
        <span
          key={index}
          className="size-1.5 animate-pulse rounded-full bg-neutral-400"
          style={{ animationDelay: `${index * 160}ms` }}
        />
      ))}
    </div>
  );
}
