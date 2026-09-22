import { fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ pathname: "/42/main", mounts: 0 }));
vi.mock("next/navigation", () => ({ usePathname: () => state.pathname }));
vi.mock("next-intl", () => ({ useExtracted: () => (value: string) => value }));
vi.mock("../../../lib/const", async importOriginal => ({
  ...(await importOriginal<typeof import("../../../lib/const")>()),
  IS_CLOUD: true,
}));
vi.mock("../../../lib/userStore", () => ({ userStore: () => ({ user: { id: "user-1" } }) }));
vi.mock("../../../api/admin/hooks/useSites", () => ({
  useGetSite: () => ({ data: { organizationId: "org-1" }, isError: false }),
}));
vi.mock("../query/components/AnalystPanel", () => ({
  AnalystPanel: () => {
    useEffect(() => {
      state.mounts++;
    }, []);
    return <div>Conversation</div>;
  },
}));

import { AnalystDrawer } from "./AnalystDrawer";

afterEach(() => {
  document.body.innerHTML = "";
  state.pathname = "/42/main";
  state.mounts = 0;
});

it("keeps the conversation mounted across Site routes and hides it on private links", () => {
  const { rerender } = render(<AnalystDrawer embed={false} />);
  fireEvent.click(screen.getByRole("button", { name: "AI analyst" }));
  expect(screen.getByText("Conversation")).toBeTruthy();
  expect(state.mounts).toBe(1);

  state.pathname = "/42/events";
  rerender(<AnalystDrawer embed={false} />);
  expect(state.mounts).toBe(1);

  state.pathname = "/43/main";
  rerender(<AnalystDrawer embed={false} />);
  expect(state.mounts).toBe(2);

  state.pathname = "/43/abcdef123456/main";
  rerender(<AnalystDrawer embed={false} />);
  expect(screen.queryByText("Conversation")).toBeNull();
});
