import { afterEach, describe, expect, it, vi } from "vitest";
import { callOpenRouter, streamOpenRouter } from "./openrouter.js";

function mockOpenRouterResponse(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => body,
    })
  );
}

describe("callOpenRouter", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns assistant content", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    mockOpenRouterResponse({
      id: "completion-id",
      choices: [
        {
          message: { role: "assistant", content: "SELECT count() FROM scoped_events" },
          finish_reason: "stop",
        },
      ],
    });

    await expect(callOpenRouter([{ role: "user", content: "count events" }])).resolves.toBe(
      "SELECT count() FROM scoped_events"
    );
  });

  it("rejects null assistant content", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    mockOpenRouterResponse({
      id: "completion-id",
      choices: [
        {
          message: { role: "assistant", content: null },
          finish_reason: "stop",
        },
      ],
    });

    await expect(callOpenRouter([{ role: "user", content: "count events" }])).rejects.toThrow(
      "OpenRouter returned an empty response"
    );
  });
});

describe("streamOpenRouter", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("reassembles split SSE and UTF-8 chunks and requests streaming", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    const bytes = new TextEncoder().encode(
      'data: {"choices":[{"delta":{"content":"Hi 🌍"}}]}\r\n\r\ndata: [DONE]\r\n\r\n'
    );
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
            controller.close();
          },
        })
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const tokens = [];
    for await (const token of streamOpenRouter([{ role: "user", content: "hello" }])) tokens.push(token);
    expect(tokens).toEqual(["Hi 🌍"]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).stream).toBe(true);
  });

  it("rejects streams that end without a completion marker", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'))
    );
    const consume = async () => {
      for await (const _ of streamOpenRouter([{ role: "user", content: "hello" }])) {
        /* consume */
      }
    };
    await expect(consume()).rejects.toThrow("ended early");
  });
});
