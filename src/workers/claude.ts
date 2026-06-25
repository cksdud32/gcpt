import Anthropic from "@anthropic-ai/sdk";
import { RevisionStore } from "../RevisionStore.js";
import { Revision, DEPTH_BUDGETS, StanceAction } from "../types.js";
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
  // 코드펜스 제거
  let s = raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
  // JSON 객체 시작점 탐색
  const start = s.indexOf("{");
  if (start === -1) return s;
  // JSON 객체 끝점 탐색
  const end = s.lastIndexOf("}");
  if (end > start) {
    s = s.slice(start, end + 1);
  } else {
    // 닫는 } 없음 — 잘린 JSON 복구 시도
    s = s.slice(start);
    // 마지막 불완전 문자열 값 제거 (홀수 따옴표 처리)
    const quoteCount = (s.match(/(?<!\\)"/g) ?? []).length;
    if (quoteCount % 2 !== 0) s += '"';
    // trailing comma 제거 후 닫기
    s = s.replace(/,\s*$/, "");
    s += "}";
  }
  // 리터럴 개행 → 공백
  s = s.replace(/[\r\n]/g, " ");
  // trailing comma 제거
  s = s.replace(/,(\s*[}\]])/g, "$1");
  return s;
}

function parseResponse(raw: string): ProposalResponse | null {
  try {
    const json = JSON.parse(extractJson(raw));
    if (typeof json.value !== "string" || json.value.trim() === "") return null;
    if (typeof json.reason !== "string" || json.reason.trim() === "") return null;
    // stanceAction 누락 시 기본값 "propose" (잘린 응답에서도 최소 동작 보장)
    const stanceAction: StanceAction =
      typeof json.stanceAction === "string" && VALID_STANCE_ACTIONS.has(json.stanceAction)
        ? json.stanceAction as StanceAction
        : "propose";
    return {
      value:    json.value.trim().slice(0, 80),    // 한국어 기준 40자 ≈ UTF-16 80chars
      reason:   json.reason.trim().slice(0, 200),
      rationale: typeof json.rationale === "string" ? json.rationale.trim().slice(0, 400) : "",
      stanceAction,
    };
  } catch {
    return null;
  }
}


const SYSTEM = `You are a technical advisor in a multi-AI decision system.
Your role is to provide thoughtful counter-proposals to existing suggestions.
First identify a specific weakness of the previous proposal, then suggest a better alternative.

OUTPUT FORMAT — strictly required:
- Output ONLY a single raw JSON object. No markdown, no code fences, no explanation text.
- Start your response with { and end with }. Nothing before or after.
- Schema: {"value":"string","reason":"string","rationale":"string","stanceAction":"defend|refine|concede|propose"}
- Length limits (STRICTLY enforce — keep responses SHORT):
  value: max 40 chars (Korean) / 60 chars (English)
  reason: max 60 chars (Korean) / 80 chars (English)
  rationale: max 120 chars (Korean) / 160 chars (English)

CRITICAL LANGUAGE RULE — strictly follow:
- Detect the language of the "Goal" in the user message.
- If the goal is in Korean: ALL fields (value, reason, rationale) MUST be written in Korean.
- If the goal is in English: ALL fields MUST be written in English.
- Only technical proper nouns (e.g. PostgreSQL, OAuth2, React, NLP) may remain in English inside a Korean response.
- Never mix languages within a single field.`;

export class RealClaudeWorker {
  private client: Anthropic;
  private spokenAt = new Map<number, number>();
  private maxPerTopic:          number;
  private maxDistinctProposals: number;
  private phaseInstruction = "";
  private memoryContext    = "";

  setPhaseInstruction(s: string): void { this.phaseInstruction = s; }
  setMemoryContext(ctx: string):   void { this.memoryContext    = ctx; }
  setDiscussionBudget(budget: import("../types.js").DiscussionBudget): void {
    this.maxPerTopic          = budget.maxRoundsPerWorker;
    this.maxDistinctProposals = budget.maxDistinctProposals;
  }
  private phaseNote(): string {
    return this.phaseInstruction ? `\n${this.phaseInstruction}\n` : "";
  }

  constructor(apiKey: string, private store: RevisionStore, private metrics?: Metrics, budget?: import("../types.js").DiscussionBudget, private model = "claude-haiku-4-5-20251001") {
    this.client = new Anthropic({ apiKey });
    this.maxPerTopic          = budget?.maxRoundsPerWorker   ?? 2;
    this.maxDistinctProposals = budget?.maxDistinctProposals ?? DEPTH_BUDGETS.balanced.maxDistinctProposals;
  }

