"use client";

import { ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import { useExtracted } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useDeleteMemory, useMemories } from "@/api/analyst/hooks/useAnalyst";

/**
 * What the analyst has been told about this Site.
 *
 * `/remember` writes a note that is injected into every later question on the
 * Site, so it is the one input here with effects far outside the thread that set
 * it. That makes it worth being able to read: a note that has gone stale, or that
 * says something nobody intended to keep, is otherwise invisible until it shows up
 * as a strange answer weeks later.
 *
 * Collapsed by default and pinned below the thread list, because it is reference
 * material rather than somewhere to work.
 */
export function ProjectMemory({ organizationId, siteId }: { organizationId: string; siteId: number }) {
  const t = useExtracted();
  const [open, setOpen] = useState(false);
  const { data: memories, isLoading } = useMemories(organizationId, siteId);
  const remove = useDeleteMemory(organizationId, siteId);
  const notes = memories ?? [];

  if (isLoading && !notes.length) return null;

  return (
    <div className="border-t border-neutral-150 px-2 py-2 dark:border-neutral-850">
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
      >
        {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
        {t("Project memory")}
        {notes.length > 0 && <span className="text-neutral-400 dark:text-neutral-500">{notes.length}</span>}
      </button>

      {open && (
        <div className="mt-1.5 space-y-1">
          {notes.length === 0 ? (
            <p className="px-1.5 text-xs text-neutral-500 dark:text-neutral-400">
              {t("Nothing yet. Use /remember to tell it what a term means on this site.")}
            </p>
          ) : (
            <ul className="max-h-48 space-y-0.5 overflow-y-auto">
              {notes.map(memory => (
                <li key={memory.id} className="group/note relative flex items-start gap-1 rounded-md px-1.5 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800">
                  <p className="min-w-0 flex-1 text-xs break-words text-neutral-600 dark:text-neutral-300">{memory.content}</p>
                  <Button
                    type="button"
                    variant="ghost"
                    size="smIcon"
                    aria-label={t("Forget this")}
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(memory.id)}
                    className="h-5 w-5 shrink-0 opacity-0 transition-opacity group-hover/note:opacity-100 focus-visible:opacity-100"
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
