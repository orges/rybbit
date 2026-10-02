"use client";

import type { DashboardCardMapping } from "@rybbit/shared";
import { useMemo } from "react";
import type { CustomQueryRow } from "@/api/analytics/endpoints";
import { TimeSeriesChart, type TimeSeriesChartSeries } from "@/components/charts/TimeSeriesChart";
import { getChartTimeBounds } from "@/components/charts/timeSeriesChartUtils";
import { DateTime } from "luxon";
import { getTimezone, useStore } from "@/lib/store";
import type { Time } from "@/components/DateSelector/types";
import { formatter } from "@/lib/utils";
import { buildChartAxis, buildWideData, inferChartBucket, parseChartDate } from "../../utils";
import { CardLegend, ChartEmpty, DashboardTooltip, toCardSeries } from "./shared";

type DashboardLineChartProps = {
  rows: CustomQueryRow[];
  mapping: DashboardCardMapping;
  /** Fill the area beneath the line (single-series only). */
  area?: boolean;
  /**
   * The data carries its own time range, rather than being a view of the
   * dashboard's. The axis is then read off the values and the domain is the
   * data's, instead of the viewer's time selector.
   */
  standalone?: boolean;
};

type LinePoint = { x: Date; y: number; label: string };

// Spacing for non-time categories that still need a monotonic time domain so the
// d3 time scale renders them in order (one synthetic day per row).
const SYNTH_EPOCH = Date.UTC(2000, 0, 1);
const SYNTH_STEP = 86_400_000;

export function DashboardLineChart({ rows, mapping, area = false, standalone = false }: DashboardLineChartProps) {
  const time = useStore(state => state.time);
  const storeBucket = useStore(state => state.bucket);
  const timezone = getTimezone();

  const wide = useMemo(() => buildWideData(rows, mapping), [rows, mapping]);
  const bucket = useMemo(
    () => (standalone ? inferChartBucket(wide ? wide.data.map(entry => String(entry[wide.indexBy])) : []) : storeBucket),
    [standalone, storeBucket, wide]
  );
  const axis = useMemo(
    () => buildChartAxis(wide ? wide.data.map(entry => String(entry[wide.indexBy])) : [], bucket),
    [wide, bucket]
  );

  const { series, max, chartMin, chartMax } = useMemo(() => {
    if (!wide) {
      return { series: [] as TimeSeriesChartSeries<LinePoint>[], max: 1, chartMin: undefined, chartMax: undefined };
    }

    const series: TimeSeriesChartSeries<LinePoint>[] = toCardSeries(wide.keys).map(item => ({
      id: item.label,
      color: item.color,
      data: wide.data
        .map((entry, index) => {
          const raw = String(entry[wide.indexBy] ?? "");
          const parsed = axis.isTime ? parseChartDate(raw) : null;
          return {
            x: parsed ? parsed.toJSDate() : new Date(SYNTH_EPOCH + index * SYNTH_STEP),
            y: Number(entry[item.key]) || 0,
            label: axis.isTime ? axis.format(raw) : raw,
          } satisfies LinePoint;
        })
        .sort((a, b) => a.x.getTime() - b.x.getTime()),
    }));

    let max = 0;
    for (const item of series) {
      for (const point of item.data) {
        if (point.y > max) max = point.y;
      }
    }

    let chartMin: Date | undefined;
    let chartMax: Date | undefined;
    if (axis.isTime && !standalone) {
      const bounds = getChartTimeBounds(time, bucket, timezone);
      chartMin = bounds.min;
      chartMax = bounds.max;
    }
    if (!chartMin || !chartMax) {
      const xs = series.flatMap(item => item.data.map(point => point.x.getTime()));
      if (xs.length) {
        const min = Math.min(...xs);
        const maxX = Math.max(...xs);
        chartMin = new Date(min);
        chartMax = new Date(maxX === min ? min + SYNTH_STEP : maxX);
      }
    }

    return { series, max: max || 1, chartMin, chartMax };
  }, [wide, axis, standalone, time, bucket, timezone]);

  if (!wide || series.length === 0 || series.every(item => item.data.length === 0)) {
    return <ChartEmpty />;
  }

  const multi = series.length > 1;

  // A standalone chart has no dashboard range to label itself with, so it states
  // the one its own points cover. No start/end times, so the ticks fall back to
  // "Sep 19" rather than the time-of-day a dashboard would use.
  const standaloneTime = useMemo(
    () =>
      chartMin && chartMax
        ? ({
            mode: "range",
            startDate: DateTime.fromJSDate(chartMin, { zone: timezone }).toFormat("yyyy-MM-dd"),
            endDate: DateTime.fromJSDate(chartMax, { zone: timezone }).toFormat("yyyy-MM-dd"),
          } as Time)
        : undefined,
    [chartMin, chartMax, timezone]
  );

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1">
        <TimeSeriesChart<LinePoint>
          current={multi ? [] : series[0].data}
          series={multi ? series : undefined}
          currentColor={series[0].color}
          currentAreaOpacity={area && !multi ? 0.25 : 0}
          max={max}
          chartMin={chartMin}
          chartMax={chartMax}
          bucket={bucket}
          {...(standaloneTime ? { time: standaloneTime } : {})}
          disableDragZoom
          yTickFormat={formatter}
          renderTooltip={({ point, points }) => {
            const items = multi
              ? points.map(entry => ({
                  label: entry.id,
                  color: entry.color,
                  value: entry.point.y,
                }))
              : [{ label: series[0].id, color: series[0].color, value: point.y }];
            return <DashboardTooltip title={point.label} items={items} />;
          }}
        />
      </div>
      {multi && <CardLegend series={toCardSeries(wide.keys)} />}
    </div>
  );
}
