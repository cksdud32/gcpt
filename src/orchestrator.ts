import { RevisionStore } from "./RevisionStore.js";
import { Revision } from "./types.js";
import { selectByPolicy } from "./policy.js";
import { Metrics } from "./metrics.js";

const MAX_PROPOSALS_PER_WORKER = 2;

// ─── Mock 시뮬레이션 설정 ─────────────────────────────────────────

export interface MockConfig {
  latencyMs: number;        // 응답 지연 기본값 (±30% jitter 자동 적용)
  parseFailRate: number;    // 0.0~1.0: parseFail 발생 확률
  apiErrorRate: number;     // 0.0~1.0: apiError 발생 확률
  promptTokens: number;     // 시뮬레이션 prompt token
  completionTokens: number; // 시뮬레이션 completion token
}

export const MOCK_CONFIGS: Record<string, MockConfig> = {
  normal:    { latencyMs: 0,    parseFailRate: 0,    apiErrorRate: 0,    promptTokens: 200, completionTokens: 100 },
  parsefail: { latencyMs: 0,    parseFailRate: 0.5,  apiErrorRate: 0,    promptTokens: 200, completionTokens: 100 },
  apierror:  { latencyMs: 0,    parseFailRate: 0,    apiErrorRate: 0.4,  promptTokens: 0,   completionTokens: 0   },
  delay:     { latencyMs: 1000, parseFailRate: 0,    apiErrorRate: 0,    promptTokens: 200, completionTokens: 100 },
  mixed:     { latencyMs: 300,  parseFailRate: 0.2,  apiErrorRate: 0.1,  promptTokens: 200, completionTokens: 100 },
  stress:    { latencyMs: 0,    parseFailRate: 0,    apiErrorRate: 0,    promptTokens: 200, completionTokens: 100 },
};

const DEFAULT_CONFIG: MockConfig = MOCK_CONFIGS.normal;

// ─── 유틸 ─────────────────────────────────────────────────────────

function getCurrentGoalRevId(store: RevisionStore): number | null {
  const h = store.getHistory();
  for (let i = h.length - 1; i >= 0; i--) {
    if (h[i].patch.payload.type === "set_goal") return h[i].id;
  }
  return null;
}

function getCurrentGoal(store: RevisionStore): string {
  const h = store.getHistory();
  for (let i = h.length - 1; i >= 0; i--) {
    if (h[i].patch.payload.type === "set_goal")
      return (h[i].patch.payload as { goal: string }).goal;
  }
  return "";
}

// ─── Worker 베이스 ────────────────────────────────────────────────
//
// handle()은 항상 subscribe 시점에 캡처된 capturedGoalRevId를 받는다.
// workers 내부에서 getCurrentGoalRevId()를 직접 호출하지 않는다.
// → TOCTOU 방지

abstract class Worker {
  protected spokenAt: Map<number, number> = new Map();

  constructor(protected store: RevisionStore) {}

  protected speakCount(goalRevId: number) {
    return this.spokenAt.get(goalRevId) ?? 0;
  }

  protected recordSpeak(goalRevId: number) {
    this.spokenAt.set(goalRevId, this.speakCount(goalRevId) + 1);
  }

  protected canSpeak(goalRevId: number) {
    return this.speakCount(goalRevId) < MAX_PROPOSALS_PER_WORKER;
  }

  // capturedGoalRevId: subscribe 시점에 Orchestrator가 캡처해서 전달
  abstract handle(rev: Revision, capturedGoalRevId: number | null): void | Promise<void>;
}

// ─── MockGPTWorker ────────────────────────────────────────────────

export class MockGPTWorker extends Worker {
  private db: Record<string, string[]> = {
    "데이터베이스": ["SQLite",     "PostgreSQL", "MySQL"],
    "프레임워크":   ["Express.js", "Fastify",    "NestJS"],
    "인증":         ["JWT",        "Session",    "OAuth2"],
    "배포":         ["AWS EC2",    "Vercel",     "Railway"],
    "상태관리":     ["Redux",      "Zustand",    "Recoil"],
    "테스트":       ["Jest",       "Vitest",     "Mocha"],
  };

  constructor(
    store: RevisionStore,
    private metrics?: Metrics,
    private config: MockConfig = DEFAULT_CONFIG
  ) { super(store); }

