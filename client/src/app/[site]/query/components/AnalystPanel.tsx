"use client";

import { Square, Send } from "lucide-react";
import { useExtracted } from "next-intl";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  analyzeQuery,
  generateCustomQuery,
  type AnalyzeQueryResponse,
} from "../../../../api/analytics/endpoints/customQuery";
import { Button } from "../../../../components/ui/button";
import { getErrorMessage, isAbortError } from "../utils";

type Exchange = { question: string; result?: AnalyzeQueryResponse; error?: string };

function ResultChart({ rows }: { rows: AnalyzeQueryResponse["rows"] }) {
  if (rows.length < 2) return null;
  const keys = Object.keys(rows[0]);
  const label = keys.find(key => typeof rows[0][key] === "string" && rows.every(row => row[key] != null));
  const metric = keys.findLast(
    key => rows.every(row => row[key] != null && Number.isFinite(Number(row[key]))) && key !== label
  );
  if (!label || !metric) return null;
  const max = Math.max(...rows.slice(0, 12).map(row => Number(row[metric])));
  if (max <= 0) return null;

  return (
    <div className="space-y-2 rounded-lg border border-neutral-150 p-3 dark:border-neutral-850">
      <p className="text-xs font-medium">
        {metric} by {label}
      </p>
      {rows.slice(0, 12).map((row, index) => (
        <div key={index} className="flex items-center gap-2 text-xs">
          <span className="w-28 shrink-0 truncate" title={String(row[label])}>
            {String(row[label])}
          </span>
          <div className="h-4 flex-1 bg-neutral-100 dark:bg-neutral-850">
            <div
              className="h-full bg-[var(--dataviz)]"
              style={{ width: `${Math.max(0, (Number(row[metric]) / max) * 100)}%` }}
            />
          </div>
          <span className="w-16 text-right tabular-nums">{Number(row[metric]).toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

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
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    abortRef.current?.abort();
    setExchanges([]);
    setBusy(false);
  }, [organizationId, siteId]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const prompt = question.trim();
    if (!organizationId || !prompt || busy) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setQuestion("");
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
        { query: generated.query, question: prompt, siteId },
        controller.signal
      );
      if (controller.signal.aborted) return;
      setExchanges(current => [...current.slice(0, -1), { question: prompt, result }]);
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
      <div className="border-b border-neutral-150 px-4 py-3 text-sm font-medium dark:border-neutral-850">
        {t("AI analyst")}
      </div>
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4" aria-live="polite">
        {exchanges.length === 0 && (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            {t("Ask a question about this site's analytics.")}
          </p>
        )}
        {exchanges.map((exchange, index) => (
          <div key={index} className="space-y-3 text-sm">
            <p className="font-medium">{exchange.question}</p>
            {exchange.error && (
              <p role="alert" className="text-red-600 dark:text-red-400">
                {exchange.error}
              </p>
            )}
            {exchange.result && (
              <div className="space-y-3 border-t border-neutral-150 pt-3 dark:border-neutral-850">
                <p className="whitespace-pre-wrap leading-relaxed">{exchange.result.summary}</p>
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
      <form onSubmit={submit} className="flex gap-2 border-t border-neutral-150 p-3 dark:border-neutral-850">
        <input
          className="min-w-0 flex-1 rounded-lg border border-neutral-150 bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neutral-400 dark:border-neutral-800"
          aria-label={t("Ask about your analytics")}
          placeholder={t("Ask about your analytics")}
          value={question}
          onChange={event => setQuestion(event.target.value)}
          maxLength={4000}
          disabled={!organizationId || busy}
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
          <Button type="submit" disabled={!organizationId || !question.trim()} aria-label={t("Send question")}>
            <Send className="h-4 w-4" />
          </Button>
        )}
      </form>
    </section>
  );
}
