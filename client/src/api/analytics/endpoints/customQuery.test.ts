import { afterEach, expect, it, vi } from "vitest";
import { analyzeQuery } from "./customQuery";

afterEach(() => vi.unstubAllGlobals());

it("reads split SSE updates and only resolves after completion", async () => {
  const bytes = new TextEncoder().encode(
    'data: {"type":"result","query":"SELECT count() FROM scoped_events","rows":[{"count":4}],"rowCount":1}\n\n' +
      'data: {"type":"delta","text":"Four "}\n\ndata: {"type":"delta","text":"visits"}\n\ndata: {"type":"done","conversationId":"saved-1"}\n\n'
  );
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(
      new ReadableStream({
        start(controller) {
          for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
          controller.close();
        },
      })
    )
  );
  vi.stubGlobal("fetch", fetchMock);
  const onProgress = vi.fn();
  const result = await analyzeQuery(
    "org-1",
    { query: "SELECT count() FROM scoped_events", question: "Visits?", siteId: 42, conversationId: "prior-1" },
    new AbortController().signal,
    onProgress
  );

  expect(result.summary).toBe("Four visits");
  expect(result.conversationId).toBe("saved-1");
  expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ summary: "Four " }));
  expect(fetchMock.mock.calls[0][1].credentials).toBe("include");
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).conversationId).toBe("prior-1");
});

it("rejects an interrupted stream instead of presenting a partial answer", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response('data: {"type":"result","query":"SELECT 1","rows":[],"rowCount":0}\n\n'))
  );
  await expect(
    analyzeQuery("org-1", { query: "SELECT 1", question: "Why?", siteId: 42 }, new AbortController().signal, vi.fn())
  ).rejects.toThrow("ended before");
});
