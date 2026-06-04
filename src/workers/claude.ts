import Anthropic from "@anthropic-ai/sdk";
import { RevisionStore } from "../RevisionStore.js";
import { Revision } from "../types.js";
import { Metrics } from "../metrics.js";

interface ProposalResponse {
  value: string;
  reason: string;
  rationale: string;
}

function parseResponse(raw: string): ProposalResponse | null {
  try {
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const json = JSON.parse(cleaned);
    if (typeof json.value !== "string" || json.value.trim() === "") return null;
    if (typeof json.reason !== "string" || json.reason.trim() === "") return null;
    return {
      value: json.value.trim(),
      reason: json.reason.trim(),
      rationale: typeof json.rationale === "string" ? json.rationale.trim() : "",
    };
  } catch {
    return null;
  }
}

function buildContext(store: RevisionStore, capturedGoalRevId: number): string {
  const history = store.getHistory();
  const start = history.findIndex((r) => r.id === capturedGoalRevId);
  const topicRevs = start >= 0 ? history.slice(start) : [];

  const foreign = topicRevs.filter(
    (r) => r.patch.payload.type === "set_goal" && r.id !== capturedGoalRevId
  );
  if (foreign.length > 0) {
    console.warn(
      `[buildContext][Claude] 오염 감지: goalRevId=${capturedGoalRevId}에 ` +
      `다른 topic set_goal ${foreign.length}개 포함 (ids: ${foreign.map(r => r.id).join(",")})`
    );
  }

  return topicRevs
    .filter((r) => r.patch.payload.type === "propose_decision" || r.patch.payload.type === "propose_alternative")
    .map((r) => {
      const p = r.patch.payload as { value: string; reason: string };
      return `- [${r.author}] ${p.value}: ${p.reason}`;
    })
    .join("\n");
}

const SYSTEM = `You are a technical advisor in a multi-AI decision system.
Your role is to provide thoughtful counter-proposals to existing suggestions.
First identify a specific weakness of the previous proposal, then suggest a better alternative.
Be concise. Respond ONLY with valid JSON.`;

export class RealClaudeWorker {
  private client: Anthropic;
  private spokenAt = new Map<number, number>();
  private readonly maxPerTopic = 2;

  constructor(apiKey: string, private store: RevisionStore, private metrics?: Metrics) {
    this.client = new Anthropic({ apiKey });
  }

  async handle(rev: Revision, capturedGoalRevId: number | null): Promise<void> {
    if (rev.author === "claude" || capturedGoalRevId === null) return;

    const type = rev.patch.payload.type;
    if (type !== "propose_decision" && type !== "propose_alternative") return;
    if (rev.author !== "gpt") return;

    const count = this.spokenAt.get(capturedGoalRevId) ?? 0;
    if (count >= this.maxPerTopic) return;

    const history = this.store.getHistory();
    const goalRev = history.find((r) => r.id === capturedGoalRevId);
    if (!goalRev) return;
    const goal = (goalRev.patch.payload as { goal: string }).goal;

    const gptProposal = rev.patch.payload as { value: string; reason: string };
    const ctx = buildContext(this.store, capturedGoalRevId);

    this.spokenAt.set(capturedGoalRevId, count + 1);
    if (this.metrics) this.metrics.calls.claude.total++;

    const t0 = Date.now();
    try {
      const res = await this.client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 256,
        temperature: 0.7,
        system: SYSTEM,
        messages: [
          {
            role: "user",
            content: `Goal: "${goal}"\n\nExisting proposals:\n${ctx}\n\nGPT proposed "${gptProposal.value}" (${gptProposal.reason}).\n\nIdentify one specific weakness of GPT's proposal, then propose a better alternative.\n\nRespond with JSON:\n{"value":"technology name","reason":"one-line (max 20 words)","rationale":"weakness of GPT proposal + why yours is better (max 50 words)"}`,
          },
        ],
      });

      if (this.metrics) {
        this.metrics.latencyMs.push(Date.now() - t0);
        this.metrics.tokens.prompt     += res.usage.input_tokens;
        this.metrics.tokens.completion += res.usage.output_tokens;
      }

      const block = res.content[0];
      if (block.type !== "text") {
        console.error(`[Claude] unexpected response type (goalRevId=${capturedGoalRevId}):`, block.type);
        if (this.metrics) this.metrics.calls.claude.parseFail++;
        this.spokenAt.set(capturedGoalRevId, count);
        return;
      }

      const parsed = parseResponse(block.text);

      if (!parsed) {
        console.error(`[Claude] parseFail (goalRevId=${capturedGoalRevId}): ${block.text.slice(0, 120)}`);
        if (this.metrics) this.metrics.calls.claude.parseFail++;
        this.spokenAt.set(capturedGoalRevId, count); // rollback
        return;
      }

      if (this.metrics) this.metrics.calls.claude.parseOk++;

      this.store.append("claude", {
        type: "propose_alternative",
        references: [rev.id],
        payload: { type: "propose_alternative", value: parsed.value, reason: parsed.reason },
        rationale: parsed.rationale || undefined,
      });
    } catch (err) {
      console.error(`[Claude] apiError (goalRevId=${capturedGoalRevId}):`, err instanceof Error ? err.message : err);
      if (this.metrics) this.metrics.calls.claude.apiError++;
      this.spokenAt.set(capturedGoalRevId, count);
    }
  }
}
