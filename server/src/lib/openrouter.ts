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
    };
    finish_reason?: string | null;
    native_finish_reason?: string | null;
  }>;
  usage?: unknown;
  error?: unknown;
}

type OpenRouterStreamEvent = {
  choices?: Array<{ delta?: { content?: string | null } }>;
  error?: { message?: string };
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
  usage?: unknown;
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
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  options?: OpenRouterOptions,
  stream = false
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
      ...(process.env.OPENROUTER_REASONING_EFFORT
        ? { reasoning_effort: process.env.OPENROUTER_REASONING_EFFORT }
        : {}),
      ...(stream ? { stream: true } : {}),
    }),
    signal: options?.signal,
  });
  return { response, model };
}

export async function* streamOpenRouter(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  options?: OpenRouterOptions
): AsyncGenerator<string> {
  const { response, model } = await requestOpenRouter(messages, options, true);
  if (!response.ok) {
    throw new OpenRouterError("http_error", `OpenRouter API error: ${response.status}`, {
      model,
      status: response.status,
    });
  }
  if (!response.body) throw new OpenRouterError("empty_content", "OpenRouter returned an empty stream", { model });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  let done = false;
  let length = 0;
  try {
    while (!done) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
        if (line !== "" || !dataLines.length) continue;
        const payload = dataLines.join("\n");
        dataLines = [];
        if (payload.length > 65536)
          throw new OpenRouterError("http_error", "OpenRouter stream event is too large", { model });
        if (payload === "[DONE]") {
          done = true;
          break;
        }
        let event: OpenRouterStreamEvent;
        try {
          event = JSON.parse(payload) as OpenRouterStreamEvent;
        } catch {
          throw new OpenRouterError("invalid_json", "OpenRouter returned an invalid stream event", { model });
        }
        if (event.error) throw new OpenRouterError("http_error", "OpenRouter stream failed", { model });
        const text = event.choices?.[0]?.delta?.content;
        if (typeof text === "string") {
          length += text.length;
          if (length > 20000)
            throw new OpenRouterError("http_error", "OpenRouter stream exceeded the response limit", { model });
          yield text;
        }
      }
      if (buffer.length > 65536 || dataLines.join("\n").length > 65536)
        throw new OpenRouterError("http_error", "OpenRouter stream event is too large", { model });
      if (chunk.done) break;
    }
    if (!done || !length) throw new OpenRouterError("empty_content", "OpenRouter stream ended early", { model });
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
