"use client";

import { Square, Send, Trash2 } from "lucide-react";
import { useExtracted } from "next-intl";
import { useEffect, useRef, useState, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  analyzeQuery,
  deleteAiConversation,
  generateCustomQuery,
  getAiConversation,
  listAiConversations,
  type AiConversation,
  type AnalyzeQueryResponse,
} from "../../../../api/analytics/endpoints/customQuery";
import { Button } from "../../../../components/ui/button";
import { getErrorMessage, isAbortError } from "../utils";
import { ResultChart } from "./ResultChart";

type Exchange = { question: string; result?: AnalyzeQueryResponse; error?: string };

export function AnalystPanel({
  organizationId,
  siteId,
  currentPage,
}: {
  organizationId?: string;
  siteId: number;
  currentPage?: string;
}) {
  const t = useExtracted();
  const [question, setQuestion] = useState("");
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [conversations, setConversations] = useState<AiConversation[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const historyAbortRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      historyAbortRef.current?.abort();
    },
    []
  );
  useEffect(() => {
    abortRef.current?.abort();
    historyAbortRef.current?.abort();
    setExchanges([]);
    setConversations([]);
    setConversationId(null);
    setHistoryError(null);
    setBusy(false);
    if (!organizationId) {
      setLoadingHistory(false);
      return;
    }
    const controller = new AbortController();
    historyAbortRef.current = controller;
    setLoadingHistory(true);
    const load = async () => {
      try {
        const list = await listAiConversations(organizationId, siteId, controller.signal);
        if (controller.signal.aborted) return;
        setConversations(list);
        if (list[0]) {
          const messages = await getAiConversation(organizationId, siteId, list[0].id, controller.signal);
          if (controller.signal.aborted) return;
          setConversationId(list[0].id);
          setExchanges(messages.map(({ question, ...result }) => ({ question, result })));
        }
      } catch (error) {
        if (!controller.signal.aborted)
          setHistoryError(getErrorMessage(error, t("Could not load conversation history")));
      } finally {
        if (!controller.signal.aborted) setLoadingHistory(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [organizationId, siteId]);

  const selectConversation = async (id: string) => {
    historyAbortRef.current?.abort();
    setHistoryError(null);
    setConversationId(id || null);
    setExchanges([]);
    if (!id || !organizationId) {
      setLoadingHistory(false);
      return;
    }
    const controller = new AbortController();
    historyAbortRef.current = controller;
    setLoadingHistory(true);
    try {
      const messages = await getAiConversation(organizationId, siteId, id, controller.signal);
      if (!controller.signal.aborted) setExchanges(messages.map(({ question, ...result }) => ({ question, result })));
    } catch (error) {
      if (!controller.signal.aborted) setHistoryError(getErrorMessage(error, t("Could not load conversation history")));
    } finally {
      if (!controller.signal.aborted) setLoadingHistory(false);
    }
  };

  const removeConversation = async () => {
    if (!organizationId || !conversationId || !window.confirm(t("Delete this conversation?"))) return;
    setLoadingHistory(true);
    try {
      await deleteAiConversation(organizationId, siteId, conversationId);
      setConversations(current => current.filter(conversation => conversation.id !== conversationId));
      setConversationId(null);
      setExchanges([]);
    } catch (error) {
      setHistoryError(getErrorMessage(error, t("Could not delete conversation")));
    } finally {
      setLoadingHistory(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const prompt = question.trim();
    if (!organizationId || !prompt || busy || loadingHistory) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setQuestion("");
    setHistoryError(null);
    setBusy(true);
    setExchanges(current => [...current, { question: prompt }]);
    try {
      const history = exchanges
        .filter(exchange => exchange.result)
        .flatMap(exchange => [
          { role: "user" as const, content: exchange.question },
          { role: "assistant" as const, content: exchange.result!.query },
        ])
        .slice(-10);
      const generated = await generateCustomQuery(
        organizationId,
        {
          prompt,
          currentSiteId: siteId,
          currentPage,
          history,
          currentQuery: exchanges.at(-1)?.result?.query,
        },
        controller.signal
      );
      if (controller.signal.aborted) return;
      const result = await analyzeQuery(
        organizationId,
        { query: generated.query, question: prompt, siteId, conversationId: conversationId ?? undefined },
        controller.signal,
        partial => {
          if (!controller.signal.aborted)
            setExchanges(current => [...current.slice(0, -1), { question: prompt, result: partial }]);
        }
      );
      if (controller.signal.aborted) return;
      setExchanges(current => [...current.slice(0, -1), { question: prompt, result }]);
      if (result.conversationId) {
        setConversationId(result.conversationId);
        void listAiConversations(organizationId, siteId)
          .then(setConversations)
          .catch(() => {});
      }
    } catch (error) {
      if (!isAbortError(error) && !controller.signal.aborted) {
        setExchanges(current => [
          ...current.slice(0, -1),
          { question: prompt, error: getErrorMessage(error, t("Analysis failed")) },
        ]);
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setBusy(false);
      }
    }
  };

  return (
    <section
      className="flex min-h-0 flex-1 flex-col rounded-lg border border-neutral-150 bg-white dark:border-neutral-850 dark:bg-neutral-900"
      aria-label={t("AI analyst")}
    >
      <div className="flex items-center gap-2 border-b border-neutral-150 px-4 py-3 text-sm dark:border-neutral-850">
        <span className="font-medium">{t("AI analyst")}</span>
        <select
          aria-label={t("Conversation history")}
          className="min-w-0 flex-1 rounded bg-white text-xs text-neutral-900 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neutral-400 dark:bg-neutral-900 dark:text-neutral-100"
          value={conversationId ?? ""}
          onChange={event => void selectConversation(event.target.value)}
          disabled={busy || loadingHistory}
        >
          <option value="">{t("New chat")}</option>
          {conversations.map(conversation => (
            <option key={conversation.id} value={conversation.id}>
              {conversation.title}
            </option>
          ))}
        </select>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={!conversationId || busy || loadingHistory}
          onClick={() => void removeConversation()}
          aria-label={t("Delete conversation")}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-8 overflow-y-auto p-4 md:p-6" aria-live="polite">
        <div className="mx-auto max-w-4xl space-y-8">
          {historyError && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {historyError}
            </p>
          )}
          {loadingHistory && <p className="text-sm text-neutral-500">{t("Loading...")}</p>}
          {exchanges.length === 0 && !loadingHistory && (
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              {t("Ask a question about this site's analytics.")}
            </p>
          )}
          {exchanges.map((exchange, index) => (
            <div key={index} className="space-y-3 text-sm">
              <p className="ml-auto max-w-[85%] rounded-2xl bg-neutral-100 px-4 py-3 font-medium whitespace-pre-wrap dark:bg-neutral-800">
                {exchange.question}
              </p>
              {exchange.error && (
                <p role="alert" className="text-red-600 dark:text-red-400">
                  {exchange.error}
                </p>
              )}
              {exchange.result && (
                <div className="space-y-4 border-t border-neutral-150 pt-4 dark:border-neutral-850">
                  <div className="space-y-3 leading-relaxed break-words">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        p: ({ children }) => <p>{children}</p>,
                        ul: ({ children }) => <ul className="list-disc space-y-1 pl-5">{children}</ul>,
                        ol: ({ children }) => <ol className="list-decimal space-y-1 pl-5">{children}</ol>,
                        h1: ({ children }) => <h1 className="text-lg font-semibold">{children}</h1>,
                        h2: ({ children }) => <h2 className="text-base font-semibold">{children}</h2>,
                        h3: ({ children }) => <h3 className="font-semibold">{children}</h3>,
                        a: ({ children, href }) => (
                          <a href={href} className="underline" target="_blank" rel="noopener noreferrer">
                            {children}
                          </a>
                        ),
                        code: ({ children }) => (
                          <code className="rounded bg-neutral-100 px-1 font-mono text-xs dark:bg-neutral-800">
                            {children}
                          </code>
                        ),
                        pre: ({ children }) => (
                          <pre className="overflow-x-auto rounded bg-neutral-100 p-3 text-xs dark:bg-neutral-800">
                            {children}
                          </pre>
                        ),
                        table: ({ children }) => (
                          <div className="overflow-x-auto">
                            <table className="w-full border-collapse text-xs">{children}</table>
                          </div>
                        ),
                        th: ({ children }) => <th className="border p-2 text-left">{children}</th>,
                        td: ({ children }) => <td className="border p-2">{children}</td>,
                      }}
                    >
                      {exchange.result.summary || t("Analyzing…")}
                    </ReactMarkdown>
                  </div>
                  <ResultChart rows={exchange.result.rows} />
                  {exchange.result.rows.length > 0 && (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead>
                          <tr>
                            {Object.keys(exchange.result.rows[0]).map(key => (
                              <th key={key} className="border-b p-2">
                                {key}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {exchange.result.rows.slice(0, 10).map((row, rowIndex) => (
                            <tr key={rowIndex}>
                              {Object.keys(exchange.result!.rows[0]).map(key => (
                                <td key={key} className="border-b p-2">
                                  {String(row[key] ?? "")}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <p className="mt-2 text-neutral-500 dark:text-neutral-400">
                        {t("Showing {shown} of {count} rows", {
                          shown: String(Math.min(10, exchange.result.rows.length)),
                          count: String(exchange.result.rowCount),
                        })}
                      </p>
                    </div>
                  )}
                  <details className="text-xs">
                    <summary className="cursor-pointer">{t("View SQL")}</summary>
                    <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded bg-neutral-100 p-3 dark:bg-neutral-850">
                      {exchange.result.query}
                    </pre>
                  </details>
                </div>
              )}
              {!exchange.error && !exchange.result && <p className="text-neutral-500">{t("Analyzing…")}</p>}
            </div>
          ))}
        </div>
      </div>
      <form onSubmit={submit} className="flex gap-2 border-t border-neutral-150 p-3 dark:border-neutral-850 md:px-6">
        <textarea
          rows={2}
          className="min-w-0 flex-1 resize-none rounded-lg border border-neutral-150 bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neutral-400 dark:border-neutral-800"
          aria-label={t("Ask about your analytics")}
          placeholder={t("Ask about your analytics")}
          value={question}
          onChange={event => setQuestion(event.target.value)}
          onKeyDown={event => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          maxLength={4000}
          disabled={!organizationId || busy || loadingHistory}
        />
        {busy ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              abortRef.current?.abort();
              setExchanges(current => current.slice(0, -1));
              setBusy(false);
            }}
            aria-label={t("Stop analysis")}
          >
            <Square className="h-4 w-4" />
          </Button>
        ) : (
          <Button
            type="submit"
            disabled={!organizationId || !question.trim() || loadingHistory}
            aria-label={t("Send question")}
          >
            <Send className="h-4 w-4" />
          </Button>
        )}
      </form>
    </section>
  );
}
