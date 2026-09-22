"use client";

import { ResponsiveBar } from "@nivo/bar";
import { ResponsiveLine } from "@nivo/line";
import { useExtracted } from "next-intl";
import { useState } from "react";
import type { AnalyzeQueryResponse } from "../../../../api/analytics/endpoints/customQuery";
import { useNivoTheme } from "../../../../lib/nivo";

const colors = ["#6366f1", "#06b6d4", "#f59e0b", "#10b981", "#f43f5e", "#a855f7"];
type ChartType = "bar" | "line" | "donut";
type ChartPoint = { label: string; [metric: string]: string | number };

export function chartData(rows: AnalyzeQueryResponse["rows"]): { label: string; metrics: string[]; points: ChartPoint[] } | null {
  if (!rows.length) return null;
  const keys = Object.keys(rows[0]);
  const numeric = keys.filter(key => rows.every(row => row[key] != null && Number.isFinite(Number(row[key]))));
  const label = keys.find(key => !numeric.includes(key) && rows.every(row => row[key] != null));
  if (label && numeric.length && rows.length > 1)
    return {
      label,
      metrics: numeric,
      points: rows
        .slice(0, 50)
        .map(row => ({
          label: String(row[label]),
          ...Object.fromEntries(numeric.map(key => [key, Number(row[key])])),
        })),
    };
  if (rows.length === 1 && numeric.length > 1)
    return {
      label: "Metric",
      metrics: ["Value"],
      points: numeric.map(key => ({ label: key, Value: Number(rows[0][key]) })),
    };
  return null;
}

export function ResultChart({ rows }: { rows: AnalyzeQueryResponse["rows"] }) {
  const t = useExtracted();
  const theme = useNivoTheme();
  const [type, setType] = useState<ChartType>("bar");
  const data = chartData(rows);
  if (!data) return null;
  const { label, metrics, points } = data;
  const values = points.map(point => Number(point[metrics[0]]));
  const total = values.reduce((sum, value) => sum + value, 0);
  const canUseDonut = metrics.length === 1 && points.length <= 12 && values.every(value => value >= 0) && total > 0;
  const selected = type === "donut" && !canUseDonut ? "bar" : type;
  let offset = 0;
  const stops = points.map((point, index) => {
    const start = offset;
    offset += (values[index] / total) * 100;
    return `${colors[index % colors.length]} ${start}% ${offset}%`;
  });

  return (
    <div className="rounded-lg border border-neutral-150 p-3 dark:border-neutral-850">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <span className="mr-auto font-medium">
          {metrics.join(", ")} / {label}
        </span>
        {(["bar", "line", ...(canUseDonut ? ["donut"] : [])] as ChartType[]).map(view => (
          <button
            key={view}
            type="button"
            aria-pressed={selected === view}
            className={`rounded px-2 py-1 ${selected === view ? "bg-neutral-200 text-neutral-950 dark:bg-neutral-700 dark:text-white" : "text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"}`}
            onClick={() => setType(view)}
          >
            {view === "bar" ? t("Bar") : view === "line" ? t("Line") : t("Donut")}
          </button>
        ))}
      </div>
      {selected === "donut" ? (
        <div className="flex flex-wrap items-center justify-center gap-6 py-4">
          <div
            role="img"
            aria-label={t("Distribution by {label}", { label })}
            className="size-48 shrink-0 rounded-full"
            style={{
              background: `conic-gradient(${stops.join(", ")})`,
              mask: "radial-gradient(farthest-side, transparent 58%, black 60%)",
            }}
          />
          <ul className="space-y-1 text-xs">
            {points.map((point, index) => (
              <li key={index} className="flex items-center gap-2">
                <span className="size-2 rounded-full" style={{ background: colors[index % colors.length] }} />
                <span className="max-w-40 truncate">{point.label}</span>
                <span className="ml-auto tabular-nums">{values[index].toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div
          className="h-80"
          role="img"
          aria-label={t("Chart of {metrics} by {label}", { metrics: metrics.join(", "), label })}
        >
          {selected === "line" ? (
            <ResponsiveLine
              data={metrics.map(metric => ({
                id: metric,
                data: points.map(point => ({ x: point.label, y: Number(point[metric]) })),
              }))}
              xScale={{ type: "point" }}
              yScale={{ type: "linear", min: "auto", max: "auto" }}
              margin={{ top: 20, right: 25, bottom: 65, left: 65 }}
              axisBottom={{ tickRotation: -35, tickValues: Math.min(points.length, 8) }}
              colors={colors}
              theme={theme}
              useMesh
              enablePoints={points.length <= 20}
              animate={false}
            />
          ) : (
            <ResponsiveBar
              data={points}
              keys={metrics}
              indexBy="label"
              groupMode="grouped"
              margin={{ top: 20, right: 25, bottom: 65, left: 65 }}
              axisBottom={{ tickRotation: -35, tickValues: Math.min(points.length, 8) }}
              colors={colors}
              theme={theme}
              enableLabel={false}
              animate={false}
            />
          )}
        </div>
      )}
    </div>
  );
}
