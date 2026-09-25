"use client";

import { useParams } from "next/navigation";
import { useGetSite } from "../../../api/admin/hooks/useSites";
import { useSetPageTitle } from "../../../hooks/useSetPageTitle";
import { AnalystChat } from "./components/AnalystChat";

export default function AnalystPage() {
  useSetPageTitle("Ask");
  const { site } = useParams<{ site: string }>();
  const siteId = Number(site);
  const { data } = useGetSite(siteId);

  if (!data?.organizationId) return null;
  return <AnalystChat siteId={siteId} organizationId={data.organizationId} />;
}
