/**
 * Checking an answer against the data it came from.
 *
 * An analytics answer that invents a number is worse than no answer, and the
 * model does it: rounding 4,714 to "about 5,000", transposing a digit, or
 * carrying a figure over from a previous step. Everything it says is supposed to
 * trace to a tool result, so the numbers in its prose can be checked against
 * them.
 *
 * Only figures that look like a quoted measurement are checked — thousands-
 * separated values, decimals, and long integers. Small counts and derived values
 * ("the top 3", "65% more than the runner-up") are the model's arithmetic, not a
 * quotation, and checking those would flag correct answers all day. A flag means
 * "this figure does not appear in anything the tools returned", never "this is
 * wrong".
 */

/** A number the answer presents as a measurement. */
const MEASUREMENT = /(?<![0-9A-Za-z.])(\d{1,3}(?:,\d{3})+|\d{4,}|\d+\.\d+%?)(?=$|[^0-9A-Za-z%]|\.(?!\d))/g;

const normalize = (value: string) => value.replace(/,/g, "").replace(/%$/, "");

type Candidate = { raw: string; value: string; at: number };

function candidates(text: string): Candidate[] {
  const found: Candidate[] = [];
  for (const match of text.matchAll(MEASUREMENT)) {
    const raw = match[1];
    const index = match.index!;
    const before = text[index - 1] ?? "";
    const after = text[index + raw.length] ?? "";
    // A number welded to a date or a clock time is not a measurement:
    // "2026-09-19", "19/09", "14:30".
    if ("-/:" .includes(before) || "-/:".includes(after)) continue;
    found.push({ raw, value: normalize(raw), at: index });
  }
  return found;
}

/** Every number a tool returned, in the forms an answer might quote it in. */
function supportedFigures(outputs: string[]) {
  const supported = new Set<string>();
  for (const output of outputs) {
    if (!output) continue;
    for (const match of output.matchAll(/\d[\d,]*\.?\d*/g)) {
      const value = normalize(match[0]);
      supported.add(value);
      supported.add(value.replace(/\.0+$/, ""));
      supported.add(String(Number(value)));
    }
  }
  return supported;
}

/**
 * Figures in `answer` that no tool output supports.
 *
 * `outputs` is everything the tools returned, as the model saw it: the JSON of
 * each result and any rendered artifact.
 */
export function unsupportedFigures(answer: string, outputs: string[]): string[] {
  if (!answer.trim()) return [];
  const supported = supportedFigures(outputs);
  const missing = new Map<string, number>();
  for (const candidate of candidates(answer)) {
    if (supported.has(candidate.value) || supported.has(String(Number(candidate.value)))) continue;
    // 4,714 quoted as 4,700 or as 4.7K.
    const numeric = Number(candidate.value);
    if (Number.isFinite(numeric) && [...supported].some(value => Math.abs(Number(value) - numeric) < Math.max(1, numeric * 0.005)))
      continue;
    if (!missing.has(candidate.value)) missing.set(candidate.value, candidate.at);
  }
  return [...missing.entries()].sort((a, b) => a[1] - b[1]).map(([key]) => {
    const match = candidates(answer).find(candidate => candidate.value === key);
    return match?.raw ?? key;
  });
}
