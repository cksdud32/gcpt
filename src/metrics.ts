export interface Metrics {
  calls: {
    gpt:    { total: number; parseOk: number; parseFail: number; apiError: number };
    claude: { total: number; parseOk: number; parseFail: number; apiError: number };
    gemini: { total: number; parseOk: number; parseFail: number; apiError: number };
  };
  latencyMs: number[];
  tokens: { prompt: number; completion: number };
  topics: { decided: number; undecided: number };
}

export function createMetrics(): Metrics {
  return {
    calls: {
      gpt:    { total: 0, parseOk: 0, parseFail: 0, apiError: 0 },
      claude: { total: 0, parseOk: 0, parseFail: 0, apiError: 0 },
      gemini: { total: 0, parseOk: 0, parseFail: 0, apiError: 0 },
    },
    latencyMs: [],
    tokens: { prompt: 0, completion: 0 },
    topics: { decided: 0, undecided: 0 },
  };
}

export function printMetrics(m: Metrics): void {
  const lat = m.latencyMs;
  const avgLat = lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : 0;
  const maxLat = lat.length ? Math.max(...lat) : 0;

  const gpt    = m.calls.gpt;
  const claude = m.calls.claude;
  const gemini = m.calls.gemini;

  console.log("\n──── Metrics ────────────────────────────────");
  console.log(`GPT    calls: ${gpt.total}  ok: ${gpt.parseOk}  parseFail: ${gpt.parseFail}  apiErr: ${gpt.apiError}`);
  console.log(`Claude calls: ${claude.total}  ok: ${claude.parseOk}  parseFail: ${claude.parseFail}  apiErr: ${claude.apiError}`);
  if (gemini.total > 0)
    console.log(`Gemini calls: ${gemini.total}  ok: ${gemini.parseOk}  parseFail: ${gemini.parseFail}  apiErr: ${gemini.apiError}`);
  console.log(`Latency (ms): avg=${avgLat}  max=${maxLat}  samples=${lat.length}`);
  console.log(`Tokens: prompt=${m.tokens.prompt}  completion=${m.tokens.completion}`);
  console.log(`Topics: decided=${m.topics.decided}  undecided=${m.topics.undecided}`);
  console.log("─────────────────────────────────────────────");
}
