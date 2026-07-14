import { RevisionStore } from "./RevisionStore.js";
import { Revision, DiscussionBudget, DEPTH_BUDGETS, StanceAction } from "./types.js";
import { computeAggregation, normalizeProposal } from "./aggregation.js";
import { selectByPolicy } from "./policy.js";
import { Metrics } from "./metrics.js";
import { getModeInstruction } from "./workers/mode-instruction.js";

const DEFAULT_BUDGET: DiscussionBudget = DEPTH_BUDGETS.structural_convergence;

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
  protected maxRoundsPerWorker: number;

  constructor(protected store: RevisionStore, budget?: DiscussionBudget) {
    this.maxRoundsPerWorker = budget?.maxRoundsPerWorker ?? DEFAULT_BUDGET.maxRoundsPerWorker;
  }

  protected speakCount(goalRevId: number) {
    return this.spokenAt.get(goalRevId) ?? 0;
  }

  protected recordSpeak(goalRevId: number) {
    this.spokenAt.set(goalRevId, this.speakCount(goalRevId) + 1);
  }

  protected canSpeak(goalRevId: number) {
    return this.speakCount(goalRevId) < this.maxRoundsPerWorker;
  }

  setDiscussionBudget(budget: DiscussionBudget): void {
    this.maxRoundsPerWorker = budget.maxRoundsPerWorker;
  }

  // capturedGoalRevId: subscribe 시점에 Orchestrator가 캡처해서 전달
  abstract handle(rev: Revision, capturedGoalRevId: number | null): void | Promise<void>;
}

// ─── MockGPTWorker ────────────────────────────────────────────────

export class MockGPTWorker extends Worker {
  private respondedInterjections = new Set<number>(); // interjection rev.id → 중복 응답 방지
  private distinctProposals      = new Map<number, Set<string>>(); // goalRevId → 제안한 값 집합
  private readonly maxDistinctProposals: number;

  private db: Array<[string[], string[]]> = [
    [["데이터베이스", "database", "db", "storage"],  ["PostgreSQL", "MySQL",   "SQLite"]],
    [["프레임워크",   "framework", "backend"],        ["Express",   "Fastify",  "Hono"]],
    [["인증",         "auth",      "authentication"], ["JWT",       "Session",  "OAuth2"]],
    [["배포",         "deploy",    "hosting", "ci"],  ["Vercel",    "Railway",  "AWS EC2"]],
    [["상태관리",     "state",     "store"],          ["Zustand",   "Redux",    "Recoil"]],
    [["테스트",       "test",      "testing"],        ["Vitest",    "Jest",     "Mocha"]],
    [["언어",         "language",  "lang"],           ["TypeScript","Go",       "Python"]],
    [["아키텍처",     "architecture","arch"],         ["Monolith",  "Microservices","Serverless"]],
    [["모니터링",     "monitoring","observability"],  ["Grafana",   "Datadog",  "Sentry"]],
    [["캐시",         "cache",     "caching"],        ["Redis",     "Memcached","In-memory"]],
    [["메시지큐",     "queue",     "message", "mq"],  ["RabbitMQ",  "Kafka",    "SQS"]],
    [["CI/CD",        "파이프라인","pipeline"],       ["GitHub Actions","GitLab CI","Jenkins"]],
    [["보안",         "security",  "encryption"],     ["TLS/mTLS",  "Vault",    "AWS KMS"]],
  ];

  constructor(
    store: RevisionStore,
    private metrics?: Metrics,
    private config: MockConfig = DEFAULT_CONFIG,
    budget?: DiscussionBudget,
  ) {
    super(store, budget);
    this.maxDistinctProposals = budget?.maxDistinctProposals ?? DEFAULT_BUDGET.maxDistinctProposals;
  }

