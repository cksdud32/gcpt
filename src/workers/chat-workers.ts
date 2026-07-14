import { RevisionStore } from "../RevisionStore.js";
import { Author, ProviderName, ProviderSettings, ProvidersConfig } from "../types.js";
import { Metrics } from "../metrics.js";
import { PROVIDER_LABELS, PROVIDER_NAMES } from "../provider-config.js";
import { executeProviderRequest, normalizeApiError } from "../provider-runtime.js";

const CHAT_SYSTEM = `You are participating in a casual multi-AI group conversation. Be natural and concise (1-3 sentences). Output ONLY valid JSON: {"value":"your message"}`;

function parse(text: string): string | null {
  try { const value = (JSON.parse(text.replace(/```json\s*|```/g, "").trim()) as { value?: unknown }).value; return typeof value === "string" && value.trim() ? value.trim() : null; } catch { return null; }
}

function context(store: RevisionStore, goalRevId: number): { goal: string; discussion: string } {
  const history = store.getHistory();
  const start = history.findIndex(r => r.id === goalRevId);
  const slice = start < 0 ? [] : history.slice(start);
  const goal = (slice[0]?.patch.payload as { goal?: string } | undefined)?.goal ?? "";
  const discussion = slice.filter(r => r.patch.payload.type === "chat_reply").map(r => `${r.author}: ${(r.patch.payload as { value: string }).value}`).join("\n");
  return { goal, discussion };
}

export interface ChatWorker { readonly name: string; readonly author: Author; chatReply(store: RevisionStore, goalRevId: number, metrics: Metrics): Promise<void> }

class SharedChatWorker implements ChatWorker {
  readonly name: string;
  readonly author: Author;
  constructor(private provider: ProviderName, private config: ProviderSettings, private testMode: boolean) { this.name = PROVIDER_LABELS[provider]; this.author = provider; }
  async chatReply(store: RevisionStore, goalRevId: number, metrics: Metrics): Promise<void> {
    const { goal, discussion } = context(store, goalRevId);
    const prompt = `Goal: ${goal}\nConversation:\n${discussion || "(none yet)"}\nRespond naturally as ${this.name}. Output valid JSON.`;
    const t0 = Date.now();
    metrics.calls.gpt.total++;
    try {
      const result = await executeProviderRequest({ provider: this.provider, config: this.config, testMode: this.testMode, prompt, maxTokens: 512, temperature: 0.85, messages: [{ role: "system", content: CHAT_SYSTEM }, { role: "user", content: prompt }] });
      metrics.latencyMs.push(Date.now() - t0);
      metrics.tokens.prompt += result.promptTokens ?? 0; metrics.tokens.completion += result.completionTokens ?? 0;
      const value = parse(result.text) ?? (this.testMode ? result.text : null);
      if (!value) { metrics.calls.gpt.parseFail++; return; }
      metrics.calls.gpt.parseOk++;
      store.append(this.provider, { type: "chat_reply", payload: { type: "chat_reply", value } });
    } catch (error) { metrics.calls.gpt.apiError++; const normalized = normalizeApiError(error); console.error(`[Chat:${this.provider}]`, normalized.message); throw normalized; }
  }
}

export function buildChatWorkers(providers: ProvidersConfig): ChatWorker[] {
  return PROVIDER_NAMES.filter(provider => providers[provider].enabled).map(provider => new SharedChatWorker(provider, providers[provider], providers.testMode));
}
