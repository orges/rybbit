"use client";

import { MessageSquarePlus, Pencil, Trash2, X } from "lucide-react";
import { useExtracted } from "next-intl";
import { useState, type ReactNode } from "react";
import type { ConversationSummary } from "@/api/analyst/endpoints/analyst";
import { Button } from "@/components/ui/button";
import { ConfirmationModal } from "@/components/ConfirmationModal";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Thread list.
 *
 * A rail rather than a dropdown: an investigation is a series of threads, and
 * switching between them mid-question is the common case, not the rare one.
 */

function relativeTime(value: string) {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return "";
  const minutes = Math.round((Date.now() - timestamp) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(value).toLocaleDateString();
}

export function ConversationRail({
  conversations,
  activeId,
  onSelect,
  onNew,
  onDelete,
  onRename,
  collapsed,
  onToggle,
  footer,
  loading,
  className,
  search,
  onSearch,
}: {
  conversations: ConversationSummary[];
  activeId: string | null;
  onSelect: (id: string | null) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  collapsed: boolean;
  onToggle: () => void;
  /** Pinned below the thread list — the rail does not know what this is. */
  footer?: ReactNode;
  loading?: boolean;
  className?: string;
  search: string;
  onSearch: (value: string) => void;
}) {
  const t = useExtracted();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  if (collapsed) {
    return (
      <div
        className={cn(
          "hidden w-12 shrink-0 flex-col items-center gap-2 border-r border-neutral-150 py-2 dark:border-neutral-850 md:flex",
          className
        )}
      >
        <Button type="button" variant="ghost" size="smIcon" aria-label={t("Show chat history")} onClick={onToggle}>
          <MessageSquarePlus className="size-4" />
        </Button>
      </div>
    );
  }

  return (
    <aside
      className={cn(
        "w-60 shrink-0 flex-col border-r border-neutral-150 dark:border-neutral-850 md:flex",
        className
      )}
    >
      <div className="flex items-center gap-1.5 p-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="flex-1 justify-start gap-1.5"
          onClick={onNew}
          aria-label={t("New chat")}
        >
          <MessageSquarePlus className="size-3.5" />
          {t("New chat")}
        </Button>
        <Button type="button" variant="ghost" size="smIcon" aria-label={t("Hide chat history")} onClick={onToggle}>
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="px-2 pb-2">
        <Input
          inputSize="sm"
          isSearch
          value={search}
          onChange={event => onSearch(event.target.value)}
          placeholder={t("Search chats")}
          aria-label={t("Search chats")}
          className="h-7"
        />
      </div>
      <nav aria-label={t("Chat history")} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {loading && !conversations.length && <p className="px-1.5 py-1 text-xs text-neutral-500">{t("Loading…")}</p>}
        {!loading && !conversations.length && (
          <p className="px-1.5 py-1 text-xs text-neutral-500 dark:text-neutral-400">
            {search ? t("No matching chats") : t("No chats yet")}
          </p>
        )}
        <ul className="space-y-0.5">
          {conversations.map(conversation => (
            <li key={conversation.id}>
              {renaming === conversation.id ? (
                <div className="flex items-center gap-1">
                  <Input
                    inputSize="sm"
                    autoFocus
                    value={draft}
                    onChange={event => setDraft(event.target.value)}
                    onKeyDown={event => {
                      if (event.key === "Enter") {
                        onRename(conversation.id, draft.trim() || conversation.title);
                        setRenaming(null);
                      }
                      if (event.key === "Escape") setRenaming(null);
                    }}
                    className="h-7"
                  />
                </div>
              ) : (
                <div className="group/thread relative">
                  <button
                    type="button"
                    onClick={() => onSelect(conversation.id)}
                    aria-current={activeId === conversation.id ? "page" : undefined}
                    className={cn(
                      "block w-full rounded-md px-2 py-1.5 pr-12 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800",
                      activeId === conversation.id && "bg-neutral-100 dark:bg-neutral-800"
                    )}
                  >
                    <span className="block truncate text-xs font-medium">{conversation.title}</span>
                    {conversation.snippet ? (
                      <span className="mt-0.5 block line-clamp-2 text-[10px] leading-snug text-neutral-500 dark:text-neutral-400">
                        {conversation.snippet}
                      </span>
                    ) : null}
                    <span className="block text-[10px] text-neutral-500 dark:text-neutral-400">{relativeTime(conversation.updatedAt)}</span>
                  </button>
                  <div className="absolute right-1 top-1 hidden items-center gap-0.5 group-hover/thread:flex">
                    <Button
                      type="button"
                      variant="ghost"
                      size="smIcon"
                      aria-label={t("Rename chat")}
                      onClick={() => {
                        setRenaming(conversation.id);
                        setDraft(conversation.title);
                      }}
                    >
                      <Pencil className="size-3" />
                    </Button>
                    <ConfirmationModal
                      title={t("Delete chat")}
                      description={t(
                        'Delete "{title}"? This removes the whole thread and cannot be undone.',
                        { title: conversation.title }
                      )}
                      isOpen={deleting === conversation.id}
                      setIsOpen={open => setDeleting(open ? conversation.id : null)}
                      onConfirm={() => onDelete(conversation.id)}
                      primaryAction={{ children: t("Delete"), variant: "destructive" }}
                    >
                      <Button
                        type="button"
                        variant="ghost"
                        size="smIcon"
                        aria-label={t("Delete chat")}
                        onClick={() => setDeleting(conversation.id)}
                      >
                        <Trash2 className="size-3" />
                      </Button>
                    </ConfirmationModal>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      </nav>
      {footer}
    </aside>
  );
}