  async handle(rev: Revision, capturedGoalRevId: number | null): Promise<void> {
    if (rev.author === "gpt" || capturedGoalRevId === null) return;

    const type = rev.patch.payload.type;

    // user_interjection에 대한 응답 — spokenAt 제한 없이 별도 추적
    if (type === "user_interjection") {
      if (this.respondedInterjections.has(rev.id)) return;
      this.respondedInterjections.add(rev.id);
      if (this.metrics) this.metrics.calls.gpt.total++;
      const count = this.speakCount(capturedGoalRevId);
      await simulateCall(this.config, "gpt", capturedGoalRevId, this.metrics, () => {
        const goal = getCurrentGoal(this.store);
        const opts = this.findOptions(goal);
        const pick = opts[count % opts.length];
        this.store.append("gpt", {
          type: "propose_alternative",
          references: [rev.id],
          payload: { type: "propose_alternative", value: pick, reason: "인터젝션 후 재검토" },
        });
      }, () => { this.respondedInterjections.delete(rev.id); });
      return;
    }

    const willSpeak =
      (type === "set_goal" && this.canSpeak(capturedGoalRevId)) ||
      (type === "propose_alternative" && (rev.author === "claude" || rev.author === "gemini") && this.canSpeak(capturedGoalRevId));

    if (!willSpeak) return;

    if (this.metrics) this.metrics.calls.gpt.total++;
    const count = this.speakCount(capturedGoalRevId);
    this.recordSpeak(capturedGoalRevId);

    await simulateCall(this.config, "gpt", capturedGoalRevId, this.metrics, () => {
      // 지연 대기 중 topic이 결론 확정됐으면 append 하지 않음
      if (this.store.isTopicDecided(capturedGoalRevId)) {
        this.spokenAt.set(capturedGoalRevId, count); // rollback
        return;
      }
      const goal = getCurrentGoal(this.store);
      const opts = this.findOptions(goal);

      if (type === "set_goal") {
        const firstPick = opts[0];
        const mySet = this.distinctProposals.get(capturedGoalRevId) ?? new Set<string>();
        mySet.add(firstPick.toLowerCase());
        this.distinctProposals.set(capturedGoalRevId, mySet);
        this.store.append("gpt", {
          type: "propose_decision",
          payload: { type: "propose_decision", value: firstPick, reason: "팀 경험 + 생태계 성숙도", stanceAction: "propose" },
          rationale: "초기 단계에서 가장 안전한 선택",
        });
      } else {
        const mySet = this.distinctProposals.get(capturedGoalRevId) ?? new Set<string>();
        // distinct 한도 초과 시 defend (첫 제안을 재사용)
        const pick = mySet.size >= this.maxDistinctProposals
          ? [...mySet][0]
          : opts[count % opts.length];
        if (mySet.size < this.maxDistinctProposals) {
          mySet.add(pick.toLowerCase());
          this.distinctProposals.set(capturedGoalRevId, mySet);
        }
        const stanceAction = this.resolveStanceAction(pick, mySet, capturedGoalRevId);
        this.store.append("gpt", {
          type: "propose_alternative",
          references: [rev.id, ...(rev.patch.references ?? [])].slice(0, 3),
          payload: { type: "propose_alternative", value: pick, reason: mySet.size >= this.maxDistinctProposals ? "여전히 이 선택이 최적입니다" : "비용과 운영 부담 균형", stanceAction },
          rationale: mySet.size >= this.maxDistinctProposals ? "기존 입장 유지" : `Claude 제안 검토 후 ${pick}이 현재 팀에 더 적합`,
        });
      }
    }, () => { this.spokenAt.set(capturedGoalRevId, count); }); // rollback on failure
  }

  private getOpponentLastValue(capturedGoalRevId: number): string | null {
    const h = this.store.getHistory();
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i].id <= capturedGoalRevId) break;
      const r = h[i];
      if ((r.author === "claude" || r.author === "gemini") &&
          (r.patch.payload.type === "propose_decision" || r.patch.payload.type === "propose_alternative")) {
        return (r.patch.payload as { value: string }).value;
      }
    }
    return null;
  }

  private resolveStanceAction(pick: string, mySet: Set<string>, capturedGoalRevId: number): StanceAction {
    if (mySet.size >= this.maxDistinctProposals) return "defend";
    const opponentVal = this.getOpponentLastValue(capturedGoalRevId);
    if (opponentVal && normalizeProposal(pick) === normalizeProposal(opponentVal)) return "concede";
    return "propose";
  }

  private findOptions(goal: string): string[] {
    const lower = goal.toLowerCase();
    for (const [keys, opts] of this.db) {
      if (keys.some(k => lower.includes(k.toLowerCase()))) return opts;
    }
    return ["Option-A", "Option-B", "Option-C"];
  }
}

