const MAX_STREAM_EVENT_BYTES = 65_536;
const MAX_REASONING_CHARS = 8_000;

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_OPENROUTER_MODEL = "moonshotai/kimi-k2.6";

interface OpenRouterResponse {
  id?: string;
  model?: string;
  provider?: string;
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
    };
    finish_reason?: string | null;
    native_finish_reason?: string | null;
  }>;
  usage?: OpenRouterUsage;
  error?: unknown;
}

type OpenRouterStreamEvent = {
  choices?: Array<{
    delta?: {
      content?: string | null;
      // Reasoning models stream their scratchpad under one of these names depending
      // on the upstream. Both are surfaced to the chat so a long thinking step is
      // visible instead of looking like a stall.
      reasoning?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: "function";
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: OpenRouterUsage;
  error?: { message?: string; code?: string };
};

export type OpenRouterUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
};

export type OpenRouterErrorCode = "missing_api_key" | "http_error" | "invalid_json" | "empty_choices" | "empty_content";

export type OpenRouterMetadata = {
  model: string;
  responseModel?: string;
  responseId?: string;
  requestId?: string;
  provider?: string;
  status?: number;
  statusText?: string;
  choiceCount?: number;
  finishReason?: string | null;
  nativeFinishReason?: string | null;
  usage?: OpenRouterUsage;
  responseError?: unknown;
  responseBodyPreview?: string;
  contentType?: string;
  contentLength?: number;
  messageRole?: string;
  messageContentType?: string;
  messageContentLength?: number;
};

type OpenRouterOptions = {
  temperature?: number;
  maxTokens?: number;
  model?: string;
  signal?: AbortSignal;
};

export type OpenRouterMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
};

export type OpenRouterTool = {
  type: "function";
  function: { name: string; description: string; parameters: object };
};

export type OpenRouterToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

/** One step of a streamed chat completion. The agent loop consumes these. */
export type ChatStreamEvent =
  | { type: "reasoning"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_calls"; calls: OpenRouterToolCall[] }
  | { type: "usage"; usage: OpenRouterUsage }
  | { type: "done"; finishReason: string | null };

export class OpenRouterError extends Error {
  code: OpenRouterErrorCode;
  details: OpenRouterMetadata;

  constructor(code: OpenRouterErrorCode, message: string, details: OpenRouterMetadata) {
    super(message);
    this.name = "OpenRouterError";
    this.code = code;
    this.details = details;
  }
}

function truncateForLog(value: string, maxLength = 1000) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function getResponseHeader(response: Response, header: string) {
  return (response as Response & { headers?: { get?: (name: string) => string | null } }).headers?.get?.(header);
}

export function getOpenRouterModel(model?: string) {
  return model || process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL;
}

export async function callOpenRouter(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  options?: OpenRouterOptions
): Promise<string> {
  const response = await callOpenRouterWithMetadata(messages, options);
  return response.content;
}

export async function callOpenRouterWithMetadata(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  options?: OpenRouterOptions
): Promise<{ content: string; metadata: OpenRouterMetadata }> {
  const { response, model } = await requestOpenRouter(messages, options);
  const baseMetadata: OpenRouterMetadata = {
    model,
    status: response.status,
    statusText: response.statusText,
    requestId:
      getResponseHeader(response, "x-request-id") ??
      getResponseHeader(response, "x-openrouter-request-id") ??
      getResponseHeader(response, "cf-ray") ??
      undefined,
    contentType: getResponseHeader(response, "content-type") ?? undefined,
    contentLength: Number(getResponseHeader(response, "content-length")) || undefined,
  };

  if (!response.ok) {
    const responseBody = await response.text().catch(() => "");
    throw new OpenRouterError("http_error", `OpenRouter API error: ${response.status}`, {
      ...baseMetadata,
      responseBodyPreview: truncateForLog(responseBody),
    });
  }

  let data: OpenRouterResponse;
  try {
    data = (await response.json()) as OpenRouterResponse;
  } catch (error) {
    throw new OpenRouterError("invalid_json", "OpenRouter returned invalid JSON", {
      ...baseMetadata,
      responseError: error instanceof Error ? error.message : String(error),
    });
  }

  if (!data.choices || data.choices.length === 0) {
    throw new OpenRouterError("empty_choices", "No response from OpenRouter", {
      ...baseMetadata,
      responseId: data.id,
      responseModel: data.model,
      provider: data.provider,
      choiceCount: data.choices?.length ?? 0,
      usage: data.usage,
      responseError: data.error,
    });
  }

  const choice = data.choices[0];
  const content = choice.message?.content;
  const metadata: OpenRouterMetadata = {
    ...baseMetadata,
    responseId: data.id,
    responseModel: data.model,
    provider: data.provider,
    choiceCount: data.choices.length,
    finishReason: choice.finish_reason,
    nativeFinishReason: choice.native_finish_reason,
    usage: data.usage,
    responseError: data.error,
    messageRole: choice.message?.role,
    messageContentType: Array.isArray(content) ? "array" : typeof content,
    messageContentLength: typeof content === "string" ? content.length : undefined,
  };

  if (typeof content !== "string" || content.trim().length === 0) {
    throw new OpenRouterError(
      "empty_content",
      `OpenRouter returned an empty response${choice.finish_reason ? ` (${choice.finish_reason})` : ""}`,
      metadata
    );
  }

  return { content, metadata };
}

async function requestOpenRouter(
  messages: OpenRouterMessage[],
  options?: OpenRouterOptions,
  stream = false,
  tools?: OpenRouterTool[]
) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = getOpenRouterModel(options?.model);
  if (!apiKey) throw new OpenRouterError("missing_api_key", "OPENROUTER_API_KEY is not configured", { model });
  const response = await fetch(process.env.OPENROUTER_API_URL || OPENROUTER_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://rybbit.com",
      "X-Title": "Rybbit Analytics",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: options?.temperature ?? 0.3,
      max_tokens: options?.maxTokens ?? 1000,
      ...(process.env.OPENROUTER_REASONING_EFFORT ? { reasoning_effort: process.env.OPENROUTER_REASONING_EFFORT } : {}),
      ...(stream ? { stream: true } : {}),
      ...(tools ? { tools, tool_choice: "auto" } : {}),
      ...(stream && tools ? { stream_options: { include_usage: true } } : {}),
    }),
    signal: options?.signal,
  });
  return { response, model };
}

