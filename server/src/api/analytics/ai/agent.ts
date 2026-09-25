import {
  getModelChain,
  OpenRouterError,
  streamChat,
  type OpenRouterMessage,
  type OpenRouterToolCall,
  type OpenRouterUsage,
} from "../../../lib/openrouter.js";
import { ANALYST_TOOL_SCHEMAS, buildSystemPrompt, type AnalystContext } from "./prompt.js";
import { ResultStore, type Artifact } from "./presentation.js";
import { ANALYST_TOOL_MAP, toolFailure, type ToolContext } from "./tools.js";

/**
 * The analyst's tool loop.
 *
 * One user message becomes a bounded sequence of model calls: stream, run the
 * tools the model asked for, feed the results back, repeat until it answers in
 * prose or runs out of steps. Bounded because an agent loop with an LLM in it
 * will otherwise happily spend a hundred tool calls on one question; the browser
 * can stop it at any time and whatever was already produced is kept.
 */

const MAX_STEPS = 12;
const MAX_TOOL_OUTPUT_CHARS = 24_000;
const MAX_REASONING_CHARS = 4_000;
const CONTEXT_BUDGET_CHARS = 120_000;
export type AgentEvent =
  | { type: "reasoning_delta"; text: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | { type: "tool_end"; id: string; name: string; ok: boolean; summary: string; durationMs: number; artifact?: Artifact }
  | { type: "artifact"; artifact: Artifact }
  | { type: "usage"; usage: OpenRouterUsage; model: string }
  | { type: "title"; title: string }
  | { type: "message_id"; messageId: string }
  | { type: "done"; stopped: boolean; steps: number }
  | { type: "error"; message: string; retryable: boolean };

export interface ToolCallRecord {
  id: string;
  name: string;
  input: unknown;
  output: string;
  ok: boolean;
  durationMs: number;
  artifact?: Artifact;
}

export interface AgentResult {
  text: string;
  reasoning: string;
  toolCalls: ToolCallRecord[];
  artifacts: Artifact[];
  usage: OpenRouterUsage;
  model: string;
  steps: number;
  stopped: boolean;
  error?: string;
}

export interface RunAgentOptions {
  history: OpenRouterMessage[];
  question: string;
  context: AnalystContext;
  toolContext: Omit<ToolContext, "results">;
  emit: (event: AgentEvent) => void;
  signal: AbortSignal;
}

export async function runAgent(options: RunAgentOptions): Promise<AgentResult> {
  const { emit, signal, toolContext, context } = options;
  const results = new ResultStore();
  const toolContextWithStore: ToolContext = { ...toolContext, results };
  const messages: OpenRouterMessage[] = [
    { role: "system", content: buildSystemPrompt(context) },
    ...options.history,
    { role: "user", content: options.question },
  ];

  const result: AgentResult = {
    text: "",
    reasoning: "",
    toolCalls: [],
    artifacts: [],
    usage: {},
    model: getModelChain()[0],
    steps: 0,
    stopped: false,
  };

  for (let step = 1; step <= MAX_STEPS; step++) {
    if (signal.aborted) {
      result.stopped = true;
      break;
    }
    result.steps = step;
    let stepText = "";
    let stepReasoning = "";
    let calls: OpenRouterToolCall[] = [];
    let stepUsage: OpenRouterUsage | undefined;

    // A provider that dies mid-sentence leaves a usable partial answer and a
    // failed run. Keeping the text and reporting the failure beats discarding
    // the whole turn and answering "something went wrong".
    try {
      for await (const event of streamChat({
        messages,
        tools: ANALYST_TOOL_SCHEMAS,
        maxTokens: 4_000,
        temperature: 0.2,
        signal,
      })) {
        if (signal.aborted) {
          result.stopped = true;
          break;
        }
        if (event.type === "reasoning") {
          if (stepReasoning.length < MAX_REASONING_CHARS) {
            stepReasoning += event.text;
            emit({ type: "reasoning_delta", text: event.text });
          }
        } else if (event.type === "text") {
          stepText += event.text;
          result.text += event.text;
          emit({ type: "text_delta", text: event.text });
        } else if (event.type === "tool_calls") {
          calls = event.calls;
        } else if (event.type === "usage") {
          stepUsage = event.usage;
        }
      }
    } catch (error) {
      if (signal.aborted) {
        result.stopped = true;
      } else {
        result.error = error instanceof Error ? error.message : "The provider stream failed";
        result.stopped = true;
      }
    }
    if (stepUsage) {
      result.usage = addUsage(result.usage, stepUsage);
      emit({ type: "usage", usage: result.usage, model: result.model });
    }
    if (signal.aborted) {
      result.stopped = true;
      break;
    }
    if (!calls.length) break;

    messages.push({ role: "assistant", content: stepText || null, tool_calls: calls });

    for (const call of calls) {
      const started = Date.now();
      const name = call.function.name;
      const args = parseArguments(call.function.arguments);
      emit({ type: "tool_start", id: call.id, name, input: args });
      const record: ToolCallRecord = { id: call.id, name, input: args, output: "", ok: true, durationMs: 0 };
      const tool = ANALYST_TOOL_MAP.get(name);
      if (!tool) {
        record.ok = false;
        record.output = `Unknown tool "${name}". Available tools: ${[...ANALYST_TOOL_MAP.keys()].join(", ")}`;
      } else {
        try {
          const output = await tool.run(args, toolContextWithStore);
          const stored = results.add(output.rows, tool.name, name === "run_sql" ? String(args.sql ?? "") : undefined);
          record.output = stored ? JSON.stringify({ result_id: stored.id, ...safeParse(output.text) }) : output.text;
          if (output.artifact) {
            record.artifact = output.artifact;
            result.artifacts.push(output.artifact);
            emit({ type: "artifact", artifact: output.artifact });
          }
        } catch (error) {
          record.ok = false;
          record.output = toolFailure(name, error);
        }
      }
      record.durationMs = Date.now() - started;
      result.toolCalls.push(record);
      emit({
        type: "tool_end",
        id: record.id,
        name,
        ok: record.ok,
        summary: summarize(record),
        durationMs: record.durationMs,
        ...(record.artifact ? { artifact: record.artifact } : {}),
      });
      messages.push({ role: "tool", tool_call_id: call.id, content: record.output });
    }

    compactToolOutputs(messages);
    if (step === MAX_STEPS) {
      result.text += `\n\n_Stopped after ${MAX_STEPS} steps without a final answer. Rephrase the question to get a focused answer._`;
    }
  }

  emit({ type: "done", stopped: result.stopped, steps: result.steps });
  return result;
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function safeParse(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { summary: text };
  } catch {
    return { summary: text };
  }
}

function summarize(record: ToolCallRecord) {
  if (!record.ok) return record.output.slice(0, 200);
  const text = record.output.slice(0, 400);
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const { result_id, ...rest } = parsed;
    const detail = Object.entries(rest)
      .filter(([, value]) => value !== undefined && !(Array.isArray(value) && value.length === 0))
      .slice(0, 3)
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? `${value.length} rows` : truncate(String(value))}`)
      .join(", ");
    return `${result_id ? `${result_id} · ` : ""}${detail || "ok"}`;
  } catch {
    return truncate(text);
  }
}

const truncate = (value: string, max = 120) => (value.length > max ? `${value.slice(0, max)}…` : value);

function addUsage(total: OpenRouterUsage, next: OpenRouterUsage): OpenRouterUsage {
  return {
    prompt_tokens: (total.prompt_tokens ?? 0) + (next.prompt_tokens ?? 0),
    completion_tokens: (total.completion_tokens ?? 0) + (next.completion_tokens ?? 0),
    total_tokens: (total.total_tokens ?? 0) + (next.total_tokens ?? 0),
    completion_tokens_details: {
      reasoning_tokens:
        (total.completion_tokens_details?.reasoning_tokens ?? 0) +
        (next.completion_tokens_details?.reasoning_tokens ?? 0),
    },
  };
}

/**
 * Keeps the transcript inside a context budget by emptying the oldest tool
 * results first. The messages stay in place — an API transcript with a missing
 * turn is a 400 — so only their content shrinks, and each one leaves a note
 * saying how to get it back.
 */
function compactToolOutputs(messages: OpenRouterMessage[]) {
  const total = () => messages.reduce((sum, message) => sum + (message.content?.length ?? 0), 0);
  if (total() <= CONTEXT_BUDGET_CHARS) return;
  for (const message of messages) {
    if (message.role !== "tool") continue;
    if ((message.content?.length ?? 0) < MAX_TOOL_OUTPUT_CHARS) continue;
    message.content = "[earlier tool result dropped to save context — call the tool again if you need it]";
    if (total() <= CONTEXT_BUDGET_CHARS) return;
  }
}

export function isRetryableAgentError(error: unknown) {
  return error instanceof OpenRouterError && ["http_error", "empty_content", "empty_choices"].includes(error.code);
}