  async handle(rev: Revision, capturedGoalRevId: number | null): Promise<void> {
    if (rev.author === "gpt" || capturedGoalRevId === null) return;

    const type = rev.patch.payload.type;
    const willSpeak =
      (type === "set_goal" && this.canSpeak(capturedGoalRevId)) ||
      (type === "propose_alternative" && rev.author === "claude" && this.canSpeak(capturedGoalRevId));

    if (!willSpeak) return;

    if (this.metrics) this.metrics.calls.gpt.total++;
    const count = this.speakCount(capturedGoalRevId);
    this.recordSpeak(capturedGoalRevId);

    await simulateCall(this.config, "gpt", capturedGoalRevId, this.metrics, () => {
      const goal = getCurrentGoal(this.store);
      const opts = this.findOptions(goal);

      if (type === "set_goal") {
        this.store.append("gpt", {
          type: "propose_decision",
          payload: { type: "propose_decision", value: opts[0], reason: "팀 경험 + 생태계 성숙도" },
          rationale: "초기 단계에서 가장 안전한 선택",
        });
      } else {
        const pick = opts[count % opts.length];
        this.store.append("gpt", {
          type: "propose_alternative",
          references: [rev.id, ...(rev.patch.references ?? [])].slice(0, 3),
          payload: { type: "propose_alternative", value: pick, reason: "비용과 운영 부담 균형" },
          rationale: `Claude 제안 검토 후 ${pick}이 현재 팀에 더 적합`,
        });
      }
    }, () => { this.spokenAt.set(capturedGoalRevId, count); }); // rollback on failure
  }

  private findOptions(goal: string): string[] {
    for (const [key, opts] of Object.entries(this.db)) {
      if (goal.includes(key)) return opts;
    }
    return ["Option-A", "Option-B", "Option-C"];
  }
}

// ─── MockClaudeWorker ─────────────────────────────────────────────

export class MockClaudeWorker extends Worker {
  private alternatives: Record<string, string[]> = {
    "데이터베이스": ["PostgreSQL",   "TiDB",        "CockroachDB"],
    "프레임워크":   ["Fastify",      "Hono",        "Elysia"],
    "인증":         ["Paseto",       "Session+Redis","Auth0"],
    "배포":         ["Fly.io",       "Render",      "GCP Cloud Run"],
    "상태관리":     ["Zustand",      "Jotai",       "TanStack Query"],
    "테스트":       ["Vitest",       "Playwright",  "Vitest+Playwright"],
  };

  constructor(
    store: RevisionStore,
    private metrics?: Metrics,
    private config: MockConfig = DEFAULT_CONFIG
  ) { super(store); }

  async handle(rev: Revision, capturedGoalRevId: number | null): Promise<void> {
    if (rev.author === "claude" || capturedGoalRevId === null) return;

    const type = rev.patch.payload.type;
    if (
      (type !== "propose_decision" && type !== "propose_alternative") ||
      rev.author !== "gpt" ||
      !this.canSpeak(capturedGoalRevId)
    ) return;

    if (this.metrics) this.metrics.calls.claude.total++;
    const count = this.speakCount(capturedGoalRevId);
    this.recordSpeak(capturedGoalRevId);

    await simulateCall(this.config, "claude", capturedGoalRevId, this.metrics, () => {
      const goal = getCurrentGoal(this.store);
      const opts = this.findOptions(goal);
      const pick = opts[count % opts.length];
      this.store.append("claude", {
        type: "propose_alternative",
        references: [rev.id],
        payload: { type: "propose_alternative", value: pick, reason: "장기 확장성과 보안 우선" },
        rationale: `GPT 제안 대비 ${pick}이 유지보수 측면에서 우위`,
      });
    }, () => { this.spokenAt.set(capturedGoalRevId, count); });
  }

  private findOptions(goal: string): string[] {
    for (const [key, opts] of Object.entries(this.alternatives)) {
      if (goal.includes(key)) return opts;
    }
    return ["Alt-X", "Alt-Y", "Alt-Z"];
  }
}

// ─── 시뮬레이션 헬퍼 ─────────────────────────────────────────────

async function simulateCall(
  config: MockConfig,
  author: "gpt" | "claude",
  goalRevId: number,
  metrics: Metrics | undefined,
  onSuccess: () => void,
  onFailure: () => void
): Promise<void> {
  // 지연
  if (config.latencyMs > 0) {
    const jitter = config.latencyMs * 0.3 * (Math.random() * 2 - 1);
    const delay = Math.max(0, config.latencyMs + jitter);
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, delay));
    if (metrics) metrics.latencyMs.push(Date.now() - t0);
  }

  // apiError 시뮬레이션
  if (Math.random() < config.apiErrorRate) {
    console.error(`[Mock ${author.toUpperCase()}] simulated apiError (goalRevId=${goalRevId})`);
    if (metrics) metrics.calls[author].apiError++;
    onFailure();
    return;
  }

  // parseFail 시뮬레이션
  if (Math.random() < config.parseFailRate) {
    console.error(`[Mock ${author.toUpperCase()}] simulated parseFail (goalRevId=${goalRevId})`);
    if (metrics) metrics.calls[author].parseFail++;
    onFailure();
    return;
  }

  // 성공
  if (metrics) {
    metrics.calls[author].parseOk++;
    metrics.tokens.prompt     += config.promptTokens;
    metrics.tokens.completion += config.completionTokens;
  }
  onSuccess();
}

