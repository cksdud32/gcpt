import { RevisionStore } from "../RevisionStore.js";
import { Revision, DiscussionBudget, DEPTH_BUDGETS } from "../types.js";
import { Metrics } from "../metrics.js";
import { getModeInstruction } from "./mode-instruction.js";

// ─── 파서 ─────────────────────────────────────────────────────────

interface ProposalResponse {
  value: string;
  reason: string;
  rationale: string;
}

// ─── JSON sanitizer ──────────────────────────────────────────────
// Gemini가 code fence를 붙이거나 응답이 잘릴 경우를 복구한다.

function sanitizeJson(raw: string): string {
  // 1. 코드펜스 + 리터럴 개행 제거
  let s = raw.replace(/```json\s*|```\s*/g, "").trim().replace(/[\r\n]/g, " ");

  // 2. 이미 닫혀 있으면 그대로 반환
  if (s.endsWith("}")) return s;

  // 3. Truncation 복구: trailing comma / 미닫힌 문자열 / 미닫힌 객체 처리
  s = s.replace(/,\s*$/, ""); // 후행 콤마 제거

  // 홀수 개의 비이스케이프 따옴표 → 마지막 문자열이 잘림
  const quoteCount = (s.match(/(?<!\\)"/g) ?? []).length;
  if (quoteCount % 2 !== 0) s += '"';

  // 객체 닫기
  if (!s.endsWith("}")) s += "}";

  return s;
}

function parseResponse(raw: string): ProposalResponse | null {
  try {
    const json = JSON.parse(sanitizeJson(raw));
    if (typeof json.value !== "string" || json.value.trim() === "") return null;
    if (typeof json.reason !== "string" || json.reason.trim() === "") return null;
    return {
      value:     json.value.trim().slice(0, 60),   // 과도한 길이 방지
      reason:    json.reason.trim().slice(0, 120),
      rationale: typeof json.rationale === "string" ? json.rationale.trim().slice(0, 200) : "",
    };
  } catch {
    return null;
  }
}

function buildContext(store: RevisionStore, capturedGoalRevId: number): string {
  const history = store.getHistory();
  const start   = history.findIndex((r) => r.id === capturedGoalRevId);
  const topicRevs = start >= 0 ? history.slice(start) : [];
  return topicRevs
    .filter((r) => r.patch.payload.type === "propose_decision" || r.patch.payload.type === "propose_alternative")
    .map((r) => {
      const p = r.patch.payload as { value: string; reason: string };
      return `- [${r.author}] ${p.value}: ${p.reason}`;
    })
    .join("\n");
}

// ─── 모델 목록 ────────────────────────────────────────────────────
//
// 기본 chain: gemini-2.5-flash → gemini-2.0-flash (1.5-flash는 현재 404)
// 환경변수로 override:
//   GEMINI_MODEL=gemini-2.5-flash
//   GEMINI_FALLBACK_MODELS=gemini-2.0-flash  (콤마 구분, 없으면 기본값)

function getModelList(): string[] {
  const primary     = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
  const fallbackEnv = (process.env.GEMINI_FALLBACK_MODELS ?? "").trim();
  // 기본 fallback은 2.0-flash 하나만 (1.5-flash는 현재 404)
  const fallbacks = fallbackEnv
    ? fallbackEnv.split(",").map(s => s.trim()).filter(Boolean)
    : ["gemini-2.0-flash"];

  return [primary, ...fallbacks].filter((m, i, arr) => arr.indexOf(m) === i);
}

// ─── HTTP 오류 타입 ───────────────────────────────────────────────

class GeminiHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "GeminiHttpError";
  }
}

// 재시도 대상 상태 코드
const RETRYABLE = new Set([429, 503]);
// 모델별 재시도 대기 시간 (ms): 1차 재시도 전 500ms (Live mode RPM 절약을 위해 1회만)
const RETRY_DELAYS = [500];

// ─── 단일 HTTP 호출 ───────────────────────────────────────────────

interface GeminiBody {
  candidates?: Array<{ content: { parts: Array<{ text: string }> } }>;
  usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number };
}

