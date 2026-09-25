"use client";

import { useCallback, useRef, useState } from "react";
import {
  streamAnalystMessage,
  type ChatMessage,
  type ChatStreamEvent,
  type MessageContext,
  type SendMessageRequest,
  type ToolCallView,
} from "@/api/analyst/endpoints/analyst";

/**
 * One turn of the analyst, as the stream produces it.
 *
 * The reducer is deliberately the only place that mutates a message: SSE events
 * arrive out of order with respect to React state (text deltas, tool start/end,
 * artifacts, the final message id), and folding them in one place is what keeps
 * a partially streamed turn renderable and stoppable.
 */

const patchMessage = (messages: ChatMessage[], id: string, patch: (message: ChatMessage) => ChatMessage) =>
  messages.map(message => (message.id === id ? patch(message) : message));

const patchLastAssistant = (messages: ChatMessage[], patch: (message: ChatMessage) => ChatMessage) => {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "assistant") {
      const next = [...messages];
      next[index] = patch(messages[index]);
      return next;
    }
  }
  return messages;
};

export interface UseChatStreamOptions {
  organizationId: string;
  siteId: number;
  context: MessageContext;
  onConversation?: (conversationId: string, title?: string) => void;
}

export function useChatStream({ organizationId, siteId, context, onConversation }: UseChatStreamOptions) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const assistantIdRef = useRef<string>("");

  const send = useCallback(
    async (text: string, options?: { regenerate?: boolean }) => {
      const prompt = text.trim();
      if (!prompt || streaming) return;

      const userMessage: ChatMessage = {
        id: `local-user-${Date.now()}`,
        role: "user",
        content: prompt,
        context,
      };
      const assistantId = `local-assistant-${Date.now()}`;
      assistantIdRef.current = assistantId;
      const assistant: ChatMessage = { id: assistantId, role: "assistant", content: "", pending: true, toolCalls: [] };
      setMessages(current =>
        options?.regenerate && current.length > 1
          ? [...current.slice(0, current.length - 1), assistant]
          : [...current, userMessage, assistant]
      );
      setStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      const body: SendMessageRequest = {
        siteId,
        message: prompt,
        ...(conversationId ? { conversationId } : {}),
        ...(options?.regenerate ? { regenerate: true } : {}),
        context,
      };

      const onEvent = (event: ChatStreamEvent) => {
        switch (event.type) {
          case "conversation":
            setConversationId(event.conversationId);
            onConversation?.(event.conversationId);
            break;
          case "reasoning_delta":
            setMessages(current => patchMessage(current, assistantId, message => ({ ...message, reasoning: (message.reasoning ?? "") + event.text })));
            break;
          case "text_delta":
            setMessages(current => patchMessage(current, assistantId, message => ({ ...message, content: message.content + event.text })));
            break;
          case "text_discard":
            setMessages(current =>
              patchMessage(current, assistantId, message => ({ ...message, content: message.content.slice(0, -event.chars) }))
            );
            break;
          case "tool_start":
            setMessages(current =>
              patchMessage(current, assistantId, message => ({
                ...message,
                toolCalls: [
                  ...(message.toolCalls ?? []),
                  { id: event.id, name: event.name, input: event.input, ok: true, summary: "", durationMs: 0, status: "running" },
                ],
              }))
            );
            break;
          case "tool_end":
            setMessages(current =>
              patchMessage(current, assistantId, message => ({
                ...message,
                toolCalls: (message.toolCalls ?? []).map(call =>
                  call.id === event.id
                    ? { ...call, ok: event.ok, summary: event.summary, durationMs: event.durationMs, status: event.ok ? "done" : "error", ...(event.artifact ? { artifact: event.artifact } : {}) }
                    : call
                ),
                // Models re-issue the same call; the reader should see it once.
                ...(event.artifact && !message.artifacts?.some(artifact => JSON.stringify(artifact) === JSON.stringify(event.artifact))
                  ? { artifacts: [...(message.artifacts ?? []), event.artifact] }
                  : {}),
              }))
            );
            break;
          case "artifact":
            // Tool results already carry their artifact; a bare artifact event is
            // a duplicate.
            break;
          case "usage":
            setMessages(current => patchMessage(current, assistantId, message => ({ ...message, usage: event.usage })));
            break;
          case "title":
            onConversation?.(conversationId ?? "", event.title);
            break;
          case "message_id":
            assistantIdRef.current = event.messageId;
            setMessages(current => patchMessage(current, assistantId, message => ({ ...message, id: event.messageId })));
            break;
          case "done":
            setMessages(current => patchMessage(current, assistantId, message => ({ ...message, pending: false, stopped: event.stopped })));
            break;
          case "error":
            setMessages(current => patchMessage(current, assistantId, message => ({ ...message, pending: false, error: event.message })));
            break;
        }
      };

      try {
        await streamAnalystMessage(organizationId, body, controller.signal, onEvent);
      } catch (error) {
        if (!controller.signal.aborted) {
          setMessages(current =>
            patchMessage(current, assistantId, message => ({
              ...message,
              pending: false,
              error: error instanceof Error ? error.message : "The analyst could not answer that",
            }))
          );
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        setStreaming(false);
        setMessages(current => patchLastAssistant(current, message => ({ ...message, pending: false })));
      }
    },
    [context, conversationId, onConversation, organizationId, siteId, streaming]
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setStreaming(false);
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setMessages([]);
    setConversationId(null);
    setStreaming(false);
  }, []);

  const load = useCallback((loaded: ChatMessage[], id: string) => {
    // Threads stored before artifacts were de-duplicated can hold the same one
    // several times; the reader should still see it once.
    setMessages(
      loaded.map(message => ({
        ...message,
        ...(message.artifacts
          ? { artifacts: message.artifacts.filter((artifact, index, all) => all.findIndex(other => JSON.stringify(other) === JSON.stringify(artifact)) === index) }
          : {}),
      }))
    );
    setConversationId(id);
    setStreaming(false);
  }, []);

  const setRating = useCallback((messageId: string, rating: number) => {
    setMessages(current => patchMessage(current, messageId, message => ({ ...message, rating })));
  }, []);

  return { messages, conversationId, streaming, send, stop, reset, load, setRating };
}
