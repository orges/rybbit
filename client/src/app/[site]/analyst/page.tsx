"use client";

import { useParams } from "next/navigation";
import { useGetSite } from "../../../api/admin/hooks/useSites";
import { useSetPageTitle } from "../../../hooks/useSetPageTitle";
import { AnalystPanel } from "../query/components/AnalystPanel";

export default function AnalystPage() {
  useSetPageTitle("AI analyst");
  const { site } = useParams<{ site: string }>();
  const siteId = Number(site);
  const { data } = useGetSite(siteId);

  return (
    <div className="mx-auto flex h-full min-h-0 max-w-[1400px] flex-col p-2 md:p-4">
      <AnalystPanel siteId={siteId} organizationId={data?.organizationId ?? undefined} />
    </div>
  );
}