async function callGeminiOnce(apiKey: string, model: string, prompt: string): Promise<GeminiBody> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: 4096,  // thinking tokens 포함 여유값; 실응답은 ~200 tokens
        temperature: 0.7,
        responseMimeType: "application/json",
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new GeminiHttpError(res.status, `HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<GeminiBody>;
}

// ─── Fallback + Retry 래퍼 ────────────────────────────────────────
//
// 동작:
//   모델 목록을 순서대로 시도.
//   각 모델에서 503/429 → 최대 1회 재시도 (총 2회 시도).
//   404          → 해당 모델 즉시 스킵, 다음 모델로.
//   기타 오류    → 다음 모델로.
//   모든 모델 실패 → 마지막 오류 throw.
//
// canAttempt(): 매 HTTP 요청 직전 호출 — false 시 즉시 중단 (예산 초과)
// onAttempt():  매 HTTP 요청 시 호출 — calls++, total++ 용도

async function callGeminiWithFallback(
  apiKey:     string,
  prompt:     string,
  canAttempt: () => boolean,
  onAttempt:  () => void,
): Promise<{ body: GeminiBody; model: string; totalAttempts: number }> {
  const models = getModelList();
  let lastError: Error = new Error("no Gemini models available");
  let totalAttempts = 0;
  const maxAttemptsPerModel = 1 + RETRY_DELAYS.length; // 2 (1 initial + 1 retry)

  for (let mi = 0; mi < models.length; mi++) {
    const model = models[mi];
    const hasNext = mi + 1 < models.length;

    for (let attempt = 0; attempt < maxAttemptsPerModel; attempt++) {
      if (!canAttempt()) {
        throw new Error("Gemini run call limit reached — aborting");
      }
      onAttempt();
      totalAttempts++;

      try {
        const body = await callGeminiOnce(apiKey, model, prompt);
        return { body, model, totalAttempts };

      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const status = err instanceof GeminiHttpError ? err.status : 0;

        if (status === 404) {
          // 모델 없음 — retry 없이 즉시 다음 모델
          if (hasNext) {
            console.warn(`[Gemini] model ${model} not found (404), trying fallback ${models[mi + 1]}...`);
          }
          break; // 이 모델의 retry loop 종료
        }

        if (RETRYABLE.has(status)) {
          const nextAttempt = attempt + 1;
          if (nextAttempt < maxAttemptsPerModel) {
            // 아직 retry 가능
            const delay = RETRY_DELAYS[attempt];
            console.warn(
              `[Gemini] temporary unavailable (${status}), retrying ${nextAttempt}/${RETRY_DELAYS.length}... (${delay}ms)`,
            );
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          // retry 소진 → 다음 모델로
          if (hasNext) {
            console.warn(`[Gemini] model ${model} unavailable (${status}), trying fallback ${models[mi + 1]}...`);
          }
          break;
        }

        // 재시도 불가 오류 → 다음 모델로
        break;
      }
    }
  }

  throw lastError;
}

// ─── 디버그: 모델 목록 조회 ──────────────────────────────────────

export async function listGeminiModels(apiKey: string): Promise<void> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
  );
  if (!res.ok) {
    console.error("[Gemini] listModels failed:", res.status, await res.text().catch(() => ""));
    return;
  }
  const json = await res.json() as { models?: Array<{ name: string; supportedGenerationMethods?: string[] }> };
  const list = (json.models ?? [])
    .filter(m => m.supportedGenerationMethods?.includes("generateContent"))
    .map(m => m.name.replace("models/", ""));
  console.log("[Gemini] available generateContent models:\n ", list.join("\n  "));
}

// ─── RealGeminiWorker ─────────────────────────────────────────────

export class RealGeminiWorker {
  private spokenAt        = new Map<number, number>();
  private permanentlyFailed = new Set<number>(); // 429 소진된 goalRevId — 재시도 차단
  private callCount       = 0; // 실제 HTTP 요청 수 (retry + fallback 포함)

  private readonly maxPerTopic: number;
  private readonly maxPerRun:   number;

  constructor(
    private apiKey: string,
    private store:  RevisionStore,
    private metrics?: Metrics,
    budget?: DiscussionBudget,
  ) {
    const rounds = budget?.maxRoundsPerWorker ?? DEPTH_BUDGETS.balanced.maxRoundsPerWorker;
    this.maxPerTopic = rounds;
    // maxPerRun: goal 수 × rounds 기준으로 확보, 최소 8
    this.maxPerRun = Math.max(8, rounds * 3);
    const models = getModelList();
    console.log(`[Gemini] model chain: ${models.join(" → ")}  maxPerTopic=${this.maxPerTopic} maxPerRun=${this.maxPerRun}`);
  }

  async handle(rev: Revision, capturedGoalRevId: number | null): Promise<void> {
    if (rev.author === "gemini" || capturedGoalRevId === null) return;

    const type = rev.patch.payload.type;
    if (type !== "propose_decision" && type !== "propose_alternative") return;
    if (rev.author !== "gpt") return;

    // 이미 rate-limit 소진된 goal은 재시도하지 않음
    if (this.permanentlyFailed.has(capturedGoalRevId)) return;

    const count = this.spokenAt.get(capturedGoalRevId) ?? 0;
    if (count >= this.maxPerTopic) return;

    if (this.callCount >= this.maxPerRun) {
      console.warn(`[Gemini] run call limit (${this.maxPerRun}) reached — skipping`);
      return;
    }

    const history = this.store.getHistory();
    const goalRev = history.find((r) => r.id === capturedGoalRevId);
    if (!goalRev) return;
    const goalPayload = goalRev.patch.payload as { goal: string; mode?: string };
    const goal = goalPayload.goal;
    const modeInstruction = getModeInstruction(goalPayload.mode as Parameters<typeof getModeInstruction>[0]);

    const gptProposal = rev.patch.payload as { value: string; reason: string };
    const ctx = buildContext(this.store, capturedGoalRevId);

    const prompt =
      `You are a technical advisor in a team discussion.\n` +
      `${modeInstruction}\n` +
      `Language policy: respond in the same language as the goal. ` +
      `If the goal is in Korean, write value/reason/rationale in Korean. ` +
      `Technical terms (e.g. PostgreSQL, NLP, OAuth2) may stay in English.\n` +
      `Goal: "${goal}"\n` +
      `GPT proposed: "${gptProposal.value}" — ${gptProposal.reason}\n` +
      (ctx ? `Other proposals:\n${ctx}\n` : "") +
      `\nFind ONE weakness of GPT's proposal and suggest a better alternative.\n` +
      `Return ONLY valid JSON (no markdown, no code fences, no extra text).\n` +
      `Schema: {"value":"string","reason":"string","rationale":"string"}\n` +
      `STRICT length limits: value ≤ 30 chars, reason ≤ 60 chars, rationale ≤ 120 chars.`;

    // spokenAt 선점 (최종 실패 시 롤백)
    this.spokenAt.set(capturedGoalRevId, count + 1);

    const t0 = Date.now();

    try {
      const { body, model, totalAttempts } = await callGeminiWithFallback(
        this.apiKey,
        prompt,
        () => this.callCount < this.maxPerRun,
        () => {
          this.callCount++;
          if (this.metrics) this.metrics.calls.gemini.total++;
        },
      );

      // 성공
      if (this.metrics) {
        this.metrics.latencyMs.push(Date.now() - t0);
        if (body.usageMetadata) {
          this.metrics.tokens.prompt     += body.usageMetadata.promptTokenCount     ?? 0;
          this.metrics.tokens.completion += body.usageMetadata.candidatesTokenCount ?? 0;
        }
      }

      const raw    = body.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      const parsed = parseResponse(raw);

      if (!parsed) {
        const truncated = raw.length > 0 && !raw.trim().endsWith("}");
        console.error(
          `[Gemini] parseFail (goalRevId=${capturedGoalRevId}): ${raw.slice(0, 200)}` +
          (truncated ? "\n[Gemini] Response appears truncated. Increase maxOutputTokens." : ""),
        );
        if (this.metrics) this.metrics.calls.gemini.parseFail++;
        this.spokenAt.set(capturedGoalRevId, count); // rollback
        return;
      }

      if (this.metrics) this.metrics.calls.gemini.parseOk++;
      const attemptSuffix = totalAttempts > 1 ? `  (model=${model}, attempts=${totalAttempts})` : "";
      console.log(`[Gemini] ok  goal="${goal}"  value="${parsed.value}"${attemptSuffix}`);

      this.store.append("gemini", {
        type: "propose_alternative",
        references: [rev.id],
        payload: { type: "propose_alternative", value: parsed.value, reason: parsed.reason },
        rationale: parsed.rationale || undefined,
      });

    } catch (err) {
      if (this.metrics) {
        this.metrics.latencyMs.push(Date.now() - t0);
        this.metrics.calls.gemini.apiError++;
      }
      console.error(
        `[Gemini] apiError (goalRevId=${capturedGoalRevId}):`,
        err instanceof Error ? err.message : err,
      );
      // Rate-limit 소진 시: goalRevId를 영구 차단 (spokenAt 롤백 안 함)
      // → 같은 goal에서 다시 시도하지 않아 429 폭주 방지
      const status = err instanceof GeminiHttpError ? err.status : 0;
      if (RETRYABLE.has(status)) {
        this.permanentlyFailed.add(capturedGoalRevId);
        console.warn(`[Gemini] rate-limit exhausted for goalRevId=${capturedGoalRevId}, skipping further attempts`);
      } else {
        this.spokenAt.set(capturedGoalRevId, count); // 일반 오류는 rollback 허용
      }
      // callCount는 롤백 안 함 — 실제 요청이 발생했으므로
    }
  }
}
