/**
 * A thread title from the question itself.
 *
 * An LLM title call was the obvious choice and the wrong one: reasoning models
 * routinely spend the whole token budget thinking and return no text at all, so
 * the thread fell back to a truncated question anyway — after paying for the
 * call and waiting for it. Most chat products label a thread with the opening
 * message too.
 */
const FILLER =
  /^\s*(hey|hi|hello|ok|okay|please|can you|could you|would you|i want to|i'd like to|i need to|show me|tell me|what is|what are|how many|how much|give me|get me|the|a|an)\b[,\s]*/i;

/**
 * "Draw a line chart of daily sessions" is a request to draw, not what the
 * thread is about. Stripped the same way as filler, or every chart in the rail
 * reads the same and none of them say which data they hold.
 */
const CHART_REQUEST =
  /^\s*(?:draw|plot|chart|graph|visuali[sz]e|render)\s+(?:me\s+)?(?:an?\s+|the\s+)?(?:[a-z-]+\s+){0,2}?(?:chart|graph|plot|table|diagram|visuali[sz]ation)(?:\s+(?:of|for|with|about|showing))?\s+/i;

/** The same verb with no chart named after it: "chart weekly users by country". */
const BARE_CHART_VERB = /^\s*(?:chart|plot|graph)\s+(?!of\b|how\b|why\b|what\b|which\b|where\b)/i;

export function deriveTitle(question: string) {
  // "hey can you show me the top pages" is three layers of politeness deep.
  let cleaned = question;
  for (let stripped = 0; stripped < 4; stripped++) {
    const next = cleaned.replace(FILLER, "").replace(CHART_REQUEST, "").replace(BARE_CHART_VERB, "");
    if (next === cleaned) break;
    cleaned = next;
  }
  cleaned = cleaned.replace(/[?!.]+\s*$/, "").trim();
  const words = (cleaned || question.trim()).split(/\s+/).slice(0, 7).join(" ");
  const title = words.length > 60 ? `${words.slice(0, words.lastIndexOf(" ", 60))}…` : words;
  return title.charAt(0).toUpperCase() + title.slice(1);
}