// ─── MockClaudeWorker ─────────────────────────────────────────────

export class MockClaudeWorker extends Worker {
  private distinctProposals      = new Map<number, Set<string>>(); // goalRevId → 제안한 값 집합
  private readonly maxDistinctProposals: number;

  private alternatives: Array<[string[], string[]]> = [
    [["데이터베이스", "database", "db", "storage"],  ["TiDB",         "CockroachDB",    "DynamoDB"]],
    [["프레임워크",   "framework", "backend"],        ["Hono",         "Elysia",         "Bun HTTP"]],
    [["인증",         "auth",      "authentication"], ["Paseto",       "Session+Redis",  "Auth0"]],
    [["배포",         "deploy",    "hosting", "ci"],  ["Fly.io",       "Render",         "GCP Cloud Run"]],
    [["상태관리",     "state",     "store"],          ["Jotai",        "TanStack Query", "XState"]],
    [["테스트",       "test",      "testing"],        ["Playwright",   "Cypress",        "Vitest+MSW"]],
    [["언어",         "language",  "lang"],           ["Rust",         "Zig",            "Elixir"]],
    [["아키텍처",     "architecture","arch"],         ["Event-Driven", "CQRS",           "Hexagonal"]],
    [["모니터링",     "monitoring","observability"],  ["OpenTelemetry","Loki+Grafana",    "Honeycomb"]],
    [["캐시",         "cache",     "caching"],        ["Dragonfly",    "Valkey",         "KeyDB"]],
    [["메시지큐",     "queue",     "message", "mq"],  ["NATS",         "Redpanda",       "Pulsar"]],
    [["CI/CD",        "파이프라인","pipeline"],       ["CircleCI",     "Drone CI",       "Tekton"]],
    [["보안",         "security",  "encryption"],     ["SPIFFE/SPIRE", "HashiCorp Vault", "SOPS"]],
  ];

  constructor(
    store: RevisionStore,
    private metrics?: Metrics,
    private config: MockConfig = DEFAULT_CONFIG,
    budget?: DiscussionBudget,
    private liveMode = false,  // true: set_goal + any author 응답; false: GPT proposal만 (batch 호환)
  ) {
    super(store, budget);
    this.maxDistinctProposals = budget?.maxDistinctProposals ?? DEFAULT_BUDGET.maxDistinctProposals;
  }

  async handle(rev: Revision, capturedGoalRevId: number | null): Promise<void> {
    if (rev.author === "claude" || capturedGoalRevId === null) return;

    const type = rev.patch.payload.type;

    if (this.liveMode) {
      // Live 모드: set_goal 및 비자신 제안 모두 응답
      const isSetGoal  = type === "set_goal";
      const isProposal = type === "propose_decision" || type === "propose_alternative";
      if (!isSetGoal && !isProposal) return;
    } else {
      // Batch 모드 (기존 동작): GPT proposal에만 응답
      if (
        (type !== "propose_decision" && type !== "propose_alternative") ||
        rev.author !== "gpt"
      ) return;
    }

    if (!this.canSpeak(capturedGoalRevId)) return;

    if (this.metrics) this.metrics.calls.claude.total++;
    const count = this.speakCount(capturedGoalRevId);
    this.recordSpeak(capturedGoalRevId);

    await simulateCall(this.config, "claude", capturedGoalRevId, this.metrics, () => {
      if (this.store.isTopicDecided(capturedGoalRevId)) {
        this.spokenAt.set(capturedGoalRevId, count); // rollback
        return;
      }
      const goal = getCurrentGoal(this.store);
      const opts = this.findOptions(goal);
      const mySet = this.distinctProposals.get(capturedGoalRevId) ?? new Set<string>();
      // distinct 한도 초과 시 defend (첫 제안 재사용)
      const pick = mySet.size >= this.maxDistinctProposals
        ? [...mySet][0]
        : opts[count % opts.length];
      if (mySet.size < this.maxDistinctProposals) {
        mySet.add(pick.toLowerCase());
        this.distinctProposals.set(capturedGoalRevId, mySet);
      }
      const stanceAction = this.resolveStanceAction(pick, mySet, capturedGoalRevId);
      const isSetGoal = type === "set_goal";
      this.store.append("claude", {
        type: "propose_alternative",
        references: isSetGoal ? undefined : [rev.id],
        payload: {
          type: "propose_alternative",
          value: pick,
          reason: mySet.size >= this.maxDistinctProposals ? "여전히 이 선택이 최적입니다" : "장기 확장성과 보안 우선",
          stanceAction,
        },
        rationale: mySet.size >= this.maxDistinctProposals ? "기존 입장 유지" : `${pick}이 유지보수 측면에서 우위`,
      });
    }, () => { this.spokenAt.set(capturedGoalRevId, count); });
  }

