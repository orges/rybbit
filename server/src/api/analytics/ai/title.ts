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

export function deriveTitle(question: string) {
  // "hey can you show me the top pages" is three layers of politeness deep.
  let cleaned = question.replace(FILLER, "");
  for (let stripped = 0; stripped < 3 && FILLER.test(cleaned); stripped++) {
    cleaned = cleaned.replace(FILLER, "");
  }
  cleaned = cleaned.replace(/[?!.]+\s*$/, "").trim();
  const words = (cleaned || question.trim()).split(/\s+/).slice(0, 7).join(" ");
  const title = words.length > 60 ? `${words.slice(0, words.lastIndexOf(" ", 60))}…` : words;
  return title.charAt(0).toUpperCase() + title.slice(1);
}
