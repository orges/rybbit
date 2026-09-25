import { z } from "zod";
import { ANALYST_TOOLS, type AnalystTool, type ToolOutput, type ToolRow } from "./tools.js";

/**
 * Presentation tools: how the answer is drawn, not what it says.
 *
 * Every analytics tool parks its rows here and hands the model a `result_id`. The
 * model then asks for a table or a chart *of that result*, so a rendered number
 * always traces back to a real row set — the chart is a view of the query, never
 * a number the model made up. The store lives for the length of one run; only
 * the small artifact is persisted with the message.
 */

export interface StoredResult {
  id: string;
  rows: ToolRow[];
  rowCount: number;
  source: string;
  sql?: string;
}

export class ResultStore {
  private readonly results = new Map<string, StoredResult>();

  add(rows: ToolRow[] | undefined, source: string, sql?: string): StoredResult | undefined {
    if (!rows?.length) return undefined;
    const id = `r${this.results.size + 1}`;
    const result: StoredResult = { id, rows, rowCount: rows.length, source, ...(sql ? { sql } : {}) };
    this.results.set(id, result);
    return result;
  }

  get(id: string) {
    return this.results.get(id);
  }

  get size() {
    return this.results.size;
  }
}

export type Artifact =
  | {
      type: "chart";
      title: string;
      chartType: "bar" | "line" | "area" | "donut";
      dimension: string;
      metric: string;
      points: Array<{ label: string; value: number; series?: string }>;
    }
  | { type: "table"; title: string; columns: string[]; rows: string[][]; total: number; truncated: boolean }
  | { type: "followups"; title: string; options: string[] }
  | { type: "sql"; title: string; sql: string; rowCount: number };

export interface PresentationOutput extends ToolOutput {
  artifact?: Artifact;
}

const MAX_SERIES = 12;
const MAX_TABLE_ROWS = 100;

const chartArgs = z.object({
  result_id: z.string().min(1),
  title: z.string().min(1).max(120),
  type: z.enum(["bar", "line", "area", "donut"]),
  dimension: z.string().min(1),
  metric: z.string().min(1),
  series: z.string().min(1).optional(),
});

const showChart: AnalystTool = {
  name: "show_chart",
  description:
    "Draw a chart of a previous tool result. Pick the column that labels each point (`dimension`), the numeric column to plot (`metric`), and optionally a second column to split the points into series. Donut and bar need one point per label.",
  parameters: {
    type: "object",
    properties: {
      result_id: { type: "string", description: "The result_id returned by the tool that produced the data" },
      title: { type: "string" },
      type: { type: "string", enum: ["bar", "line", "area", "donut"] },
      dimension: { type: "string", description: "Column whose values label each point" },
      metric: { type: "string", description: "Numeric column to plot" },
      series: { type: "string", description: "Optional second dimension; only valid for line and area" },
    },
    required: ["result_id", "title", "type", "dimension", "metric"],
  },
  async run(args, ctx) {
    const parsed = chartArgs.safeParse(args);
    if (!parsed.success) throw new Error(`Invalid chart arguments: ${parsed.error.errors[0]?.message}`);
    const { result_id, title, type, dimension, metric, series } = parsed.data;
    const result = ctx.results.get(result_id);
    if (!result) throw new Error(`No result ${result_id}. Use one of the result ids from the tools you already called.`);
    const columns = Object.keys(result.rows[0] ?? {});
    for (const column of [dimension, metric, ...(series ? [series] : [])]) {
      if (!columns.includes(column)) {
        throw new Error(`Column "${column}" is not in ${result_id}. Available columns: ${columns.join(", ")}`);
      }
    }
    if (dimension === metric || (series && (series === dimension || series === metric))) {
      throw new Error("dimension, metric and series must be different columns");
    }
    if (series && type !== "line" && type !== "area") throw new Error("Only line and area charts support series");

    const points = result.rows.map(row => ({
      label: String(row[dimension] ?? "").slice(0, 120),
      value: Number(row[metric]),
      ...(series ? { series: String(row[series] ?? "").slice(0, 120) } : {}),
    }));
    if (points.length < 2) throw new Error("A chart needs at least two rows of data");
    if (points.some(point => !Number.isFinite(point.value))) {
      throw new Error(`Column "${metric}" must hold numbers on every row to be charted`);
    }
    const keys = new Set(points.map(point => `${point.label}\u0000${point.series ?? ""}`));
    if (keys.size !== points.length) {
      throw new Error(
        `Each point needs a distinct "${dimension}" value. Aggregate in SQL or use another column so no two rows share a label.`
      );
    }
    if (series && new Set(points.map(point => point.series)).size > MAX_SERIES) {
      throw new Error(`At most ${MAX_SERIES} series; narrow the query or drop the series column`);
    }
    if (type === "donut" && points.every(point => point.value <= 0)) {
      throw new Error("A donut needs at least one positive value");
    }
    const artifact: Artifact = { type: "chart", title, chartType: type, dimension, metric, points };
    return {
      text: `Chart "${title}" shown: ${points.length} points from ${result.source}.`,
      artifact,
    };
  },
};

