"use client";

import type { CustomQueryRow } from "@/api/analytics/endpoints";
import type { AnalystArtifact } from "@/api/analyst/endpoints/analyst";
import { DashboardBarChart } from "@/app/[site]/dashboards/components/charts/DashboardBarChart";
import { DashboardLineChart } from "@/app/[site]/dashboards/components/charts/DashboardLineChart";
import { DashboardPie } from "@/app/[site]/dashboards/components/charts/DashboardPie";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/**
 * Rendered results.
 *
 * Charts reuse the dashboard card components rather than a second chart
 * implementation: the same palette, tooltips, legends and dark-mode behaviour the
 * rest of the product uses, for free and by construction.
 */

const CHART_HEIGHT = 260;

type ChartArtifact = Extract<AnalystArtifact, { type: "chart" }>;

/** The series column is only named by the points themselves, not by the artifact. */
const seriesColumnOf = (artifact: ChartArtifact) =>
  artifact.points.find(point => point.series !== undefined) ? "series" : undefined;

function chartRows(artifact: ChartArtifact): CustomQueryRow[] {
  const seriesColumn = seriesColumnOf(artifact);
  return artifact.points.map(point => ({
    [artifact.dimension]: point.label,
    [artifact.metric]: point.value,
    ...(seriesColumn && point.series !== undefined ? { [seriesColumn]: point.series } : {}),
  }));
}

function Chart({ artifact }: { artifact: ChartArtifact }) {
  const rows = chartRows(artifact);
  const seriesColumn = seriesColumnOf(artifact);
  if (artifact.chartType === "donut") {
    return (
      <div style={{ height: CHART_HEIGHT }}>
        <DashboardPie rows={rows} mapping={{ xColumn: artifact.dimension, valueColumn: artifact.metric }} />
      </div>
    );
  }
  if (artifact.chartType === "line" || artifact.chartType === "area") {
    return (
      <div style={{ height: CHART_HEIGHT }}>
        <DashboardLineChart
          rows={rows}
          area={artifact.chartType === "area"}
          standalone
          mapping={{ xColumn: artifact.dimension, yColumns: [artifact.metric], ...(seriesColumn ? { seriesColumn } : {}) }}
        />
      </div>
    );
  }
  return (
    <div style={{ height: CHART_HEIGHT }}>
      <DashboardBarChart
        standalone
        showValues
        rows={rows}
        mapping={{
          xColumn: artifact.dimension,
          yColumns: [artifact.metric],
          ...(seriesColumn ? { seriesColumn } : {}),
        }}
      />
    </div>
  );
}

/** Query results come back as raw values; the rest of Rybbit shows grouped numbers. */
function formatCell(value: string) {
  if (!/^-?\d+(\.\d+)?$/.test(value)) return value;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed.toLocaleString() : parsed.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function ArtifactTable({ artifact }: { artifact: Extract<AnalystArtifact, { type: "table" }> }) {
  return (
    <div className="space-y-1.5">
      <div className="max-h-96 overflow-auto rounded-lg border border-neutral-150 dark:border-neutral-800">
        <Table>
          <TableHeader>
            <TableRow>
              {artifact.columns.map(column => (
                <TableHead key={column} className="whitespace-nowrap">
                  {column}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {artifact.rows.map((row, rowIndex) => (
              <TableRow key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <TableCell key={cellIndex} className="max-w-80 truncate font-mono text-xs tabular-nums" title={cell}>
                    {formatCell(cell)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {artifact.truncated && (
        <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
          {`Showing ${artifact.rows.length} of ${artifact.total} rows.`}
        </p>
      )}
    </div>
  );
}

function Followups({ artifact, onPick }: { artifact: Extract<AnalystArtifact, { type: "followups" }>; onPick: (value: string) => void }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-neutral-600 dark:text-neutral-300">{artifact.title}</p>
      <div className="flex flex-wrap gap-1.5">
        {artifact.options.map(option => (
          <button
            key={option}
            type="button"
            onClick={() => onPick(option)}
            className="rounded-md border border-neutral-150 px-2 py-1 text-left text-xs text-neutral-700 transition-colors hover:border-neutral-300 hover:bg-neutral-50 dark:border-neutral-850 dark:text-neutral-200 dark:hover:border-neutral-700 dark:hover:bg-neutral-800"
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ArtifactCard({ artifact, onFollowup }: { artifact: AnalystArtifact; onFollowup?: (value: string) => void }) {
  if (artifact.type === "followups" && onFollowup) {
    return <Followups artifact={artifact} onPick={onFollowup} />;
  }
  if (artifact.type === "sql") {
    return (
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-neutral-600 dark:text-neutral-300">{artifact.title}</p>
        <pre className="overflow-x-auto rounded-lg border border-neutral-150 bg-neutral-50 p-2.5 font-mono text-xs dark:border-neutral-800 dark:bg-neutral-950">
          {artifact.sql}
        </pre>
      </div>
    );
  }
  return (
    <figure className="space-y-2 rounded-lg border border-neutral-150 bg-white p-3 dark:border-neutral-850 dark:bg-neutral-900">
      <figcaption className="text-xs font-medium text-neutral-600 dark:text-neutral-300">{artifact.title}</figcaption>
      {artifact.type === "chart" ? (
        <Chart artifact={artifact} />
      ) : artifact.type === "table" ? (
        <ArtifactTable artifact={artifact} />
      ) : null}
    </figure>
  );
}
