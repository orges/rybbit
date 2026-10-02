"use client";

import { Check, Copy } from "lucide-react";
import { useExtracted } from "next-intl";
import { memo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/**
 * Chat markdown.
 *
 * The analyst answers in Markdown, so the renderer has to carry the same weight
 * as the prose it draws: real headings, readable tables, and code that stays
 * legible. Streaming re-renders this on every token, so it is deliberately plain
 * — no syntax highlighting library, no per-block portals.
 */

const Code = memo(function Code({ children, className }: { children?: ReactNode; className?: string }) {
  const block = /language-(\w+)/.exec(className ?? "")?.[1];
  if (block) {
    return (
      <CodeBlock language={block}>{String(children).replace(/\n$/, "")}</CodeBlock>
    );
  }
  return (
    <code className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-[0.85em] text-neutral-800 dark:bg-neutral-800 dark:text-neutral-200">
      {children}
    </code>
  );
});

function CodeBlock({ children, language }: { children: string; language: string }) {
  const t = useExtracted();
  const [copied, setCopied] = useState(false);
  return (
    <div className="group relative my-2 overflow-hidden rounded-lg border border-neutral-150 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950">
      <div className="flex items-center justify-between border-b border-neutral-150 px-2.5 py-1 text-[10px] uppercase tracking-wide text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
        <span>{language}</span>
        <button
          type="button"
          className="flex items-center gap-1 rounded px-1.5 py-0.5 normal-case tracking-normal text-neutral-500 hover:bg-neutral-150 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-50"
          onClick={() => {
            void navigator.clipboard?.writeText(children);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? t("Copied") : t("Copy")}
        </button>
      </div>
      <pre className="overflow-x-auto p-2.5 font-mono text-xs leading-relaxed">{children}</pre>
    </div>
  );
}

export const Markdown = memo(function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("space-y-2.5 text-sm leading-relaxed break-words", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p>{children}</p>,
          ul: ({ children }) => <ul className="list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal space-y-1 pl-5">{children}</ol>,
          h1: ({ children }) => <h1 className="text-base font-semibold">{children}</h1>,
          h2: ({ children }) => <h2 className="text-sm font-semibold">{children}</h2>,
          h3: ({ children }) => <h3 className="text-sm font-semibold">{children}</h3>,
          hr: () => <hr className="border-neutral-150 dark:border-neutral-850" />,
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-neutral-150 pl-3 text-neutral-600 dark:border-neutral-800 dark:text-neutral-300">
              {children}
            </blockquote>
          ),
          a: ({ children, href }) => (
            <a href={href} className="underline underline-offset-2 hover:text-dataviz" target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          code: ({ children, className }) => (
            <Code className={className}>{children}</Code>
          ),
          pre: ({ children }) => <>{children}</>,
          table: ({ children }) => (
            <div className="overflow-x-auto rounded-lg border border-neutral-150 dark:border-neutral-800">
              <table className="w-full border-collapse text-xs">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="whitespace-nowrap border-b border-neutral-150 bg-neutral-50 px-2 py-1.5 text-left font-medium text-neutral-600 dark:border-neutral-800 dark:bg-neutral-850 dark:text-neutral-300">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b border-neutral-100 px-2 py-1.5 align-top dark:border-neutral-850">{children}</td>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
