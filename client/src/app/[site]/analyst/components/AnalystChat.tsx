"use client";

import { ArrowDown, ArrowUp, MessageSquareText, Sparkles } from "lucide-react";
import { useExtracted } from "next-intl";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "react-hot-toast";
import {
  getConversation,
  sendFeedback,
  type ChatMessage,
  type MessageContext,
} from "@/api/analyst/endpoints/analyst";
import { useAddMemory, useConversations, useDeleteConversation, useRenameConversation } from "@/api/analyst/hooks/useAnalyst";
import { getStartAndEndDate } from "@/api/utils";
import { Button } from "@/components/ui/button";
import { useStore, useTimezone } from "@/lib/store";
import { ChatComposer } from "./ChatComposer";
import { ConversationRail } from "./ConversationRail";
import { MessageItem } from "./MessageItem";
import { useChatStream } from "./useChatStream";

/**
 * The analyst page.
 *
 * Layout is fixed-height and scroll-owned: the thread scrolls, the composer
 * stays put, and following the stream is automatic until the reader scrolls up —
 * at which point it stops, and a button offers to jump back. Nothing here
 * re-queries analytics; every number on screen came from a tool result.
 */

const EXAMPLES = [
  "How is traffic trending compared to the previous period?",
  "Which pages get the most views but the worst bounce rate?",
  "What are the top custom events today?",
  "Break down sessions by country for the last 7 days.",
];

const STOP_FOLLOW_THRESHOLD = 120;