const tableArgs = z.object({
  result_id: z.string().min(1),
  title: z.string().min(1).max(120),
  columns: z.array(z.string().min(1)).min(1).max(10).optional(),
  limit: z.number().int().min(1).max(MAX_TABLE_ROWS).optional(),
  sort_by: z.string().min(1).optional(),
  sort_order: z.enum(["asc", "desc"]).optional(),
});

const showTable: AnalystTool = {
  name: "show_table",
  description:
    "Show a table of a previous tool result. Use it when the answer is a ranked list, a comparison across rows, or anything a chart would hide.",
  parameters: {
    type: "object",
    properties: {
      result_id: { type: "string" },
      title: { type: "string" },
      columns: { type: "array", items: { type: "string" }, description: "Defaults to every column" },
      limit: { type: "integer", minimum: 1, maximum: MAX_TABLE_ROWS, description: "Defaults to 25" },
      sort_by: { type: "string" },
      sort_order: { type: "string", enum: ["asc", "desc"] },
    },
    required: ["result_id", "title"],
  },
  async run(args, ctx) {
    const parsed = tableArgs.safeParse(args);
    if (!parsed.success) throw new Error(`Invalid table arguments: ${parsed.error.errors[0]?.message}`);
    const { result_id, title, limit, sort_by, sort_order } = parsed.data;
    const result = ctx.results.get(result_id);
    if (!result) throw new Error(`No result ${result_id}. Use one of the result ids from the tools you already called.`);
    const available = Object.keys(result.rows[0] ?? {});
    const columns = parsed.data.columns ?? available;
    for (const column of columns) {
      if (!available.includes(column)) {
        throw new Error(`Column "${column}" is not in ${result_id}. Available columns: ${available.join(", ")}`);
      }
    }
    if (sort_by && !available.includes(sort_by)) throw new Error(`Column "${sort_by}" is not in ${result_id}`);

    const rows = [...result.rows];
    if (sort_by) {
      const direction = sort_order === "asc" ? 1 : -1;
      rows.sort((a, b) => {
        const left = a[sort_by];
        const right = b[sort_by];
        if (typeof left === "number" && typeof right === "number") return (left - right) * direction;
        return String(left ?? "").localeCompare(String(right ?? "")) * direction;
      });
    }
    const take = Math.min(limit ?? 25, MAX_TABLE_ROWS);
    const artifact: Artifact = {
      type: "table",
      title,
      columns,
      rows: rows.slice(0, take).map(row => columns.map(column => formatCell(row[column]))),
      total: rows.length,
      truncated: rows.length > take,
    };
    return { text: `Table "${title}" shown: ${Math.min(take, rows.length)} of ${rows.length} rows from ${result.source}.`, artifact };
  },
};

const formatCell = (value: unknown) => {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(Math.round(value * 1000) / 1000);
  if (typeof value === "object") return JSON.stringify(value).slice(0, 300);
  return String(value).slice(0, 300);
};

const suggestFollowups: AnalystTool = {
  name: "suggest_followups",
  description:
    "Offer up to four short questions the user is likely to ask next, drawn from what the data actually showed. Use it once, at the end of a complete answer, when there is an obvious next step — a drill-down, a comparison, or a different dimension.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "A short label, such as \"Dig deeper\"" },
      options: { type: "array", items: { type: "string" }, description: "2 to 4 complete questions" },
    },
    required: ["title", "options"],
  },
  async run(args) {
    const parsed = z
      .object({ title: z.string().min(1).max(60), options: z.array(z.string().min(4).max(120)).min(2).max(4) })
      .safeParse(args);
    if (!parsed.success) throw new Error("Give a title and 2 to 4 questions of a few words each");
    return {
      text: `Follow-up suggestions shown: ${parsed.data.options.join(" | ")}`,
      artifact: { type: "followups", title: parsed.data.title, options: parsed.data.options },
    };
  },
};

export const PRESENTATION_TOOLS: AnalystTool[] = [showChart, showTable, suggestFollowups];

/** Every tool the agent can actually run, keyed by the name the model calls. */
export const ALL_TOOLS = new Map([...ANALYST_TOOLS, ...PRESENTATION_TOOLS].map(tool => [tool.name, tool]));
