import OpenAI from "openai";
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
      `[buildContext][GPT] 오염 감지: goalRevId=${capturedGoalRevId}에 ` +
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
Your role is to propose or counter-propose concrete technical solutions.
Be concise. Respond ONLY with valid JSON.`;

export class RealGPTWorker {
  private client: OpenAI;
  private spokenAt = new Map<number, number>();
  private readonly maxPerTopic = 2;

  constructor(apiKey: string, private store: RevisionStore, private metrics?: Metrics) {
    this.client = new OpenAI({ apiKey });
  }

  async handle(rev: Revision, capturedGoalRevId: number | null): Promise<void> {
    if (rev.author === "gpt" || capturedGoalRevId === null) return;

    const count = this.spokenAt.get(capturedGoalRevId) ?? 0;
    if (count >= this.maxPerTopic) return;

    const type = rev.patch.payload.type;
    const history = this.store.getHistory();
    const goalRev = history.find((r) => r.id === capturedGoalRevId);
    if (!goalRev) return;
    const goal = (goalRev.patch.payload as { goal: string }).goal;

    let prompt: string;

    if (type === "set_goal") {
      prompt = `Goal to decide: "${goal}"\n\nPropose ONE concrete technology/solution.`;
    } else if (type === "propose_alternative" && rev.author === "claude") {
      const p = rev.patch.payload as { value: string; reason: string };
      const ctx = buildContext(this.store, capturedGoalRevId);
      prompt = `Goal: "${goal}"\n\nExisting proposals:\n${ctx}\n\nClaude just proposed "${p.value}" (${p.reason}).\nExplain a specific weakness of Claude's proposal, then propose a different alternative.`;
    } else {
      return;
    }

    this.spokenAt.set(capturedGoalRevId, count + 1);
    if (this.metrics) this.metrics.calls.gpt.total++;

    const t0 = Date.now();
    try {
      const res = await this.client.chat.completions.create({
        model: "gpt-4o-mini",
        max_tokens: 256,
        temperature: 0.7,
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: `${prompt}\n\nRespond with JSON:\n{"value":"technology name","reason":"one-line (max 20 words)","rationale":"your reasoning (max 50 words)"}`,
          },
        ],
      });

      if (this.metrics) {
        this.metrics.latencyMs.push(Date.now() - t0);
        this.metrics.tokens.prompt     += res.usage?.prompt_tokens ?? 0;
        this.metrics.tokens.completion += res.usage?.completion_tokens ?? 0;
      }

      const raw = res.choices[0]?.message?.content ?? "";
      const parsed = parseResponse(raw);

      if (!parsed) {
        console.error(`[GPT] parseFail (goalRevId=${capturedGoalRevId}): ${raw.slice(0, 120)}`);
        if (this.metrics) this.metrics.calls.gpt.parseFail++;
        this.spokenAt.set(capturedGoalRevId, count); // rollback
        return;
      }

      if (this.metrics) this.metrics.calls.gpt.parseOk++;

      const patchType = type === "set_goal" ? "propose_decision" : "propose_alternative";
      const refs = type === "propose_alternative" ? [rev.id] : undefined;

      this.store.append("gpt", {
        type: patchType,
        references: refs,
        payload: { type: patchType, value: parsed.value, reason: parsed.reason },
        rationale: parsed.rationale || undefined,
      });
    } catch (err) {
      console.error(`[GPT] apiError (goalRevId=${capturedGoalRevId}):`, err instanceof Error ? err.message : err);
      if (this.metrics) this.metrics.calls.gpt.apiError++;
      this.spokenAt.set(capturedGoalRevId, count); // rollback
    }
  }
}
