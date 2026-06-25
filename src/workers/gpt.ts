import OpenAI from "openai";
import { RevisionStore } from "../RevisionStore.js";
import { Revision, DiscussionBudget, DEPTH_BUDGETS, StanceAction } from "../types.js";
import { Metrics } from "../metrics.js";
import { getModeInstruction } from "./mode-instruction.js";
import {
  findCurrentSegmentStartRevId,
  buildSegmentContext,
  getSegmentPriorProposals,
} from "./segment-context.js";

const VALID_STANCE_ACTIONS = new Set<string>(["defend", "refine", "concede", "propose"]);

interface ProposalResponse {
  value: string;
  reason: string;
  rationale: string;
  stanceAction?: StanceAction;
}

function extractJson(raw: string): string {
  let s = raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
  const start = s.indexOf("{");
  const end   = s.lastIndexOf("}");
  if (start !== -1 && end > start) s = s.slice(start, end + 1);
  s = s.replace(/[\r\n]/g, " ");
  s = s.replace(/,(\s*[}\]])/g, "$1");
  return s;
}

function parseResponse(raw: string): ProposalResponse | null {
  try {
    const json = JSON.parse(extractJson(raw));
    if (typeof json.value !== "string" || json.value.trim() === "") return null;
    if (typeof json.reason !== "string" || json.reason.trim() === "") return null;
    const stanceAction: StanceAction | undefined =
      typeof json.stanceAction === "string" && VALID_STANCE_ACTIONS.has(json.stanceAction)
        ? json.stanceAction as StanceAction
        : undefined;
    return {
      value: json.value.trim(),
      reason: json.reason.trim(),
      rationale: typeof json.rationale === "string" ? json.rationale.trim() : "",
      stanceAction,
    };
  } catch {
    return null;
  }
}


const SYSTEM = `You are a technical advisor in a multi-AI decision system.
Your role is to propose or counter-propose concrete solutions.

OUTPUT FORMAT — strictly required:
- Output ONLY a single raw JSON object. No markdown, no code fences, no explanation text.
- Start your response with { and end with }. Nothing before or after.
- Schema: {"value":"string","reason":"string","rationale":"string","stanceAction":"defend|refine|concede|propose"}

CRITICAL LANGUAGE RULE — strictly follow:
- Detect the language of the "Goal" in the user message.
- If the goal is in Korean: ALL fields (value, reason, rationale) MUST be written in Korean.
- If the goal is in English: ALL fields MUST be written in English.
- Only technical proper nouns (e.g. PostgreSQL, OAuth2, React, NLP) may remain in English inside a Korean response.
- Never mix languages within a single field.`;

export class RealGPTWorker {
  private client: OpenAI;
  private spokenAt = new Map<number, number>();
  private respondedInterjections = new Set<number>(); // interjection rev.id
  private maxPerTopic: number;
  private maxDistinctProposals: number;
  private phaseInstruction = "";
  private memoryContext    = "";

  setPhaseInstruction(s: string): void { this.phaseInstruction = s; }
  setMemoryContext(ctx: string):   void { this.memoryContext    = ctx; }
  setDiscussionBudget(budget: DiscussionBudget): void {
    this.maxPerTopic          = budget.maxRoundsPerWorker;
    this.maxDistinctProposals = budget.maxDistinctProposals;
  }
  private phaseNote(): string {
    return this.phaseInstruction ? `\n${this.phaseInstruction}\n` : "";
  }