  private getOpponentLastValue(capturedGoalRevId: number): string | null {
    const h = this.store.getHistory();
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i].id <= capturedGoalRevId) break;
      const r = h[i];
      if (r.author !== "claude" && r.author !== "user" && r.author !== "system" &&
          (r.patch.payload.type === "propose_decision" || r.patch.payload.type === "propose_alternative")) {
        return (r.patch.payload as { value: string }).value;
      }
    }
    return null;
  }

  private resolveStanceAction(pick: string, mySet: Set<string>, capturedGoalRevId: number): StanceAction {
    if (mySet.size >= this.maxDistinctProposals) return "defend";
    const opponentVal = this.getOpponentLastValue(capturedGoalRevId);
    if (opponentVal && normalizeProposal(pick) === normalizeProposal(opponentVal)) return "concede";
    return "propose";
  }

  private findOptions(goal: string): string[] {
    const lower = goal.toLowerCase();
    for (const [keys, opts] of this.alternatives) {
      if (keys.some(k => lower.includes(k.toLowerCase()))) return opts;
    }
    return ["Alt-X", "Alt-Y", "Alt-Z"];
  }
}

// ─── 시뮬레이션 헬퍼 ─────────────────────────────────────────────

async function simulateCall(
  config: MockConfig,
  author: "gpt" | "claude" | "gemini",
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
// autoConsensus 플래그는 budget이 아닌 ConsensusMode에서 결정됨

// 자동 수렴 임계값 — 표준 모드
const AUTO_CONSENSUS_MIN_SCORE = 4;
const AUTO_CONSENSUS_MIN_GAP   = 2;

// until_consensus 안정 수렴 임계값 — 표준보다 높아 더 오래 토론
const STABILITY_MIN_SCORE = 8;
const STABILITY_MIN_GAP   = 4;

export class MockUserWorker extends Worker {
  private selectedTopics: Set<number> = new Set();
  private readonly stabilityMode: boolean;

  constructor(
    store: RevisionStore,
    budget?: DiscussionBudget,
    private readonly autoConsensus: boolean = true,
    stabilityMode = false,
  ) {
    super(store, budget);
    this.stabilityMode = stabilityMode ?? (budget?.stabilityMode ?? false);
  }

  handle(rev: Revision, capturedGoalRevId: number | null) {
    if (rev.author === "user" || capturedGoalRevId === null) return;

    const type = rev.patch.payload.type;
    if (type !== "propose_decision" && type !== "propose_alternative") return;

    // manual 모드: 자동 수렴하지 않음 — 사용자가 직접 결론 확정
    if (!this.autoConsensus) return;

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
    const hasCounterProposal = topicRevs.some(
      (r) => (r.author === "claude" || r.author === "gemini") && r.patch.payload.type === "propose_alternative"
    );

    if (!hasGPT || !hasCounterProposal) return;

    // 수렴 조건 — stabilityMode(until_consensus)는 더 높은 임계값 사용
    const state   = this.store.rebuildState();
    const topic   = state.topics.find(t => t.startRevId === capturedGoalRevId);
    if (topic) {
      const ranked  = computeAggregation(topic);
      const top     = ranked[0];
      const second  = ranked[1];
      const minScore = this.stabilityMode ? STABILITY_MIN_SCORE : AUTO_CONSENSUS_MIN_SCORE;
      const minGap   = this.stabilityMode ? STABILITY_MIN_GAP   : AUTO_CONSENSUS_MIN_GAP;
      const dominant = top && top.score >= minScore
        && top.score - (second?.score ?? 0) >= minGap;
      // max rounds 소진 여부 — 양쪽 워커 합산 기준
      const proposalCount = topicRevs.filter(r =>
        r.patch.payload.type === "propose_decision" || r.patch.payload.type === "propose_alternative"
      ).length;
      const maxedOut = proposalCount >= this.maxRoundsPerWorker * 2;
      // 우세 조건도 소진도 아니면 대기
      if (!dominant && !maxedOut) return;
    }

    const winner = selectByPolicy(topicRevs, history);
    if (!winner) return;

    // 선택 등록 (JS 단일 스레드이므로 이 사이에 다른 타이머 끼어들 수 없음)
    this.selectedTopics.add(capturedGoalRevId);

    // proposalCount 재계산 (topic 블록에서 이미 계산됐으나 topic이 null일 수 있음)
    const totalProposals = topicRevs.filter(r =>
      r.patch.payload.type === "propose_decision" || r.patch.payload.type === "propose_alternative"
    ).length;
    const hitSafetyLimit = totalProposals >= this.maxRoundsPerWorker * 2;

    // system/consensus_reached — 실제 user 선택이 아닌 오케스트레이터 자동 수렴
    this.store.append("system", {
      type: "consensus_reached",
      references: [winner.id],
      payload: {
        type: "consensus_reached",
        selected: (winner.patch.payload as { value: string }).value,
        winner: winner.author,
      },
      rationale: hitSafetyLimit
        ? `Safety limit reached (${totalProposals} proposals) — forced consensus`
        : `Auto-consensus (goal=${capturedGoalRevId}, winner=${winner.author})`,
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

// ─── MockGeminiWorker ─────────────────────────────────────────────
// GPT가 비활성화된 경우에도 동작하도록 set_goal 및 비자신 제안에 모두 응답

export class MockGeminiWorker extends Worker {
  private distinctProposals      = new Map<number, Set<string>>();
  private readonly maxDistinctProposals: number;

  private alternatives: Array<[string[], string[]]> = [
    [["데이터베이스", "database", "db", "storage"],  ["AlloyDB",       "Spanner",        "Firestore"]],
    [["프레임워크",   "framework", "backend"],        ["gRPC-Gateway",  "Connect-Go",     "Bun HTTP"]],
    [["인증",         "auth",      "authentication"], ["Firebase Auth", "Keycloak",       "Ory"]],
    [["배포",         "deploy",    "hosting", "ci"],  ["Cloud Run",     "GKE Autopilot",  "Cloudflare Workers"]],
    [["상태관리",     "state",     "store"],          ["SWR",           "Valtio",         "Legend-State"]],
    [["테스트",       "test",      "testing"],        ["Storybook",     "Testing Library","Supertest"]],
    [["언어",         "language",  "lang"],           ["Kotlin",        "Swift",          "Dart"]],
    [["아키텍처",     "architecture","arch"],         ["Clean Arch",    "Onion Arch",     "Ports+Adapters"]],
    [["모니터링",     "monitoring","observability"],  ["Cloud Trace",   "Cloud Monitoring","BigQuery Logging"]],
    [["캐시",         "cache",     "caching"],        ["Cloud Memorystore","AlloyDB Cache","Firestore Cache"]],
    [["메시지큐",     "queue",     "message", "mq"],  ["Cloud Pub/Sub", "Eventarc",       "Cloud Tasks"]],
    [["CI/CD",        "파이프라인","pipeline"],       ["Cloud Build",   "Cloud Deploy",   "Skaffold"]],
    [["보안",         "security",  "encryption"],     ["Cloud KMS",     "Secret Manager", "BeyondCorp"]],
  ];

  constructor(
    store: RevisionStore,
    private metrics?: Metrics,
    private config: MockConfig = DEFAULT_CONFIG,
    budget?: DiscussionBudget,
  ) {
    super(store, budget);
    this.maxDistinctProposals = budget?.maxDistinctProposals ?? DEFAULT_BUDGET.maxDistinctProposals;
  }

  async handle(rev: Revision, capturedGoalRevId: number | null): Promise<void> {
    if (rev.author === "gemini" || capturedGoalRevId === null) return;

    const type = rev.patch.payload.type;
    const isSetGoal  = type === "set_goal";
    const isProposal = type === "propose_decision" || type === "propose_alternative";

    if (!isSetGoal && !isProposal) return;
    if (!this.canSpeak(capturedGoalRevId)) return;

    if (this.metrics) {
      if (!this.metrics.calls.gemini) {
        this.metrics.calls.gemini = { total: 0, parseOk: 0, parseFail: 0, apiError: 0 };
      }
      this.metrics.calls.gemini.total++;
    }
    const count = this.speakCount(capturedGoalRevId);
    this.recordSpeak(capturedGoalRevId);

    await simulateCall(this.config, "gemini", capturedGoalRevId, this.metrics, () => {
      if (this.store.isTopicDecided(capturedGoalRevId)) {
        this.spokenAt.set(capturedGoalRevId, count);
        return;
      }
      const goal = getCurrentGoal(this.store);
      const opts = this.findOptions(goal);
      const mySet = this.distinctProposals.get(capturedGoalRevId) ?? new Set<string>();
      const pick = mySet.size >= this.maxDistinctProposals
        ? [...mySet][0]
        : opts[count % opts.length];
      if (mySet.size < this.maxDistinctProposals) {
        mySet.add(pick.toLowerCase());
        this.distinctProposals.set(capturedGoalRevId, mySet);
      }
      const stanceAction = this.resolveStanceAction(pick, mySet, capturedGoalRevId);
      this.store.append("gemini", {
        type: "propose_alternative",
        references: isSetGoal ? undefined : [rev.id],
        payload: {
          type: "propose_alternative",
          value: pick,
          reason: mySet.size >= this.maxDistinctProposals ? "여전히 이 선택이 최적입니다" : "Google 생태계 최적화 및 확장성",
          stanceAction,
        },
        rationale: mySet.size >= this.maxDistinctProposals ? "기존 입장 유지" : `${pick}이 클라우드 네이티브 측면에서 우위`,
      });
    }, () => { this.spokenAt.set(capturedGoalRevId, count); });
  }

  private getOpponentLastValue(capturedGoalRevId: number): string | null {
    const h = this.store.getHistory();
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i].id <= capturedGoalRevId) break;
      const r = h[i];
      if (r.author !== "gemini" && r.author !== "user" && r.author !== "system" &&
          (r.patch.payload.type === "propose_decision" || r.patch.payload.type === "propose_alternative")) {
        return (r.patch.payload as { value: string }).value;
      }
    }
    return null;
  }

  private resolveStanceAction(pick: string, mySet: Set<string>, capturedGoalRevId: number): StanceAction {
    if (mySet.size >= this.maxDistinctProposals) return "defend";
    const opponentVal = this.getOpponentLastValue(capturedGoalRevId);
    if (opponentVal && normalizeProposal(pick) === normalizeProposal(opponentVal)) return "concede";
    return "propose";
  }

  private findOptions(goal: string): string[] {
    const lower = goal.toLowerCase();
    for (const [keys, opts] of this.alternatives) {
      if (keys.some(k => lower.includes(k.toLowerCase()))) return opts;
    }
    return ["GCP-A", "GCP-B", "GCP-C"];
  }
}