/**
 * The model to try first, then the ordered fallbacks.
 *
 * A single-model deployment makes the whole chat hostage to one upstream quota:
 * Codex-style endpoints return `model_cooldown` for hours at a time when a plan
 * limit is hit, and 5xx from any provider takes a feature down. The chain turns
 * that into a slower answer instead of an error, and the models come from the
 * environment so no code change is needed to reorder them.
 */
export function getModelChain(preferred?: string) {
  const primary = getOpenRouterModel(preferred);
  const fallbacks = (process.env.OPENROUTER_FALLBACK_MODELS || "")
    .split(",")
    .map(model => model.trim())
    .filter(Boolean);
  return [...new Set([primary, ...fallbacks])];
}

/**
 * Upstream failures that another model in the chain can plausibly serve instead.
 * A 400 means the request itself is wrong, so retrying it elsewhere is pointless.
 */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_ERROR_CODES = new Set([
  "model_cooldown",
  "usage_limit_reached",
  "overloaded_error",
  "server_error",
  "rate_limit_exceeded",
  "service_unavailable",
]);

function isRetryableFailure(status: number, body: string) {
  if (RETRYABLE_STATUS.has(status)) return true;
  const lowered = body.toLowerCase();
  return [...RETRYABLE_ERROR_CODES].some(code => lowered.includes(code));
}

