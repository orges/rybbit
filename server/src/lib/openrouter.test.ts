import { afterEach, describe, expect, it, vi } from "vitest";
import { callOpenRouter, getModelChain, streamChat, type ChatStreamEvent } from "./openrouter.js";

function mockOpenRouterResponse(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => body,
    })
  );
}

/** Feeds `chunks` to the caller one byte at a time, the way a proxy really streams. */
function mockSseStream(chunks: string[]) {
  const bytes = new TextEncoder().encode(chunks.join(""));
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
  return fetchMock;
}

const sse = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

async function collect(stream: AsyncGenerator<ChatStreamEvent>) {
  const events: ChatStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
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

  it("uses the configured proxy URL and reasoning effort", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.stubEnv("OPENROUTER_API_URL", "http://10.10.10.55:8317/v1/chat/completions");
    vi.stubEnv("OPENROUTER_REASONING_EFFORT", "medium");
    mockOpenRouterResponse({ choices: [{ message: { content: "ok" } }] });

    await callOpenRouter([{ role: "user", content: "hello" }]);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("http://10.10.10.55:8317/v1/chat/completions");
    expect(JSON.parse(String(init?.body)).reasoning_effort).toBe("medium");
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

describe("getModelChain", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("puts the configured model first and de-duplicates the fallbacks", () => {
    vi.stubEnv("OPENROUTER_MODEL", "gpt-6-luna");
    vi.stubEnv("OPENROUTER_FALLBACK_MODELS", "qwen-3.6, gpt-6-luna ,qwen-3.6");
    expect(getModelChain()).toEqual(["gpt-6-luna", "qwen-3.6"]);
  });
});

describe("streamChat", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("reassembles split SSE and UTF-8 chunks and requests streaming", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    const fetchMock = mockSseStream([sse({ choices: [{ delta: { content: "Hi " } }] }), sse({ choices: [{ delta: { content: "🌍" } }] }), "data: [DONE]\n\n"]);

    const events = await collect(streamChat({ messages: [{ role: "user", content: "hello" }] }));
    expect(events.filter(event => event.type === "text").map(event => (event as { text: string }).text)).toEqual(["Hi ", "🌍"]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).stream).toBe(true);
  });

  it("surfaces reasoning and assembles tool calls split across chunks", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    const fetchMock = mockSseStream([
      sse({ choices: [{ delta: { reasoning: "checking " } }] }),
      sse({ choices: [{ delta: { reasoning: "the data" } }] }),
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "get_overview" } }] } }] }),
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"compare":' } }] } }] }),
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "true}" } }] } }] }),
      sse({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 12, completion_tokens: 7 } }),
      "data: [DONE]\n\n",
    ]);

    const events = await collect(streamChat({ messages: [{ role: "user", content: "how is traffic?" }], tools: [] }));
    expect(events.filter(event => event.type === "reasoning").map(event => (event as { text: string }).text).join("")).toBe(
      "checking the data"
    );
    const toolCalls = events.find(event => event.type === "tool_calls");
    expect(toolCalls).toMatchObject({
      calls: [{ id: "call_1", function: { name: "get_overview", arguments: '{"compare":true}' } }],
    });
    expect(events.find(event => event.type === "usage")).toMatchObject({ usage: { prompt_tokens: 12 } });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).tools).toEqual([]);
  });

  it("falls back to the next model when the first is in cooldown", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.stubEnv("OPENROUTER_MODEL", "gpt-6-luna");
    vi.stubEnv("OPENROUTER_FALLBACK_MODELS", "qwen-3.6");
    const ok = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sse({ choices: [{ delta: { content: "answered" } }] })));
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        },
      })
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: "model_cooldown", message: "usage limit reached" } }), {
          status: 429,
        })
      )
      .mockResolvedValueOnce(ok);
    vi.stubGlobal("fetch", fetchMock);

    const events = await collect(streamChat({ messages: [{ role: "user", content: "hi" }] }));
    expect(events.some(event => event.type === "text")).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).model).toBe("qwen-3.6");
  });

  it("does not fall back for a request the provider rejected outright", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.stubEnv("OPENROUTER_FALLBACK_MODELS", "qwen-3.6");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(collect(streamChat({ messages: [{ role: "user", content: "hi" }] }))).rejects.toThrow(
      "Provider API error: 400"
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects streams that end before it finished", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(sse({ choices: [{ delta: { content: "partial" } }] }))));

    await expect(collect(streamChat({ messages: [{ role: "user", content: "hello" }] }))).rejects.toThrow(
      "before it finished"
    );
  });
});
