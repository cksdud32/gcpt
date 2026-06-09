import OpenAI from "openai";
import { RevisionStore } from "../RevisionStore.js";
import { Revision, DiscussionBudget, DEPTH_BUDGETS } from "../types.js";
import { Metrics } from "../metrics.js";
import { getModeInstruction } from "./mode-instruction.js";

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
Be concise. Respond ONLY with valid JSON.

Language policy: always respond in the same language as the user's goal.
If the goal is in Korean, write value/reason/rationale in Korean.
If the goal is in English, write in English.
Technical terms (e.g. PostgreSQL, NLP, OAuth2) may stay in English regardless.`;

export class RealGPTWorker {
  private client: OpenAI;
  private spokenAt = new Map<number, number>();
  private respondedInterjections = new Set<number>(); // interjection rev.id
  private readonly maxPerTopic: number;

  constructor(apiKey: string, private store: RevisionStore, private metrics?: Metrics, budget?: DiscussionBudget) {
    this.client = new OpenAI({ apiKey });
    this.maxPerTopic = budget?.maxRoundsPerWorker ?? DEPTH_BUDGETS.balanced.maxRoundsPerWorker;
  }

  async handle(rev: Revision, capturedGoalRevId: number | null): Promise<void> {
    if (rev.author === "gpt" || capturedGoalRevId === null) return;

    const type = rev.patch.payload.type;
    const history = this.store.getHistory();
    const goalRev = history.find((r) => r.id === capturedGoalRevId);
    if (!goalRev) return;
    const goalPayload = goalRev.patch.payload as { goal: string; mode?: string };
    const goal = goalPayload.goal;
    const modeInstruction = getModeInstruction(goalPayload.mode as Parameters<typeof getModeInstruction>[0]);

    // ── 케이스별 prompt / patchType / refs / rollback 결정 ──────────

    let prompt: string;
    let patchType: "propose_decision" | "propose_alternative";
    let refs: number[] | undefined;
    let rollback: () => void;

    if (type === "user_interjection") {
      // 결정 이후 재토론 — spokenAt 제한 없이 별도 추적
      if (this.respondedInterjections.has(rev.id)) return;
      this.respondedInterjections.add(rev.id);
      const msg = (rev.patch.payload as { message: string }).message;
      const ctx = buildContext(this.store, capturedGoalRevId);
      prompt =
        `${modeInstruction}\n\nGoal: "${goal}"\n\nDiscussion so far:\n${ctx}\n\n` +
        `User raised: "${msg}"\n\n` +
        `Continue the discussion by addressing the user's point. Propose a concrete response.`;
      patchType = "propose_alternative";
      refs = [rev.id];
      rollback = () => this.respondedInterjections.delete(rev.id);

    } else if (type === "set_goal") {
      const count = this.spokenAt.get(capturedGoalRevId) ?? 0;
      if (count >= this.maxPerTopic) return;
      prompt = `${modeInstruction}\n\nGoal to decide: "${goal}"\n\nPropose ONE concrete solution.`;
      patchType = "propose_decision";
      refs = undefined;
      this.spokenAt.set(capturedGoalRevId, count + 1);
      rollback = () => this.spokenAt.set(capturedGoalRevId, count);

    } else if (type === "propose_alternative" && (rev.author === "claude" || rev.author === "gemini")) {
      const count = this.spokenAt.get(capturedGoalRevId) ?? 0;
      if (count >= this.maxPerTopic) return;
      const p = rev.patch.payload as { value: string; reason: string };
      const ctx = buildContext(this.store, capturedGoalRevId);
      const counterName = rev.author === "gemini" ? "Gemini" : "Claude";
      prompt = `${modeInstruction}\n\nGoal: "${goal}"\n\nExisting proposals:\n${ctx}\n\n${counterName} just proposed "${p.value}" (${p.reason}).\nExplain a specific weakness of ${counterName}'s proposal, then propose a different alternative.`;
      patchType = "propose_alternative";
      refs = [rev.id];
      this.spokenAt.set(capturedGoalRevId, count + 1);
      rollback = () => this.spokenAt.set(capturedGoalRevId, count);

    } else {
      return;
    }

    // ── 공통 API 호출 ─────────────────────────────────────────────

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
        rollback();
        return;
      }

      if (this.metrics) this.metrics.calls.gpt.parseOk++;

      // API 응답 대기 중 topic이 결론 확정됐으면 append 하지 않음
      if (capturedGoalRevId !== null && this.store.isTopicDecided(capturedGoalRevId)) {
        rollback();
        return;
      }

      this.store.append("gpt", {
        type: patchType,
        references: refs,
        payload: { type: patchType, value: parsed.value, reason: parsed.reason },
        rationale: parsed.rationale || undefined,
      });
    } catch (err) {
      console.error(`[GPT] apiError (goalRevId=${capturedGoalRevId}):`, err instanceof Error ? err.message : err);
      if (this.metrics) this.metrics.calls.gpt.apiError++;
      rollback();
    }
  }
}
