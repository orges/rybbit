import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), remove: vi.fn() }));
vi.mock("next-intl", () => ({ useExtracted: () => (value: string) => value }));
vi.mock("../../../../api/analytics/endpoints/customQuery", () => ({
  listAiConversations: mocks.list,
  getAiConversation: mocks.get,
  generateCustomQuery: vi.fn(),
  analyzeQuery: vi.fn(),
  deleteAiConversation: mocks.remove,
}));

import { AnalystPanel } from "./AnalystPanel";

afterEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

it("restores a saved conversation and can start a new one without deleting the old thread", async () => {
  mocks.list.mockResolvedValue([{ id: "saved-1", title: "Visits?", updatedAt: "2026-09-22" }]);
  mocks.get.mockResolvedValue([
    {
      question: "Visits?",
      query: "SELECT count() FROM scoped_events",
      summary: "Saved answer",
      rows: [{ visits: 4 }],
      rowCount: 1,
    },
  ]);
  render(<AnalystPanel organizationId="org-1" siteId={42} />);
  expect(await screen.findByText("Saved answer")).toBeTruthy();
  expect(mocks.get).toHaveBeenCalledWith("org-1", 42, "saved-1", expect.any(AbortSignal));

  vi.spyOn(window, "confirm").mockReturnValue(false);
  fireEvent.click(screen.getByRole("button", { name: "Delete conversation" }));
  expect(mocks.remove).not.toHaveBeenCalled();
  vi.restoreAllMocks();

  fireEvent.change(screen.getByRole("combobox", { name: "Conversation history" }), { target: { value: "" } });
  expect(screen.queryByText("Saved answer")).toBeNull();
  expect(screen.getByRole("option", { name: "Visits?" })).toBeTruthy();
});