  constructor(apiKey: string, private store: RevisionStore, private metrics?: Metrics, budget?: DiscussionBudget, private model = "gpt-5-mini") {
    this.client = new OpenAI({ apiKey });
    this.maxPerTopic         = budget?.maxRoundsPerWorker   ?? DEPTH_BUDGETS.balanced.maxRoundsPerWorker;
    this.maxDistinctProposals = budget?.maxDistinctProposals ?? DEPTH_BUDGETS.balanced.maxDistinctProposals;
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

    // 현재 세그먼트 시작 rev ID — 이전 세그먼트 proposal이 context에 섞이지 않도록
    const segmentStartRevId = findCurrentSegmentStartRevId(this.store, capturedGoalRevId);

    let prompt: string;
    let patchType: "propose_decision" | "propose_alternative";
    let refs: number[] | undefined;
    let rollback: () => void;

    if (type === "user_interjection") {
      // 결정 이후 재토론 — spokenAt 제한 없이 별도 추적
      if (this.respondedInterjections.has(rev.id)) return;
      this.respondedInterjections.add(rev.id);
      const msg = (rev.patch.payload as { message: string }).message;
      const ctx = buildSegmentContext(this.store, capturedGoalRevId, segmentStartRevId, this.memoryContext);
      prompt =
        `${modeInstruction}\n\nGoal: "${goal}"\n\n${ctx}\n\n` +
        `User raised: "${msg}"\n\n` +
        `Continue the discussion by addressing the user's point. Propose a concrete response.\n` +
        `IMPORTANT: The goal is in ${/[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(goal) ? "Korean — respond entirely in Korean" : "English — respond in English"}.`;
      patchType = "propose_alternative";
      refs = [rev.id];
      rollback = () => this.respondedInterjections.delete(rev.id);

    } else if (type === "set_goal") {
      const count = this.spokenAt.get(capturedGoalRevId) ?? 0;
      if (count >= this.maxPerTopic) return;
      const memNote = this.memoryContext
        ? `\n[이전 토론 기억 — 참고만]\n${this.memoryContext}\n`
        : "";
      prompt =
        `${modeInstruction}\n${this.phaseNote()}${memNote}\n` +
        `Goal: "${goal}"\n\n` +
        `Propose ONE concrete solution.\n` +
        `IMPORTANT: The goal above is in ${/[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(goal) ? "Korean — respond entirely in Korean" : "English — respond in English"}.`;
      patchType = "propose_decision";
      refs = undefined;
      this.spokenAt.set(capturedGoalRevId, count + 1);
      rollback = () => this.spokenAt.set(capturedGoalRevId, count);

    } else if (type === "propose_alternative" && (rev.author === "claude" || rev.author === "gemini")) {
      const count = this.spokenAt.get(capturedGoalRevId) ?? 0;
      if (count >= this.maxPerTopic) return;
      const p = rev.patch.payload as { value: string; reason: string };
      const ctx = buildSegmentContext(this.store, capturedGoalRevId, segmentStartRevId, this.memoryContext);
      const counterName = rev.author === "gemini" ? "Gemini" : "Claude";

      // 내 이전 발언 파악 → defend/concede/propose 계층 prompt (현재 세그먼트만)
      const myPrior = getSegmentPriorProposals(this.store, "gpt", capturedGoalRevId, segmentStartRevId);
      const myLast  = myPrior[myPrior.length - 1];
      const distinctCount = new Set(myPrior.map(p => p.value.trim().toLowerCase())).size;
      const limitReached  = distinctCount >= this.maxDistinctProposals;

      const langNote = /[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(goal)
        ? "IMPORTANT: Respond entirely in Korean.\n"
        : "";

      if (myLast) {
        const limitNote = limitReached
          ? `\n⚠ You have already introduced ${distinctCount} distinct option(s). You MUST choose DEFEND or CONCEDE — do NOT propose another new option.\n`
          : "";
        prompt =
          `${modeInstruction}\n${langNote}${this.phaseNote()}\nGoal: "${goal}"\n\n` +
          `Your current position: "${myLast.value}" — ${myLast.reason}\n` +
          `${counterName} challenges: "${p.value}" — ${p.reason}\n\n` +
          `Full discussion:\n${ctx}\n` +
          `${limitNote}\n` +
          `Deliberation rule (follow in priority order):\n` +
          `1. DEFEND — "${myLast.value}" is still the best choice. Provide a NEW argument not yet stated. (respond with value="${myLast.value}")\n` +
          `2. CONCEDE — ${counterName}'s proposal is genuinely stronger. Acknowledge it. (respond with value="${p.value}")\n` +
          `3. PROPOSE — Neither proposal satisfies the goal's constraints. Introduce a clearly different option. (only if NOT limit-reached)\n` +
          `\nPrefer 1 or 2. Avoid 3 unless there is a strong, specific reason.`;
      } else {
        prompt =
          `${modeInstruction}\n${langNote}${this.phaseNote()}\nGoal: "${goal}"\n\nExisting proposals:\n${ctx}\n\n` +
          `${counterName} just proposed "${p.value}" (${p.reason}).\n` +
          `Explain a specific weakness of ${counterName}'s proposal, then propose a concrete alternative.`;
      }
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
        model: this.model,
        max_tokens: 512,
        temperature: 0.7,
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: `${prompt}\n\nOutput JSON only (no prose, no code fences):\n{"value":"...","reason":"...","rationale":"...","stanceAction":"defend|refine|concede|propose"}`,
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

      console.log("[worker append]", { expectedAuthor: "gpt", provider: "gpt", type: patchType, value: parsed.value.slice(0, 30) });
      this.store.append("gpt", {
        type: patchType,
        references: refs,
        payload: { type: patchType, value: parsed.value, reason: parsed.reason, stanceAction: parsed.stanceAction },
        rationale: parsed.rationale || undefined,
      });
    } catch (err) {
      console.error(`[GPT] apiError (goalRevId=${capturedGoalRevId}):`, err instanceof Error ? err.message : err);
      if (this.metrics) this.metrics.calls.gpt.apiError++;
      rollback();
    }
  }
}