export function AnalystChat({ siteId, organizationId }: { siteId: number; organizationId: string }) {
  const t = useExtracted();
  const time = useStore(state => state.time);
  const filters = useStore(state => state.filters);
  const selectedStat = useStore(state => state.selectedStat);
  const timeZone = useTimezone();

  const [draft, setDraft] = useState("");
  /** The question being re-asked, if any. */
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const [chatSearch, setChatSearch] = useState("");
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [follow, setFollow] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const context = useMemo<MessageContext>(() => {
    const { startDate, endDate } = getStartAndEndDate(time, timeZone);
    return {
      ...(startDate ? { startDate } : {}),
      ...(endDate ? { endDate } : {}),
      timeZone,
      filters,
      ...(selectedStat ? { stat: selectedStat } : {}),
    };
  }, [filters, selectedStat, time, timeZone]);

  // Deferred so a search runs once the typing settles, not once per keystroke.
  const conversationSearch = useDeferredValue(chatSearch);
  const conversations = useConversations(organizationId, siteId, conversationSearch);
  const removeConversation = useDeleteConversation(organizationId, siteId);
  const renameConversation = useRenameConversation(organizationId, siteId);
  const addMemory = useAddMemory(organizationId, siteId);

  const { messages, conversationId, streaming, send, stop, load, setRating } = useChatStream({
    organizationId,
    siteId,
    context,
    onConversation: () => {
      void conversations.refetch();
    },
  });

  const loadConversation = useCallback(
    async (id: string | null) => {
      setFollow(true);
      // A pending edit belongs to the thread it came from.
      setEditing(null);
      if (!id) {
        load([], "");
        return;
      }
      try {
        const detail = await getConversation(organizationId, siteId, id);
        load(detail.messages ?? [], detail.id);
      } catch {
        toast.error(t("Could not load chat"));
      }
    },
    [load, organizationId, siteId, t]
  );

  // Keep the transcript pinned to the newest content while the reader is at the
  // bottom, and only while the reader wants it.
  useEffect(() => {
    const pane = scrollRef.current;
    if (pane && follow) pane.scrollTop = pane.scrollHeight;
  }, [messages, follow]);

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    // /remember <text> stores a durable note about this site for every future
    // question, which is the one thing a chat transcript cannot do on its own.
    const remember = /^\/remember\s+([\s\S]+)$/.exec(text);
    if (remember) {
      addMemory.mutate(remember[1].trim(), { onSuccess: () => toast.success(t("Remembered for this site")) });
      setDraft("");
      setEditing(null);
      return;
    }
    if (/^\/usage$/i.test(text)) {
      const totals = messages.reduce(
        (sum, message) => ({
          prompt: sum.prompt + (message.usage?.prompt_tokens ?? 0),
          completion: sum.completion + (message.usage?.completion_tokens ?? 0),
        }),
        { prompt: 0, completion: 0 }
      );
      toast(
        t("This chat used {prompt} input and {completion} output tokens", {
          prompt: String(totals.prompt),
          completion: String(totals.completion),
        }),
        { icon: "⚡" }
      );
      setDraft("");
      setEditing(null);
      return;
    }
    setFollow(true);
    setDraft("");
    const reask = editing;
    setEditing(null);
    void send(text, reask ? { editOfMessageId: reask.id } : undefined);
  };

  /** Loads a past question back into the composer so it can be asked differently. */
  const editQuestion = (message: ChatMessage) => {
    setEditing(message);
    setDraft(message.content);
    composerRef.current?.focus();
  };

  const retry = (message: ChatMessage) => {
    const question = [...messages].reverse().find(entry => entry.role === "user" && entry.id !== message.id);
    if (question) void send(question.content, { regenerate: true });
  };

  const feedback = async (message: ChatMessage, rating: number) => {
    setRating(message.id, rating);
    try {
      await sendFeedback(organizationId, { siteId, messageId: message.id, rating });
    } catch {
      toast.error(t("Could not save feedback"));
    }
  };

  const deleteThread = (id: string) => {
    removeConversation.mutate(id, {
      onSuccess: () => {
        if (id === conversationId) load([], "");
        toast.success(t("Chat deleted"));
      },
      onError: () => toast.error(t("Could not delete chat")),
    });
  };

  return (
    // A small even inset, like every other page here. Removing the padding
    // entirely ran the panel off the bottom and right edges, which reads as
    // broken rather than full-bleed.
    <div className="flex h-full min-h-0 w-full p-2 md:p-3">
      <section
        className="relative flex min-h-0 w-full overflow-hidden rounded-lg border border-neutral-150 bg-white dark:border-neutral-850 dark:bg-neutral-900"
        aria-label={t("Ask")}
      >
        <ConversationRail
          className={railOpen ? "absolute inset-y-0 left-0 z-20 flex shadow-lg" : "hidden"}
          conversations={conversations.data ?? []}
          activeId={conversationId}
          loading={conversations.isLoading}
          collapsed={railCollapsed}
          search={chatSearch}
          onSearch={setChatSearch}
          onToggle={() => {
            setRailOpen(false);
            setRailCollapsed(value => !value);
          }}
          onSelect={id => {
            setRailOpen(false);
            void loadConversation(id);
          }}
          onNew={() => {
            setRailOpen(false);
            void loadConversation(null);
          }}
          onDelete={deleteThread}
          onRename={(id, title) => renameConversation.mutate({ id, title })}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b border-neutral-150 px-4 py-2.5 dark:border-neutral-850">
            <Button
              type="button"
              variant="ghost"
              size="smIcon"
              className="md:hidden"
              aria-label={t("Chat history")}
              onClick={() => setRailOpen(true)}
            >
              <MessageSquareText className="size-4" />
            </Button>
            <Sparkles className="hidden size-4 text-neutral-400 sm:block" />
            <h1 className="text-sm font-medium">{t("Ask")}</h1>
            <span className="ml-auto text-[11px] text-neutral-500 dark:text-neutral-400">
              {context.startDate ? `${context.startDate} → ${context.endDate}` : t("All time")}
            </span>
          </div>

          <div
            ref={scrollRef}
            data-testid="analyst-messages"
            onScroll={event => {
              const pane = event.currentTarget;
              setFollow(pane.scrollHeight - pane.scrollTop - pane.clientHeight < STOP_FOLLOW_THRESHOLD);
            }}
            className="min-h-0 flex-1 overflow-y-auto px-4 py-5"
          >
            {/* Prose holds a reading measure and centres in the pane; artifacts
                run to the full width of it, so a chart is a chart rather than a
                thumbnail. The cap is generous enough to only bite on a very wide
                monitor, where some margin is better than 2000px line lengths. */}
            <div className="mx-auto w-full max-w-[100rem] space-y-7 px-2 pb-4 lg:px-6">
              {messages.length === 0 ? (
                <EmptyState onPick={setDraft} />
              ) : (
                messages.map(message => (
                  <MessageItem
                    key={message.id}
                    message={message}
                    onRetry={() => retry(message)}
                    onEdit={() => editQuestion(message)}
                    onFeedback={rating => void feedback(message, rating)}
                    siteId={siteId}
                    onFollowup={value => {
                      setDraft(value);
                      composerRef.current?.focus();
                    }}
                  />
                ))
              )}
            </div>
          </div>

          {!follow && messages.length > 0 && (
            <div className="pointer-events-none relative -mt-10 flex justify-center">
              <Button
                variant="secondary"
                size="sm"
                className="pointer-events-auto gap-1.5 rounded-full shadow-md"
                onClick={() => {
                  setFollow(true);
                  const pane = scrollRef.current;
                  if (pane) pane.scrollTop = pane.scrollHeight;
                }}
              >
                <ArrowDown className="size-3.5" />
                {t("Jump to latest")}
              </Button>
            </div>
          )}

          <ChatComposer
            inputRef={composerRef}
            value={draft}
            onChange={setDraft}
            onSubmit={submit}
            onStop={stop}
            streaming={streaming}
            disabled={!organizationId}
            editing={editing !== null}
            onCancelEdit={() => {
              setEditing(null);
              setDraft("");
            }}
          />
        </div>
      </section>
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (value: string) => void }) {
  const t = useExtracted();
  return (
    // Fills the pane rather than sitting in the top third of it, and uses the
    // full thread width: four suggestions in two columns across the pane, not
    // four short cards marooned in the left half.
    <div className="flex min-h-[calc(100dvh-14rem)] flex-col justify-center gap-8">
      <div className="space-y-2">
        <h2 className="text-xl font-semibold">{t("Ask your analytics")}</h2>
        <p className="max-w-2xl text-sm text-neutral-500 dark:text-neutral-400">
          {t("Ask about this site and get an answer from the data: trends, pages, events, errors, retention or replays.")}
        </p>
      </div>
      <div className="grid w-full gap-2 sm:grid-cols-2">
        {EXAMPLES.map(example => (
          <button
            key={example}
            type="button"
            onClick={() => onPick(example)}
            className="flex items-center gap-2.5 rounded-lg border border-neutral-150 px-3.5 py-3 text-left text-sm text-neutral-700 transition-colors hover:border-neutral-300 hover:bg-neutral-50 dark:border-neutral-850 dark:text-neutral-200 dark:hover:border-neutral-700 dark:hover:bg-neutral-800"
          >
            <ArrowUp className="size-3.5 shrink-0 text-neutral-300 dark:text-neutral-600" />
            {example}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-neutral-400">{t("Tip: use /remember to save a note for future questions.")}</p>
    </div>
  );
}