// ─── MockUserWorker ───────────────────────────────────────────────

export class MockUserWorker extends Worker {
  // Set<goalRevId>: 이미 선택 완료된 topic
  private selectedTopics: Set<number> = new Set();

  handle(rev: Revision, capturedGoalRevId: number | null) {
    if (rev.author === "user" || capturedGoalRevId === null) return;

    const type = rev.patch.payload.type;
    if (type !== "propose_decision" && type !== "propose_alternative") return;

    // capturedGoalRevId 기준으로 중복 선택 방지
    if (this.selectedTopics.has(capturedGoalRevId)) return;

    const history = this.store.getHistory();
    const topicStart = history.findIndex((r) => r.id === capturedGoalRevId);
    if (topicStart === -1) return;

    // 이 topic의 revisions만 추출 (다음 set_goal 이전까지)
    const topicEnd = history.findIndex((r, i) => i > topicStart && r.patch.payload.type === "set_goal");
    const topicRevs = history.slice(topicStart, topicEnd === -1 ? undefined : topicEnd);

    const hasGPT = topicRevs.some(
      (r) => r.author === "gpt" && (r.patch.payload.type === "propose_decision" || r.patch.payload.type === "propose_alternative")
    );
    const hasClaude = topicRevs.some(
      (r) => r.author === "claude" && r.patch.payload.type === "propose_alternative"
    );

    if (!hasGPT || !hasClaude) return;

    const winner = selectByPolicy(topicRevs, history);
    if (!winner) return;

    // 선택 등록 (JS 단일 스레드이므로 이 사이에 다른 타이머 끼어들 수 없음)
    this.selectedTopics.add(capturedGoalRevId);

    this.store.append("user", {
      type: "select_option",
      references: [winner.id],
      payload: {
        type: "select_option",
        selected: (winner.patch.payload as { value: string }).value,
      },
      rationale: `Policy 선택 (capturedGoal=${capturedGoalRevId}, winner=${winner.author})`,
    });
  }
}

// ─── Orchestrator (동기) ──────────────────────────────────────────

export class Orchestrator {
  private totalRevisions = 0;
  private readonly MAX_TOTAL = 1200; // 200 topics × ~6 revisions/topic

  constructor(store: RevisionStore) {
    const workers = [
      new MockGPTWorker(store),
      new MockClaudeWorker(store),
      new MockUserWorker(store),
    ];

    store.subscribe((rev) => {
      if (++this.totalRevisions > this.MAX_TOTAL) {
        console.error("[Orchestrator] MAX_TOTAL 초과");
        return;
      }
      // subscribe 시점에 goalRevId 캡처 → 모든 worker에 전달
      const capturedGoalRevId = getCurrentGoalRevId(store);
      for (const w of workers) w.handle(rev, capturedGoalRevId);
    });
  }
}

// ─── AsyncOrchestrator ────────────────────────────────────────────

export class AsyncOrchestrator {
  private pending = 0;
  private totalRevisions = 0;
  private readonly MAX_TOTAL = 500;

  constructor(
    private store: RevisionStore,
    private onDone?: () => void
  ) {
    const gpt = new MockGPTWorker(store);
    const claude = new MockClaudeWorker(store);
    const user = new MockUserWorker(store);

    store.subscribe((rev) => {
      if (++this.totalRevisions > this.MAX_TOTAL) return;

      // subscribe 시점에 capturedGoalRevId 캡처 — 핵심 fix
      const capturedGoalRevId = getCurrentGoalRevId(this.store);

      this.schedule(() => gpt.handle(rev, capturedGoalRevId),   500  + Math.random() * 700,  "gpt");
      this.schedule(() => claude.handle(rev, capturedGoalRevId),900  + Math.random() * 1100, "claude");
      this.schedule(() => user.handle(rev, capturedGoalRevId),  2500 + Math.random() * 1000, "user");
    });
  }

  private schedule(fn: () => void, delayMs: number, _label: string) {
    this.pending++;
    setTimeout(() => {
      try { fn(); } catch (e) { console.error("[async]", e); }
      this.pending--;
      if (this.pending === 0) this.onDone?.();
    }, delayMs);
  }

  waitUntilDone(): Promise<void> {
    return new Promise((resolve) => {
      const check = setInterval(() => {
        if (this.pending === 0) { clearInterval(check); resolve(); }
      }, 100);
    });
  }
}