  async handle(rev: Revision, capturedGoalRevId: number | null): Promise<void> {
    if (rev.author === "claude" || capturedGoalRevId === null) return;

    const type = rev.patch.payload.type;
    if (type !== "propose_decision" && type !== "propose_alternative") return;

    const count = this.spokenAt.get(capturedGoalRevId) ?? 0;
    if (count >= this.maxPerTopic) return;

    const history = this.store.getHistory();
    const goalRev = history.find((r) => r.id === capturedGoalRevId);
    if (!goalRev) return;
    const goalPayload = goalRev.patch.payload as { goal: string; mode?: string };
    const goal = goalPayload.goal;
    const modeInstruction = getModeInstruction(goalPayload.mode as Parameters<typeof getModeInstruction>[0]);

    const challenger = rev.patch.payload as { value: string; reason: string };
    const challengerName = rev.author === "gemini" ? "Gemini" : "GPT";

    // 현재 세그먼트만 사용 — 이전 세그먼트 score 오염 방지
    const segmentStartRevId = findCurrentSegmentStartRevId(this.store, capturedGoalRevId);
    const ctx = buildSegmentContext(this.store, capturedGoalRevId, segmentStartRevId, this.memoryContext);

    // 내 이전 발언 파악 → defend/concede/propose 계층 prompt (현재 세그먼트만)
    const myPrior       = getSegmentPriorProposals(this.store, "claude", capturedGoalRevId, segmentStartRevId);
    const myLast        = myPrior[myPrior.length - 1];
    const distinctCount = new Set(myPrior.map(p => p.value.trim().toLowerCase())).size;
    const limitReached  = distinctCount >= this.maxDistinctProposals;

    const langNote = /[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(goal)
      ? "IMPORTANT: Respond entirely in Korean.\n"
      : "";

    let userContent: string;
    if (myLast) {
      const limitNote = limitReached
        ? `\n⚠ You have already introduced ${distinctCount} distinct option(s). You MUST choose DEFEND or CONCEDE — do NOT propose another new option.\n`
        : "";
      userContent =
        `${modeInstruction}\n${langNote}${this.phaseNote()}\nGoal: "${goal}"\n\n` +
        `Your current position: "${myLast.value}" — ${myLast.reason}\n` +
        `${challengerName} challenges: "${challenger.value}" — ${challenger.reason}\n\n` +
        `Full discussion:\n${ctx}\n` +
        `${limitNote}\n` +
        `Deliberation rule (follow in priority order):\n` +
        `1. DEFEND — "${myLast.value}" is still the best choice. Provide a NEW argument not yet stated. (respond with value="${myLast.value}")\n` +
        `2. CONCEDE — ${challengerName}'s proposal is genuinely stronger. Acknowledge it. (respond with value="${challenger.value}")\n` +
        `3. PROPOSE — Neither proposal satisfies the goal's constraints. Introduce a clearly different option. (only if NOT limit-reached)\n` +
        `\nPrefer 1 or 2. Avoid 3 unless there is a strong, specific reason.\n\n` +
        `Respond with JSON:\n{"value":"...","reason":"...","rationale":"...","stanceAction":"defend|refine|concede|propose"}`;
    } else {
      userContent =
        `${modeInstruction}\n${langNote}${this.phaseNote()}\nGoal: "${goal}"\n\nExisting proposals:\n${ctx}\n\n` +
        `${challengerName} proposed "${challenger.value}" (${challenger.reason}).\n\n` +
        `Identify one specific weakness of ${challengerName}'s proposal, then propose a better alternative.\n\n` +
        `Respond with JSON:\n{"value":"...","reason":"...","rationale":"...","stanceAction":"defend|refine|concede|propose"}`;
    }

    this.spokenAt.set(capturedGoalRevId, count + 1);
    if (this.metrics) this.metrics.calls.claude.total++;

    const t0 = Date.now();
    try {
      const res = await this.client.messages.create({
        model: this.model,
        max_tokens: 1200,
        temperature: 0.7,
        system: SYSTEM,
        messages: [
          {
            role: "user",
            content: userContent,
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
        // 전체 원문 출력 (120자 제한 제거) — extractJson 결과도 함께
        const extracted = extractJson(block.text);
        console.error(
          `[Claude] parseFail (goalRevId=${capturedGoalRevId})\n` +
          `  raw(${block.text.length}): ${block.text}\n` +
          `  extracted: ${extracted}`,
        );
        if (this.metrics) this.metrics.calls.claude.parseFail++;
        this.spokenAt.set(capturedGoalRevId, count); // rollback
        return;
      }

      if (this.metrics) this.metrics.calls.claude.parseOk++;

      // API 응답 대기 중 topic이 종료됐으면 append 하지 않음
      if (this.store.isTopicDecided(capturedGoalRevId)) {
        this.spokenAt.set(capturedGoalRevId, count); // rollback
        return;
      }

      console.log("[worker append]", { expectedAuthor: "claude", provider: "claude", type: "propose_alternative", value: parsed.value.slice(0, 30) });
      this.store.append("claude", {
        type: "propose_alternative",
        references: [rev.id],
        payload: { type: "propose_alternative", value: parsed.value, reason: parsed.reason, stanceAction: parsed.stanceAction },
        rationale: parsed.rationale || undefined,
      });
    } catch (err) {
      console.error(`[Claude] apiError (goalRevId=${capturedGoalRevId}):`, err instanceof Error ? err.message : err);
      if (this.metrics) this.metrics.calls.claude.apiError++;
      this.spokenAt.set(capturedGoalRevId, count);
    }
  }
}
