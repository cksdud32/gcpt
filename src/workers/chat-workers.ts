import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { RevisionStore } from "../RevisionStore.js";
import { Author, ProvidersConfig } from "../types.js";
import { Metrics } from "../metrics.js";

// ─── Shared ────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

const CHAT_SYSTEM = `You are participating in a casual multi-AI group conversation.
Be natural, warm, and genuinely conversational.

Rules (strictly follow):
- Do NOT debate, argue, critique, or evaluate others' ideas
- Do NOT try to reach consensus or propose a "best" answer
- DO react naturally: share thoughts, ask questions, relate to previous messages
- Keep responses to 1-3 sentences maximum
- Match the tone and energy of the conversation

Output ONLY valid JSON: {"value": "your message"}
No markdown, no code fences, nothing else.`;

function buildChatContext(store: RevisionStore, goalRevId: number): string {
  const history = store.getHistory();
  const start = history.findIndex(r => r.id === goalRevId);
  return (start >= 0 ? history.slice(start) : [])
    .filter(r => r.patch.payload.type === "chat_reply")
    .map(r => `[${r.author.toUpperCase()}] ${(r.patch.payload as { value: string }).value}`)
    .join("\n");
}

function getGoalText(store: RevisionStore, goalRevId: number): string {
  const rev = store.getHistory().find(r => r.id === goalRevId);
  return (rev?.patch.payload as { goal?: string })?.goal ?? "";
}

function parseChatResponse(raw: string): string | null {
  try {
    let s = raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const start = s.indexOf("{"); const end = s.lastIndexOf("}");
    if (start !== -1 && end > start) s = s.slice(start, end + 1);
    const json = JSON.parse(s.replace(/[\r\n]/g, " "));
    const v = typeof json.value === "string" ? json.value.trim() : "";
    return v || null;
  } catch {
    return null;
  }
}

function buildPrompt(myName: string, goal: string, ctx: string, isKorean: boolean): string {
  const lang = isKorean ? "Korean" : "English";
  return (
    `You are ${myName}.\n` +
    `Conversation topic: "${goal}"\n\n` +
    (ctx ? `What has been said so far:\n${ctx}\n\n` : "") +
    `Continue the conversation naturally as ${myName}. ` +
    `Respond in ${lang}. 1-3 sentences only.\n\n` +
    `Output JSON: {"value": "your message"}`
  );
}

// ─── ChatWorker interface ──────────────────────────────────────────

export interface ChatWorker {
  readonly name:   string;
  readonly author: Author;
  chatReply(store: RevisionStore, goalRevId: number, metrics: Metrics): Promise<void>;
}

// ─── GPT ──────────────────────────────────────────────────────────

export class ChatGPTWorker implements ChatWorker {
  readonly name   = "GPT";
  readonly author: Author = "gpt";
  private client: OpenAI | null;

  constructor(private apiKey: string, private model: string) {
    this.client = apiKey ? new OpenAI({ apiKey }) : null;
  }

  async chatReply(store: RevisionStore, goalRevId: number, metrics: Metrics): Promise<void> {
    const goal = getGoalText(store, goalRevId);
    const ctx  = buildChatContext(store, goalRevId);
    const isKorean = /[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(goal);

    if (!this.client) {
      await sleep(350);
      store.append("gpt", {
        type: "chat_reply",
        payload: { type: "chat_reply", value: isKorean ? "[Mock GPT] 흥미로운 주제네요!" : "[Mock GPT] Interesting topic!" },
      });
      return;
    }

    metrics.calls.gpt.total++;
    const t0 = Date.now();
    try {
      const res = await this.client.chat.completions.create({
        model: this.model,
        max_tokens: 256,
        temperature: 0.85,
        messages: [
          { role: "system", content: CHAT_SYSTEM },
          { role: "user",   content: buildPrompt("GPT", goal, ctx, isKorean) },
        ],
      });
      metrics.latencyMs.push(Date.now() - t0);
      metrics.tokens.prompt     += res.usage?.prompt_tokens     ?? 0;
      metrics.tokens.completion += res.usage?.completion_tokens ?? 0;

      const raw    = res.choices[0]?.message?.content ?? "";
      const parsed = parseChatResponse(raw);
      if (!parsed) {
        console.error(`[ChatGPT] parseFail: ${raw.slice(0, 100)}`);
        metrics.calls.gpt.parseFail++;
        return;
      }
      metrics.calls.gpt.parseOk++;
      store.append("gpt", { type: "chat_reply", payload: { type: "chat_reply", value: parsed } });
    } catch (err) {
      metrics.latencyMs.push(Date.now() - t0);
      metrics.calls.gpt.apiError++;
      console.error("[ChatGPT] apiError:", err instanceof Error ? err.message : err);
    }
  }
}

// ─── Claude ───────────────────────────────────────────────────────

export class ChatClaudeWorker implements ChatWorker {
  readonly name   = "Claude";
  readonly author: Author = "claude";
  private client: Anthropic | null;

