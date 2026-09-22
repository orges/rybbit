import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), remove: vi.fn(), generate: vi.fn(), analyze: vi.fn() }));
vi.mock("next-intl", () => ({ useExtracted: () => (value: string) => value }));
vi.mock("../../../../api/analytics/endpoints/customQuery", async importOriginal => ({
  ...(await importOriginal<typeof import("../../../../api/analytics/endpoints/customQuery")>()),
  listAiConversations: mocks.list,
  getAiConversation: mocks.get,
  generateCustomQuery: mocks.generate,
  analyzeQuery: mocks.analyze,
  deleteAiConversation: mocks.remove,
}));

import { AnalystPanel } from "./AnalystPanel";

afterEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

it("sends with Enter and keeps Shift+Enter for a newline", async () => {
  mocks.list.mockResolvedValue([]);
  mocks.generate.mockResolvedValue({ query: "SELECT count() FROM scoped_events" });
  mocks.analyze.mockResolvedValue({
    query: "SELECT count() FROM scoped_events",
    summary: "Done",
    rows: [],
    rowCount: 0,
  });
  render(<AnalystPanel organizationId="org-1" siteId={42} />);
  const input = await screen.findByRole("textbox", { name: "Ask about your analytics" });
  fireEvent.change(input, { target: { value: "How many visits?" } });
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  expect(mocks.generate).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(mocks.generate).toHaveBeenCalledOnce();
});

it("restores a saved conversation and can start a new one without deleting the old thread", async () => {
  mocks.list.mockResolvedValue([{ id: "saved-1", title: "Visits?", updatedAt: "2026-09-22" }]);
  mocks.get.mockResolvedValue([
    {
      question: "Visits?",
      query: "SELECT count() FROM scoped_events",
      summary: "[display:table]\nSaved **answer**",
      rows: [{ visits: 4 }],
      rowCount: 1,
    },
  ]);
  render(<AnalystPanel organizationId="org-1" siteId={42} />);
  expect(await screen.findByText("answer")).toBeTruthy();
  expect(screen.getByText("answer").tagName).toBe("STRONG");
  expect(mocks.get).toHaveBeenCalledWith("org-1", 42, "saved-1", expect.any(AbortSignal));
  expect(screen.getByRole("navigation", { name: "Conversation history" }).textContent).toContain("Visits?");

  vi.spyOn(window, "confirm").mockReturnValue(false);
  fireEvent.click(screen.getAllByRole("button", { name: "Delete conversation" })[0]);
  expect(mocks.remove).not.toHaveBeenCalled();
  vi.restoreAllMocks();

  fireEvent.click(screen.getByRole("button", { name: "New chat" }));
  expect(screen.queryByText("answer")).toBeNull();
  expect(screen.getByRole("option", { name: "Visits?" })).toBeTruthy();
});
