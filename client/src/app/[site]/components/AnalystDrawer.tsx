"use client";

import { MessageSquareText, X } from "lucide-react";
import { useExtracted } from "next-intl";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useGetSite } from "../../../api/admin/hooks/useSites";
import { Button } from "../../../components/ui/button";
import { DEPLOYMENT, IS_CLOUD } from "../../../lib/const";
import { getSiteRouteContext } from "../../../lib/siteRoute";
import { userStore } from "../../../lib/userStore";
import { AnalystPanel } from "../query/components/AnalystPanel";

const ANALYST_PAGES = new Set([
  "main",
  "events",
  "errors",
  "funnels",
  "journeys",
  "retention",
  "pages",
  "performance",
  "replay",
  "users",
  "sessions",
  "goals",
  "bots",
  "dashboards",
  "query",
  "experiments",
  "feature-flags",
]);

export function AnalystDrawer({ embed }: { embed: boolean }) {
  const t = useExtracted();
  const pathname = usePathname();
  const { siteId: routeSiteId, privateKey, route } = getSiteRouteContext(pathname);
  const siteId = Number(routeSiteId);
  const { user } = userStore();
  const available =
    !!user && !embed && !privateKey && !!(IS_CLOUD || DEPLOYMENT) && Number.isSafeInteger(siteId) && siteId > 0;
  const [open, setOpen] = useState(false);
  const wasOpen = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const { data: site, isError } = useGetSite(siteId, { enabled: available && open });

  useEffect(() => {
    if (!available) setOpen(false);
  }, [available]);
  useEffect(() => {
    if (open) panel.current?.querySelector<HTMLInputElement>("input")?.focus();
    else if (wasOpen.current) trigger.current?.focus();
    wasOpen.current = open;
  }, [open]);

  if (!available) return null;

  return (
    <>
      {!open && (
        <Button
          ref={trigger}
          type="button"
          onClick={() => setOpen(true)}
          className="fixed bottom-4 right-4 z-40 gap-2"
          aria-expanded={false}
          aria-controls="site-ai-analyst"
        >
          <MessageSquareText className="h-4 w-4" />
          {t("AI analyst")}
        </Button>
      )}
      <aside
        id="site-ai-analyst"
        ref={panel}
        aria-label={t("AI analyst")}
        onKeyDown={event => {
          if (event.key === "Escape") setOpen(false);
        }}
        className={`fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-neutral-150 bg-white p-2 dark:border-neutral-850 dark:bg-neutral-900 sm:w-[440px] ${open ? "" : "hidden"}`}
      >
        <div className="flex justify-end pb-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => setOpen(false)}
            aria-label={t("Close AI analyst")}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        {isError && (
          <p role="alert" className="px-3 text-sm text-red-600 dark:text-red-400">
            {t("Could not load Site access")}
          </p>
        )}
        <AnalystPanel
          key={siteId}
          organizationId={site?.organizationId ?? undefined}
          siteId={siteId}
          currentPage={route && ANALYST_PAGES.has(route) ? route : undefined}
        />
      </aside>
    </>
  );
}