  constructor(private apiKey: string, private model: string) {
    this.client = apiKey ? new Anthropic({ apiKey }) : null;
  }

  async chatReply(store: RevisionStore, goalRevId: number, metrics: Metrics): Promise<void> {
    const goal = getGoalText(store, goalRevId);
    const ctx  = buildChatContext(store, goalRevId);
    const isKorean = /[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(goal);

    if (!this.client) {
      await sleep(350);
      store.append("claude", {
        type: "chat_reply",
        payload: { type: "chat_reply", value: isKorean ? "[Mock Claude] 저도 그런 생각이 들었어요!" : "[Mock Claude] I was thinking the same!" },
      });
      return;
    }

    metrics.calls.claude.total++;
    const t0 = Date.now();
    try {
      const res = await this.client.messages.create({
        model: this.model,
        max_tokens: 256,
        temperature: 0.85,
        system: CHAT_SYSTEM,
        messages: [{ role: "user", content: buildPrompt("Claude", goal, ctx, isKorean) }],
      });
      metrics.latencyMs.push(Date.now() - t0);
      metrics.tokens.prompt     += res.usage.input_tokens;
      metrics.tokens.completion += res.usage.output_tokens;

      const block = res.content[0];
      if (block.type !== "text") { metrics.calls.claude.parseFail++; return; }
      const parsed = parseChatResponse(block.text);
      if (!parsed) {
        console.error(`[ChatClaude] parseFail: ${block.text.slice(0, 100)}`);
        metrics.calls.claude.parseFail++;
        return;
      }
      metrics.calls.claude.parseOk++;
      store.append("claude", { type: "chat_reply", payload: { type: "chat_reply", value: parsed } });
    } catch (err) {
      metrics.latencyMs.push(Date.now() - t0);
      metrics.calls.claude.apiError++;
      console.error("[ChatClaude] apiError:", err instanceof Error ? err.message : err);
    }
  }
}

// ─── Gemini ───────────────────────────────────────────────────────

interface GeminiChatResult {
  text: string;
  meta?: { promptTokenCount: number; candidatesTokenCount: number };
}

async function callGeminiChat(apiKey: string, model: string, prompt: string): Promise<GeminiChatResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: 512,
        temperature: 0.85,
        responseMimeType: "application/json",
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gemini HTTP ${res.status}: ${body.slice(0, 120)}`);
  }
  const json = await res.json() as {
    candidates?: Array<{ content: { parts: Array<{ text: string }> } }>;
    usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number };
  };
  return { text: json.candidates?.[0]?.content?.parts?.[0]?.text ?? "", meta: json.usageMetadata };
}

export class ChatGeminiWorker implements ChatWorker {
  readonly name   = "Gemini";
  readonly author: Author = "gemini";

  constructor(private apiKey: string, private model: string) {}

  async chatReply(store: RevisionStore, goalRevId: number, metrics: Metrics): Promise<void> {
    const goal = getGoalText(store, goalRevId);
    const ctx  = buildChatContext(store, goalRevId);
    const isKorean = /[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(goal);

    if (!this.apiKey) {
      await sleep(350);
      store.append("gemini", {
        type: "chat_reply",
        payload: { type: "chat_reply", value: isKorean ? "[Mock Gemini] 좋은 포인트예요!" : "[Mock Gemini] Good point!" },
      });
      return;
    }

    const prompt = buildPrompt("Gemini", goal, ctx, isKorean);
    metrics.calls.gemini.total++;
    const t0 = Date.now();
    try {
      const { text, meta } = await callGeminiChat(this.apiKey, this.model, prompt);
      metrics.latencyMs.push(Date.now() - t0);
      if (meta) {
        metrics.tokens.prompt     += meta.promptTokenCount     ?? 0;
        metrics.tokens.completion += meta.candidatesTokenCount ?? 0;
      }
      const parsed = parseChatResponse(text);
      if (!parsed) {
        console.error(`[ChatGemini] parseFail: ${text.slice(0, 100)}`);
        metrics.calls.gemini.parseFail++;
        return;
      }
      metrics.calls.gemini.parseOk++;
      store.append("gemini", { type: "chat_reply", payload: { type: "chat_reply", value: parsed } });
    } catch (err) {
      metrics.latencyMs.push(Date.now() - t0);
      metrics.calls.gemini.apiError++;
      console.error("[ChatGemini] apiError:", err instanceof Error ? err.message : err);
    }
  }
}

// ─── Factory ──────────────────────────────────────────────────────

export function buildChatWorkers(providers: ProvidersConfig): ChatWorker[] {
  const workers: ChatWorker[] = [];
  if (providers.gpt.enabled)    workers.push(new ChatGPTWorker(providers.gpt.apiKey,       providers.gpt.model));
  if (providers.claude.enabled) workers.push(new ChatClaudeWorker(providers.claude.apiKey, providers.claude.model));
  if (providers.gemini.enabled) workers.push(new ChatGeminiWorker(providers.gemini.apiKey, providers.gemini.model));
  return workers;
}
