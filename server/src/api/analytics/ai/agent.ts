import {
  getModelChain,
  OpenRouterError,
  streamChat,
  type OpenRouterMessage,
  type OpenRouterToolCall,
  type OpenRouterUsage,
} from "../../../lib/openrouter.js";
import { buildSystemPrompt, toolSchemas, type AnalystContext } from "./prompt.js";
import { ALL_TOOLS, ResultStore, type Artifact } from "./presentation.js";
import { toolFailure, type AnalystTool, type ToolContext, type ToolProposal } from "./tools.js";
import { unsupportedFigures } from "./verify.js";

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
  | { type: "text_discard"; chars: number }
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | { type: "tool_end"; id: string; name: string; ok: boolean; summary: string; durationMs: number; artifact?: Artifact }
  | { type: "artifact"; artifact: Artifact }
  | { type: "usage"; usage: OpenRouterUsage; model: string }
  | { type: "title"; title: string }
  | { type: "user_message_id"; messageId: string }
  | { type: "unverified"; figures: string[] }
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
  /** Figures in the answer that no tool result contained. */
  unverified: string[];
  /** Set when a tool proposed something for a person to save. */
  proposal?: ToolProposal;
  error?: string;
}

export interface RunAgentOptions {
  history: OpenRouterMessage[];
  question: string;
  context: AnalystContext;
  toolContext: Omit<ToolContext, "results">;
  emit: (event: AgentEvent) => void;
  signal: AbortSignal;
  /**
   * The tools this run may call. Defaults to everything; a proposal run narrows
   * it, so a page copilot can be handed a tool the chat has no use for.
   */
  tools?: Map<string, AnalystTool>;
}

export async function runAgent(options: RunAgentOptions): Promise<AgentResult> {
  const { emit, signal, toolContext, context } = options;
  const tools = options.tools ?? ALL_TOOLS;
  const results = new ResultStore();
  const toolContextWithStore: ToolContext = { ...toolContext, results };
  const messages: OpenRouterMessage[] = [
    { role: "system", content: context.systemPrompt ?? buildSystemPrompt(context) },
    ...options.history,
    { role: "user", content: options.question },
  ];

  const callCache = new Map<string, ToolCallRecord>();

  const result: AgentResult = {
    text: "",
    reasoning: "",
    toolCalls: [],
    artifacts: [],
    usage: {},
    model: getModelChain()[0],
    steps: 0,
    stopped: false,
    unverified: [],
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
        // Derived from the same map the run may call, so a proposal run is never
        // told to call a tool it was not offered.
        tools: toolSchemas(tools),
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
    if (calls.length && stepText) {
      // A model that writes the answer and calls a tool in the same step writes
      // the answer again once the tool result is in. The step is not over until
      // its text has streamed, so the reader is told to drop it.
      result.text = result.text.slice(0, result.text.length - stepText.length);
      emit({ type: "text_discard", chars: stepText.length });
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
      const record: ToolCallRecord = { id: call.id, name, input: args, output: "", ok: true, durationMs: 0 };
      // Models re-issue the same call — the same statement after a failed chart,
      // the same suggestion twice. Replaying the first answer keeps the turn
      // short and stops the loop.
      const cacheKey = `${name}:${JSON.stringify(args)}`;
      const cached = callCache.get(cacheKey);
      // A replay is already in the trail, and one model that repeats itself five
      // times should not scroll the reader past five identical rows.
      if (!cached) emit({ type: "tool_start", id: call.id, name, input: args });
      const tool = cached ? undefined : tools.get(name);
      if (cached) {
        record.ok = cached.ok;
        record.output = `${cached.output}\n(Reused: this exact call already ran in this turn.)`;
      } else if (!tool) {
        record.ok = false;
        record.output = `Unknown tool "${name}". Available tools: ${[...tools.keys()].join(", ")}`;
      } else {
        try {
          const output = await tool.run(args, toolContextWithStore);
          const stored = results.add(output.rows, tool.name, {
            ...(name === "run_sql" ? { sql: String(args.sql ?? "") } : {}),
            input: args,
            ...(output.range ? { range: output.range } : {}),
          });
          // The column names travel with every result. Without them the model
          // guesses ("date" where the column is "time") and the presentation tool
          // it calls next fails on a name it could have read.
          const columns = stored ? Object.keys(stored.rows[0] ?? {}) : [];
          record.output = stored
            ? JSON.stringify({ result_id: stored.id, columns, ...safeParse(output.text) })
            : output.text;
          if (output.artifact) {
            record.artifact = output.artifact;
            // Models repeat themselves; the same chart twice is a scroll of
            // duplicated weight for the reader, not more information.
            if (!result.artifacts.some(artifact => isSameArtifact(artifact, output.artifact!))) {
              result.artifacts.push(output.artifact);
              emit({ type: "artifact", artifact: output.artifact });
            }
          }
          // A proposal wins over any later one: the first thing the model
          // settled on is the one the person is being asked to look at.
          if (output.proposal && !result.proposal) result.proposal = output.proposal;
        } catch (error) {
          record.ok = false;
          record.output = toolFailure(name, error);
        }
      }
      if (!cached && record.ok) callCache.set(cacheKey, record);
      record.durationMs = Date.now() - started;
      // A replayed call is already in the trail; it is not streamed again.
      if (!cached) {
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
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: record.output });
    }

    compactToolOutputs(messages);
    if (step === MAX_STEPS) {
      result.text += `\n\n_Stopped after ${MAX_STEPS} steps without a final answer. Rephrase the question to get a focused answer._`;
    }
  }

  // The answer is only as trustworthy as the numbers in it. Anything that does
  // not appear in a tool result is surfaced rather than passed off as data —
  // but the model's context is wider than this turn: quoting a figure from an
  // earlier answer, or the one the user just asked about, is fair game, and
  // flagging those would teach the reader to ignore the flag.
  const inContext = [
    ...result.toolCalls.map(record => record.output),
    ...options.history.filter(message => message.role === "assistant").map(message => String(message.content ?? "")),
    options.question,
  ];
  result.unverified = unsupportedFigures(result.text, inContext);
  if (result.unverified.length) emit({ type: "unverified", figures: result.unverified });

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

/** One line per tool for the activity trail: scalars first, counts for the rest. */
function summarize(record: ToolCallRecord) {
  if (!record.ok) return truncate(record.output, 160);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(record.output) as Record<string, unknown>;
  } catch {
    return truncate(record.output, 120);
  }
  const parts: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    // result_id and follow_ups are for the model, not the reader: the first is
    // plumbing, the second is the whole payload of a list the reader can see.
    if (key === "result_id" || key === "follow_ups" || value == null) continue;
    if (typeof value === "number" || typeof value === "boolean") parts.push(`${key}: ${value}`);
    else if (typeof value === "string" && value.length <= 48) parts.push(`${key}: ${value}`);
    else if (Array.isArray(value)) {
      if (value.every(entry => typeof entry !== "object")) parts.push(`${key}: ${truncate(value.map(String).join(", "), 48)}`);
      else parts.push(`${key}: ${value.length}`);
    }
    if (parts.length >= 3) break;
  }
  return parts.join(" · ") || "done";
}

const truncate = (value: string, max = 120) => (value.length > max ? `${value.slice(0, max)}…` : value);

function isSameArtifact(left: Artifact, right: Artifact) {
  return JSON.stringify(left) === JSON.stringify(right);
}

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
