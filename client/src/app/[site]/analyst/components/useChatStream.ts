"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

const patchLastUser = (messages: ChatMessage[], patch: (message: ChatMessage) => ChatMessage) => {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "user") {
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
  /**
   * A run finished, successfully or not. The conversation is reported because a
   * run is not tied to the view: it finishes in whatever thread it was asked in.
   */
  onRunSettled?: (conversationId: string | null) => void;
}

/**
 * Stands in for a run whose thread has no id yet — a new chat is only identified
 * by the server's first event, and until then it still needs a slot to occupy.
 */
const NEW_THREAD = "\u0000new";

export function useChatStream({ organizationId, siteId, context, onConversation, onRunSettled }: UseChatStreamOptions) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  /**
   * Threads with a run still going, so more than one can be in flight.
   *
   * A run outlives the view on purpose: switching threads leaves it working, and
   * the answer is there when you come back. That only works if the composer is not
   * held hostage by a run in some other thread, so this is per thread rather than
   * one global flag.
   */
  const [liveThreads, setLiveThreads] = useState<string[]>([]);
  const runsRef = useRef(new Map<string, AbortController>());
  const viewedRef = useRef<string | null>(null);
  const assistantIdRef = useRef<string>("");

  // Which thread is on screen, readable from a callback that would otherwise close
  // over a stale value — `stop` has to abort the run the reader can see.
  useEffect(() => {
    viewedRef.current = conversationId;
  }, [conversationId]);

  /** True only while the thread on screen is the one still answering. */
  const streaming = liveThreads.includes(conversationId ?? NEW_THREAD);

  const send = useCallback(
    async (text: string, options?: { regenerate?: boolean; editOfMessageId?: string }) => {
      const prompt = text.trim();
      if (!prompt) return;
      // One run per thread, but a different thread may already be answering.
      const thread = conversationId ?? NEW_THREAD;
      if (runsRef.current.has(thread)) return;

      const userMessage: ChatMessage = {
        id: `local-user-${Date.now()}`,
        role: "user",
        content: prompt,
        context,
      };
      const assistantId = `local-assistant-${Date.now()}`;
      assistantIdRef.current = assistantId;
      const assistant: ChatMessage = { id: assistantId, role: "assistant", content: "", pending: true, toolCalls: [] };
      setMessages(current => {
        // A re-ask takes the edited question's place in the transcript, so the
        // thread reads the same as the one the server keeps.
        const edited = options?.editOfMessageId ? current.findIndex(entry => entry.id === options.editOfMessageId) : -1;
        if (edited !== -1) return [...current.slice(0, edited), { ...userMessage, id: options!.editOfMessageId! }, assistant];
        if (options?.regenerate && current.length > 1) return [...current.slice(0, current.length - 1), assistant];
        return [...current, userMessage, assistant];
      });
      const controller = new AbortController();
      runsRef.current.set(thread, controller);
      setLiveThreads(current => (current.includes(thread) ? current : [...current, thread]));
      // The slot a run occupies moves once the server names its thread, and every
      // later reference — including `finally` — has to follow it there.
      let runKey = thread;

      const body: SendMessageRequest = {
        siteId,
        message: prompt,
        ...(conversationId ? { conversationId } : {}),
        ...(options?.regenerate ? { regenerate: true } : {}),
        ...(options?.editOfMessageId ? { editOfMessageId: options.editOfMessageId } : {}),
        context,
      };

      const onEvent = (event: ChatStreamEvent) => {
        switch (event.type) {
          case "conversation": {
            const previousKey = runKey;
            if (previousKey !== event.conversationId) {
              const running = runsRef.current.get(previousKey);
              if (running) {
                runsRef.current.delete(previousKey);
                runsRef.current.set(event.conversationId, running);
              }
              setLiveThreads(current => current.map(id => (id === previousKey ? event.conversationId : id)));
              runKey = event.conversationId;
            }
            setConversationId(event.conversationId);
            onConversation?.(event.conversationId);
            break;
          }
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
          case "unverified":
            setMessages(current =>
              patchMessage(current, assistantId, message => ({ ...message, unverified: event.figures }))
            );
            break;
          case "message_id":
            assistantIdRef.current = event.messageId;
            setMessages(current => patchMessage(current, assistantId, message => ({ ...message, id: event.messageId })));
            break;
          case "user_message_id":
            // The stored id, so this question can be edited later without a
            // reload; a local id would come back as "not found".
            setMessages(current => patchLastUser(current, message => ({ ...message, id: event.messageId })));
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
        runsRef.current.delete(runKey);
        setLiveThreads(current => current.filter(id => id !== runKey));
        setMessages(current => patchLastAssistant(current, message => ({ ...message, pending: false })));
        // The id the run was given, not the one this closure was created with —
        // a new thread has none until the server names it mid-run.
        onRunSettled?.(runKey === NEW_THREAD ? null : runKey);
      }
    },
    [context, conversationId, onConversation, onRunSettled, organizationId, siteId]
  );

  /** Stops the run in the thread on screen. Runs in other threads keep going. */
  const stop = useCallback(() => {
    runsRef.current.get(viewedRef.current ?? NEW_THREAD)?.abort();
  }, []);

  /** New chat: clears the view. It does not stop anything. */
  const reset = useCallback(() => {
    setMessages([]);
    setConversationId(null);
  }, []);

  const load = useCallback((loaded: ChatMessage[], id: string) => {
    // Nothing is aborted here. A run asked in another thread carries on, and its
    // deltas patch a message id that is not in this list, so they land nowhere
    // rather than corrupting this thread.
    //
    // Threads stored before artifacts were de-duplicated can hold the same one
    // several times; the reader should still see it once.
    setMessages(
      loaded.map(message => ({
        ...message,
        ...(message.artifacts
          ? { artifacts: message.artifacts.filter((artifact, index, all) => all.findIndex(other => JSON.stringify(other) === JSON.stringify(artifact)) === index) }
          : {}),
        ...(message.unverified?.length ? { unverified: [...new Set(message.unverified)] } : {}),
      }))
    );
    setConversationId(id);
  }, []);

  return { messages, conversationId, liveThreads, streaming, send, stop, reset, load };
}
