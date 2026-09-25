"use client";
import { useWindowSize } from "@uidotdev/usehooks";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { AppSidebar } from "../../components/AppSidebar";
import { getMainDashboardPath, getSiteRouteContext } from "../../lib/siteRoute";
import { useStore } from "../../lib/store";
import { useSyncStateWithUrl } from "../../lib/urlParams";
import { Footer } from "../components/Footer";
import { Header } from "./components/Header/Header";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { useEmbedPageOptions } from "./utils";

function isMainDashboardPath(pathname: string) {
  return getSiteRouteContext(pathname).route === "main";
}

export default function SiteLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { setSiteContext, site, privateKey } = useStore();
  const { embed, hideSidebar } = useEmbedPageOptions();
  // "ask" is the name of the feature; "analyst" stays valid so an old link still lands on it.
  const isAnalyst = ["ask", "analyst"].includes(getSiteRouteContext(pathname).route ?? "");

  // Sync store state with URL parameters
  useSyncStateWithUrl();

  useEffect(() => {
    const routeContext = getSiteRouteContext(pathname);
    if (!routeContext.siteId || isNaN(Number(routeContext.siteId))) return;
    if (routeContext.siteId === site && routeContext.privateKey === privateKey) return;

    setSiteContext(routeContext.siteId, routeContext.privateKey);
  }, [pathname, privateKey, setSiteContext, site]);

  useEffect(() => {
    if (!hideSidebar || isMainDashboardPath(pathname)) return;

    const mainPath = getMainDashboardPath(pathname);
    if (!mainPath) return;

    router.replace(`${mainPath}${window.location.search}`);
  }, [hideSidebar, pathname, router]);

  const { width } = useWindowSize();

  if (width && width < 768) {
    return (
      <div className={isAnalyst ? "flex h-dvh flex-col" : undefined}>
        <Header />
        <div className={isAnalyst ? "min-h-0 flex-1" : undefined}>{children}</div>
      </div>
    );
  }

  return (
    <div className="flex flex-row h-dvh">
      <AppSidebar />
      <div className="flex flex-1 overflow-hidden">
        {!hideSidebar && (
          <div className="hidden md:flex">
            <Sidebar />
          </div>
        )}
        <div className="flex-1 overflow-auto">
          <div className={isAnalyst ? "flex h-full min-h-0 flex-col" : "min-h-full flex flex-col"}>
            {/* <div className="px-4 py-2 max-w-[1400px] mx-auto w-full mb-4"> */}
            <Header />
            <div className={isAnalyst ? "min-h-0 flex-1" : "flex-1"}>{children}</div>
            {!pathname.includes("/map") &&
              !pathname.includes("/realtime") &&
              !pathname.includes("/replay") &&
              !pathname.includes("/globe") &&
              !pathname.includes("/api-playground") &&
              !pathname.includes("/query") &&
              !pathname.includes("/analyst") && <Footer disabled={embed} />}
          </div>
        </div>
      </div>
    </div>
  );
}