/** Splits an SSE byte stream into payloads, enforcing the per-event size cap. */
async function* readSsePayloads(response: Response, model: string): AsyncGenerator<string> {
  if (!response.body) throw new OpenRouterError("empty_content", "Provider returned an empty stream", { model });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      if (buffer.length > MAX_STREAM_EVENT_BYTES) {
        throw new OpenRouterError("http_error", "Provider stream event is too large", { model });
      }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
        if (line !== "" || !dataLines.length) continue;
        const payload = dataLines.join("\n");
        dataLines = [];
        if (payload.length > MAX_STREAM_EVENT_BYTES) {
          throw new OpenRouterError("http_error", "Provider stream event is too large", { model });
        }
        yield payload;
      }
      if (chunk.done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Accumulates streamed `tool_calls` deltas, which arrive split across chunks. */
class ToolCallAssembler {
  private readonly order: number[] = [];
  private readonly partials = new Map<number, { id: string; name: string; args: string }>();

  add(delta: NonNullable<NonNullable<OpenRouterStreamEvent["choices"]>[number]["delta"]>["tool_calls"]) {
    for (const call of delta ?? []) {
      const index = call.index ?? 0;
      if (!this.partials.has(index)) {
        this.order.push(index);
        this.partials.set(index, { id: call.id || `call_${index}`, name: "", args: "" });
      }
      const partial = this.partials.get(index)!;
      if (call.id) partial.id = call.id;
      if (call.function?.name) partial.name += call.function.name;
      if (call.function?.arguments) partial.args += call.function.arguments;
    }
  }

  calls(): OpenRouterToolCall[] {
    return this.order.map(index => {
      const partial = this.partials.get(index)!;
      return { id: partial.id, type: "function" as const, function: { name: partial.name, arguments: partial.args } };
    });
  }
}

export type StreamChatOptions = {
  messages: OpenRouterMessage[];
  tools?: OpenRouterTool[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
};

/**
 * One streamed chat completion, including any tool calls the model decides to
 * make. Text, reasoning, and tool-call arguments are all delivered incrementally
 * so the browser can render a step as it happens.
 *
 * The model chain is walked only for failures that arrive before any content —
 * once a model has emitted something, switching mid-answer would splice two
 * different answers together.
 */
export async function* streamChat(options: StreamChatOptions): AsyncGenerator<ChatStreamEvent> {
  const models = getModelChain(options.model);
  let lastError: unknown;
  for (const [position, model] of models.entries()) {
    let emitted = false;
    let retryable = true;
    try {
      const { response } = await requestOpenRouter(
        options.messages,
        { signal: options.signal, maxTokens: options.maxTokens, temperature: options.temperature, model },
        true,
        options.tools
      );
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        retryable = isRetryableFailure(response.status, body);
        throw new OpenRouterError("http_error", `Provider API error: ${response.status}`, {
          model,
          status: response.status,
          responseBodyPreview: truncateForLog(body),
        });
      }

      const assembler = new ToolCallAssembler();
      let reasoningLength = 0;
      let textLength = 0;
      let finishReason: string | null = null;
      let usage: OpenRouterUsage | undefined;
      let completed = false;
      for await (const payload of readSsePayloads(response, model)) {
        if (payload === "[DONE]") {
          completed = true;
          break;
        }
        let event: OpenRouterStreamEvent;
        try {
          event = JSON.parse(payload) as OpenRouterStreamEvent;
        } catch {
          throw new OpenRouterError("invalid_json", "Provider returned an invalid stream event", { model });
        }
        if (event.error) {
          throw new OpenRouterError("http_error", event.error.message || "Provider stream failed", {
            model,
            responseError: event.error,
          });
        }
        if (event.usage) usage = event.usage;
        const choice = event.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta;
        if (!delta) continue;
        if (delta.tool_calls?.length) {
          assembler.add(delta.tool_calls);
          emitted = true;
        }
        const reasoning = delta.reasoning ?? delta.reasoning_content;
        if (typeof reasoning === "string" && reasoning) {
          reasoningLength += reasoning.length;
          if (reasoningLength > MAX_REASONING_CHARS) continue;
          emitted = true;
          yield { type: "reasoning", text: reasoning };
        }
        if (typeof delta.content === "string" && delta.content) {
          textLength += delta.content.length;
          emitted = true;
          yield { type: "text", text: delta.content };
        }
      }
      // A stream that stops without its completion marker is truncated, and a
      // half-sent tool call is worse than no answer: the next step would run a
      // tool from arguments the model never finished writing.
      if (!completed && !finishReason) {
        throw new OpenRouterError("empty_content", "Provider stream ended before it finished", { model });
      }
      if (usage) yield { type: "usage", usage };
      const calls = assembler.calls();
      if (calls.length) yield { type: "tool_calls", calls };
      else if (!emitted && !textLength) {
        throw new OpenRouterError("empty_content", "Provider stream ended without a response", { model });
      }
      yield { type: "done", finishReason };
      return;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      lastError = error;
      if (!retryable || emitted || position === models.length - 1) throw error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new OpenRouterError("http_error", "Provider request failed", { model: models[0] });
}
