/** Measurable properties of a spoken reply. These count things; they do not judge warmth. */
export interface StyleMetrics {
  words: number;
  sentences: number;
  /** Starts with a stock acknowledgement ("Certainly", "Of course", "Absolutely", "Sure"...). */
  stockOpener: boolean;
  questions: number;
  /** Markdown, lists, URLs, source labels, JSON or code-like text that would be read aloud. */
  unspeakable: boolean;
  /** Share of "is not / do not / I am"-style pairs written without contractions. */
  uncontracted: number;
  apologies: number;
  /** Mentions of internal steps or tool names. */
  narratesTools: boolean;
}

const STOCK = /^\s*(certainly|of course|absolutely|sure thing|sure|definitely|great question)\b/i;
const UNSPEAKABLE = /(\*\*|^\s*[-*•]\s|^\s*\d+[.)]\s|https?:\/\/|\[Source:|\{\s*"|```|#{1,6}\s)/m;
const UNCONTRACTED =
  /\b(I am|I will|I have|do not|does not|is not|are not|cannot|can not|it is|that is|you are|we are|I would)\b/gi;
const CONTRACTED = /\b\w+'(m|ll|ve|re|d|s|t)\b/gi;
const APOLOGY = /\b(sorry|apologi[sz]e|apologies)\b/gi;
const TOOLS =
  /\b(verify_customer|search_alternatives|change_flight|get_booking|get_bill|check_outage|tool|function call|my system|the system call)\b/i;

export function styleMetrics(reply: string): StyleMetrics {
  const words = reply.split(/\s+/).filter(Boolean).length;
  const sentences = (reply.match(/[.!?](\s|$)/g) ?? []).length || (words ? 1 : 0);
  const loose = (reply.match(UNCONTRACTED) ?? []).length;
  const tight = (reply.match(CONTRACTED) ?? []).length;
  return {
    words,
    sentences,
    stockOpener: STOCK.test(reply),
    questions: (reply.match(/\?/g) ?? []).length,
    unspeakable: UNSPEAKABLE.test(reply),
    uncontracted: loose + tight === 0 ? 0 : loose / (loose + tight),
    apologies: (reply.match(APOLOGY) ?? []).length,
    narratesTools: TOOLS.test(reply),
  };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const rate = (xs: boolean[]) => (xs.length ? xs.filter(Boolean).length / xs.length : 0);

export function summarizeStyle(all: StyleMetrics[]) {
  return {
    replies: all.length,
    meanWords: +mean(all.map((m) => m.words)).toFixed(1),
    meanSentences: +mean(all.map((m) => m.sentences)).toFixed(2),
    stockOpenerRate: +rate(all.map((m) => m.stockOpener)).toFixed(2),
    multiQuestionRate: +rate(all.map((m) => m.questions > 1)).toFixed(2),
    unspeakableRate: +rate(all.map((m) => m.unspeakable)).toFixed(2),
    uncontractedShare: +mean(all.map((m) => m.uncontracted)).toFixed(2),
    meanApologies: +mean(all.map((m) => m.apologies)).toFixed(2),
    narratesToolsRate: +rate(all.map((m) => m.narratesTools)).toFixed(2),
  };
}
