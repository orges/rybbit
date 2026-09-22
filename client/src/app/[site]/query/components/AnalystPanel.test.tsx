import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), remove: vi.fn(), generate: vi.fn(), analyze: vi.fn() }));
vi.mock("next-intl", () => ({
  useExtracted: () => (value: string, params?: Record<string, string>) =>
    value.replace(/\{(\w+)\}/g, (_, key: string) => params?.[key] ?? `{${key}}`),
}));
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
      summary: "[display:none]\nSaved **answer**",
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

it("renders model-authored Markdown and follows incoming messages until the reader scrolls away", async () => {
  mocks.list.mockResolvedValue([{ id: "saved-1", title: "Errors", updatedAt: "2026-09-22" }]);
  let resolveMessages!: (value: unknown[]) => void;
  mocks.get.mockReturnValue(
    new Promise(resolve => {
      resolveMessages = resolve;
    })
  );
  render(<AnalystPanel organizationId="org-1" siteId={42} />);
  const pane = screen.getByTestId("analyst-messages");
  Object.defineProperty(pane, "scrollHeight", { configurable: true, value: 600 });
  Object.defineProperty(pane, "clientHeight", { configurable: true, value: 200 });
  await waitFor(() => expect(mocks.get).toHaveBeenCalledOnce());
  resolveMessages([
    {
      question: "List errors",
      query: "SELECT name, count() FROM scoped_events GROUP BY name",
      summary: "[display:none]\n| Error | Occurrences |\n| --- | ---: |\n| Load failed | 22 |",
      rows: [{ name: "Load failed", occurrences: 22 }],
      rowCount: 1,
    },
  ]);
  expect(await screen.findByRole("cell", { name: "Load failed" })).toBeTruthy();
  expect(screen.getAllByRole("cell", { name: "Load failed" })).toHaveLength(1);
  await waitFor(() => expect(pane.scrollTop).toBe(600));

  mocks.generate.mockResolvedValue({ query: "SELECT count() FROM scoped_events" });
  let update!: (result: { query: string; summary: string; rows: []; rowCount: number }) => void;
  let finish!: (result: { query: string; summary: string; rows: []; rowCount: number }) => void;
  mocks.analyze.mockImplementation((_org, _request, _signal, onProgress) => {
    update = onProgress;
    onProgress({ query: "SELECT count() FROM scoped_events", summary: "[display:none]\nDone", rows: [], rowCount: 0 });
    return new Promise(resolve => {
      finish = resolve;
    });
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Ask about your analytics" }), {
    target: { value: "Follow-up" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send question" }));
  await screen.findByText("Done");
  expect(pane.scrollTop).toBe(600);

  fireEvent.scroll(pane, { target: { scrollTop: 0 } });
  update({
    query: "SELECT count() FROM scoped_events",
    summary: "[display:none]\nMore details",
    rows: [],
    rowCount: 0,
  });
  expect(await screen.findByText("More details")).toBeTruthy();
  expect(pane.scrollTop).toBe(0);
  finish({
    query: "SELECT count() FROM scoped_events",
    summary: "[display:none]\nMore details",
    rows: [],
    rowCount: 0,
  });
});

it("renders only the rows the table tool selected from a truncated preview", async () => {
  mocks.list.mockResolvedValue([{ id: "saved-1", title: "Pagination", updatedAt: "2026-09-22" }]);
  mocks.get.mockResolvedValue([
    {
      question: "gimme a table with where the pagination happened",
      query: "SELECT pathname, count() FROM scoped_events GROUP BY pathname",
      summary:
        '<!--rybbit-artifact:{"type":"table","title":"Top pagination","columns":["Path","Visits"],"rows":[["/search?page=1","1"]]}-->\nOnly 50 of 162 rows were available.',
      rows: Array.from({ length: 50 }, (_, index) => ({ pathname: `/search?page=${index + 1}`, visits: index + 1 })),
      rowCount: 162,
    },
  ]);
  render(<AnalystPanel organizationId="org-1" siteId={42} />);
  expect(await screen.findByRole("cell", { name: "/search?page=1" })).toBeTruthy();
  expect(screen.getAllByRole("row")).toHaveLength(2);
  expect(screen.queryByText("/search?page=50")).toBeNull();
  expect(screen.getByText("Only 50 of 162 rows were available.")).toBeTruthy();
});

it("renders saved tool results and lets a follow-up choice fill the composer", async () => {
  mocks.list.mockResolvedValue([{ id: "saved-1", title: "Visits", updatedAt: "2026-09-22" }]);
  mocks.get.mockResolvedValue([
    {
      question: "Which pages?",
      query: "SELECT count() FROM scoped_events",
      summary:
        '<!--rybbit-artifact:{"type":"form","question":"Which period?","options":["Last week","Last month"]}-->\nChoose a period.',
      rows: [],
      rowCount: 0,
    },
  ]);
  render(<AnalystPanel organizationId="org-1" siteId={42} />);
  fireEvent.click(await screen.findByRole("button", { name: "Last week" }));
  expect((screen.getByRole("textbox", { name: "Ask about your analytics" }) as HTMLTextAreaElement).value).toBe(
    "Last week"
  );
  expect(screen.getByText("Choose a period.")).toBeTruthy();
});
