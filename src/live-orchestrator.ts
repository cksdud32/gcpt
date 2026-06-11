import { RevisionStore } from "./RevisionStore.js";
import { MockGPTWorker, MockClaudeWorker, MockGeminiWorker } from "./orchestrator.js";
import { RealGPTWorker } from "./workers/gpt.js";
import { RealClaudeWorker } from "./workers/claude.js";
import { RealGeminiWorker } from "./workers/gemini.js";
import { createMetrics } from "./metrics.js";
import { selectByPolicy } from "./policy.js";
import { ConsensusEvaluator } from "./consensus-evaluator.js";
import { Revision, Topic, DiscussionMode, DiscussionBudget, ConsensusMode, DEPTH_BUDGETS, ProvidersConfig } from "./types.js";
import type { RunResult } from "./test-modes.js";

const LIVE_MOCK_CONFIG = {
  latencyMs: 400,
  parseFailRate: 0,
  apiErrorRate: 0,
  promptTokens: 200,
  completionTokens: 100,
};

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function getGoalRevId(store: RevisionStore): number | null {
  const h = store.getHistory();
  for (let i = h.length - 1; i >= 0; i--)
    if (h[i].patch.payload.type === "set_goal") return h[i].id;
  return null;
}

// interjection 이후 10분 비활동 시 continuation loop 종료
const CONTINUATION_IDLE_TIMEOUT = 10 * 60 * 1000;

export class LiveOrchestrator {
  private store    = new RevisionStore();
  private metrics  = createMetrics();
  private pending  = 0;
  private interjectQueue: string[] = [];
  private terminated = false;
  private lastSentRevCount = 0;
  private onGoalsDone?: (result: RunResult) => void;
  private decidedGoalRevIds = new Set<number>();

  // ConsensusEvaluator 인스턴스 — setupWorkers 시 초기화
  private evaluator: ConsensusEvaluator | null = null;
  private evalBudget: DiscussionBudget | null   = null;
  private evalAutoConsensus = true;
  // 교착 경고가 이미 emit된 goalRevId 집합 — 중복 방지
  private deadlockWarned = new Set<number>();

  constructor(
    private onUpdate: (history: Revision[], topics: Topic[]) => void,
    private onStatus: (msg: string) => void,
  ) {}

  /** 진행 중인 continuation loop를 중단 (새 세션 시작 시 호출) */
  terminate(): void {
    this.terminated = true;
  }

  /**
   * 사용자 요청으로 토론 중지 (until_consensus 모드 전용).
   * 현재 topic에 discussion_paused revision을 append하고
   * decidedGoalRevIds gate로 late worker를 차단한 뒤 onGoalsDone을 호출한다.
   */
  stopDiscussion(): void {
    if (this.terminated) return;

    const state  = this.store.rebuildState();
    const topic  = state.topics[state.topics.length - 1];

    if (topic && (topic.status === "active" || topic.status === "reopened")) {
      // late worker 차단 — discussion:stop 이후 진행 중인 API 응답이 append되지 않도록
      this.decidedGoalRevIds.add(topic.startRevId);
      this.store.append("system", {
        type: "discussion_paused",
        payload: { type: "discussion_paused", reason: "user_stop" },
      });
    }

    this.terminated = true;
    // 즉시 done 콜백 — renderer가 paused 상태 반영
    this.onGoalsDone?.(this.buildRunResult());
  }

  private pushUpdate(): void {
    const history = this.store.getHistory();
    // 동일 snapshot 중복 전송 방지 — 새 revision이 없으면 skip
    if (history.length === this.lastSentRevCount) return;
    this.lastSentRevCount = history.length;
    const state = this.store.rebuildState();
    this.onUpdate(history, state.topics);
  }

  private track(fn: () => Promise<void>, onComplete?: () => void): void {
    this.pending++;
    fn()
      .catch(e => console.error("[Live] worker error:", e))
      .finally(() => {
        this.pending--;
        onComplete?.();
        console.log(`[live] pending=${this.pending}`);
        if (this.pending === 0) {
          this.onStatus("");
          this.pushUpdate();
        }
      });
  }

  /**
   * Evaluator 실행 — 새 pair round가 완성됐을 때만 판정 실행.
   * consensus / deadlock / safety_limit 결과에 따라 revision을 append한다.
   */
  private runEvaluator(goalRevId: number): void {
    if (!this.evaluator || !this.evalBudget) return;
    if (this.terminated) return;
    if (this.decidedGoalRevIds.has(goalRevId)) return;

    const history = this.store.getHistory();
    const topicStart = history.findIndex(r => r.id === goalRevId);
    if (topicStart === -1) return;
    const topicRevs = history.slice(topicStart);

    const state = this.store.rebuildState();
    const topic = state.topics.find(t => t.startRevId === goalRevId);
    if (!topic || (topic.status !== "active" && topic.status !== "reopened")) return;

    const verdict = this.evaluator.maybeEvaluate(topicRevs, topic, this.evalBudget, this.evalAutoConsensus);
    if (verdict === null || verdict === "continue") return;

    console.log(`[live] evaluator verdict=${verdict} round=${this.evaluator["pairCount"]} goalRevId=${goalRevId}`);

    switch (verdict) {
      case "consensus": {
        this.decidedGoalRevIds.add(goalRevId);
        const winner = selectByPolicy(topicRevs, history);
        if (!winner) { this.decidedGoalRevIds.delete(goalRevId); return; }
        this.store.append("system", {
          type: "consensus_reached",
          references: [winner.id],
          payload: {
            type:     "consensus_reached",
            selected: (winner.patch.payload as { value: string }).value,
            winner:   winner.author,
          },
          rationale: "Evaluator: composite consensus conditions met",
        });
        break;
      }

      case "deadlock": {
        if (this.deadlockWarned.has(goalRevId)) return;
        this.deadlockWarned.add(goalRevId);
        this.store.append("system", {
          type: "discussion_deadlock",
          payload: {
            type:   "discussion_deadlock",
            reason: "교착 상태: AI들이 서로 다른 입장을 유지하고 있습니다. 최근 양보 없음.",
          },
          rationale: `sameLeaderRounds=${this.evaluator["sameLeaderRounds"]} pairCount=${this.evaluator["pairCount"]}`,
        });
        break;
      }

      case "safety_limit": {
        this.decidedGoalRevIds.add(goalRevId);
        this.store.append("system", {
          type: "discussion_paused",
          payload: { type: "discussion_paused", reason: "safety_limit" },
          rationale: `안전 한도 도달 — maxRoundsPerWorker=${this.evalBudget.maxRoundsPerWorker}`,
        });
        this.terminated = true;
        this.onGoalsDone?.(this.buildRunResult());
        break;
      }
    }
  }

  private activeWorkerNames: string[] = [];

  private setupWorkers(budget: DiscussionBudget, autoConsensus: boolean, providers: ProvidersConfig): void {
    this.lastSentRevCount  = 0;
    this.decidedGoalRevIds.clear();
    this.deadlockWarned.clear();

    // Provider 상태 스냅샷 로그 (버그 추적용)
    console.log("[providers] settings snapshot:", {
      gpt:    { enabled: providers.gpt.enabled,    hasKey: !!providers.gpt.apiKey,    model: providers.gpt.model },
      claude: { enabled: providers.claude.enabled, hasKey: !!providers.claude.apiKey, model: providers.claude.model },
      gemini: { enabled: providers.gemini.enabled, hasKey: !!providers.gemini.apiKey, model: providers.gemini.model },
    });

    type WorkerHandle = { handle: (rev: Revision, id: number | null) => Promise<void> };
    const workerEntries: Array<{ name: string; author: string; worker: WorkerHandle; isMock: boolean }> = [];

    if (providers.gpt.enabled) {
      const isMock = !providers.gpt.apiKey;
      console.log("[provider] creating worker", { provider: "gpt", enabled: true, hasKey: !!providers.gpt.apiKey, model: providers.gpt.model, isMock });
      workerEntries.push({
        name:   isMock ? "GPT (Mock)" : "GPT",
        author: "gpt",
        worker: isMock
          ? new MockGPTWorker(this.store, this.metrics, LIVE_MOCK_CONFIG, budget)
          : new RealGPTWorker(providers.gpt.apiKey, this.store, this.metrics, budget, providers.gpt.model),
        isMock,
      });
    } else {
      console.log("[provider] skipping worker", { provider: "gpt", enabled: false });
    }

    if (providers.claude.enabled) {
      const isMock = !providers.claude.apiKey;
      console.log("[provider] creating worker", { provider: "claude", enabled: true, hasKey: !!providers.claude.apiKey, model: providers.claude.model, isMock });
      workerEntries.push({
        name:   isMock ? "Claude (Mock)" : "Claude",
        author: "claude",
        worker: isMock
          ? new MockClaudeWorker(this.store, this.metrics, LIVE_MOCK_CONFIG, budget, true)
          : new RealClaudeWorker(providers.claude.apiKey, this.store, this.metrics, budget, providers.claude.model),
        isMock,
      });
    } else {
      console.log("[provider] skipping worker", { provider: "claude", enabled: false });
    }

    if (providers.gemini.enabled) {
      const isMock = !providers.gemini.apiKey;
      console.log("[provider] creating worker", { provider: "gemini", enabled: true, hasKey: !!providers.gemini.apiKey, model: providers.gemini.model, isMock });
      workerEntries.push({
        name:   isMock ? "Gemini (Mock)" : "Gemini",
        author: "gemini",
        worker: isMock
          ? new MockGeminiWorker(this.store, this.metrics, LIVE_MOCK_CONFIG, budget)
          : new RealGeminiWorker(providers.gemini.apiKey, this.store, this.metrics, budget, providers.gemini.model),
        isMock,
      });
    } else {
      console.log("[provider] skipping worker", { provider: "gemini", enabled: false });
    }

    this.activeWorkerNames = workerEntries.map(e => e.name);
    this.evaluator         = new ConsensusEvaluator(workerEntries.map(e => e.author));
    this.evalBudget        = budget;
    this.evalAutoConsensus = autoConsensus;

    const hasRealApi    = workerEntries.some(e => !e.isMock);
    const workerAuthors = workerEntries.map(e => e.author);
    console.log("[providers] active workers:", workerEntries.map(e => `${e.author}(${e.isMock ? "mock" : "real"})`));
    console.log(`[Live] workers: ${this.activeWorkerNames.join(" ↔ ")} | autoConsensus=${autoConsensus} stability=${budget.stabilityMode}`);

    // ── Round state ────────────────────────────────────────────────
    // dispatch된 actor: in-flight 또는 완료 (proposal trigger 기준)
    const roundDispatchedActors = new Set<string>();
    // 실제 proposal을 append 완료한 actor
    const roundSpokeActors      = new Set<string>();
    // dispatch됐지만 발언 없이 bail한 actor (자신의 revision, maxPerTopic 초과 등)
    const roundBailedActors     = new Set<string>();
    let   roundTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
    // 단조 증가 라운드 ID — onComplete 클로저가 stale 라운드에 속하는지 판별
    let   currentRoundId = 0;

    // 라운드 상태 완전 초기화 (set_goal / interjection 시)
    const resetRound = () => {
      if (roundTimeoutHandle) { clearTimeout(roundTimeoutHandle); roundTimeoutHandle = null; }
      currentRoundId++;                 // in-flight bail callback 무효화
      roundDispatchedActors.clear();
      roundSpokeActors.clear();
      roundBailedActors.clear();
    };

    // 라운드 완료: spoke + bailed 합산이 전원이면 evaluator 실행
    const checkRoundComplete = (currentGoalRevId: number | null): void => {
      if (roundDispatchedActors.size === 0) return;
      const allResolved = workerAuthors.every(
        a => roundSpokeActors.has(a) || roundBailedActors.has(a),
      );
      // 발언자 0명인 경우(전원 bail)는 의미 없는 라운드로 간주, evaluator skip
      if (allResolved && roundSpokeActors.size > 0) {
        // timer cancel + 상태 clear는 completeRound 내부에서
        completeRound(currentGoalRevId);
      }
    };

    const completeRound = (currentGoalRevId: number | null): void => {
      if (roundTimeoutHandle) { clearTimeout(roundTimeoutHandle); roundTimeoutHandle = null; }
      // terminated 이후에는 evaluator 실행 금지 (로그도 출력 안 함)
      if (this.terminated) return;
      currentRoundId++;                 // 이 라운드 이전의 in-flight bail callback 무효화
      const spoke = [...roundSpokeActors];
      roundDispatchedActors.clear();
      roundSpokeActors.clear();
      roundBailedActors.clear();
      console.log(`[live] round complete — spoke: [${spoke.join(",")}]`);
      if (currentGoalRevId !== null) this.runEvaluator(currentGoalRevId);
    };

    this.store.subscribe((rev) => {
      if (this.terminated) return;
      console.log(`[live] revision #${rev.id} ${rev.author} ${rev.patch.payload.type}`);
      this.pushUpdate();

      const goalRevId  = getGoalRevId(this.store);
      const type       = rev.patch.payload.type;
      const isProposal = type === "propose_decision" || type === "propose_alternative";

      // set_goal: 라운드 상태 리셋
      if (type === "set_goal") resetRound();

      // interjection → decided gate 해제 + evaluator 리셋 + 라운드 리셋
      if (type === "user_interjection" && goalRevId !== null) {
        if (this.decidedGoalRevIds.has(goalRevId)) {
          console.log("[live] reopen topic, decided gate cleared", { goalRevId });
          this.decidedGoalRevIds.delete(goalRevId);
        }
        this.deadlockWarned.delete(goalRevId);
        this.evaluator?.reset();
        resetRound();
      }

      if (goalRevId !== null && this.decidedGoalRevIds.has(goalRevId)) return;

      // AI actor의 proposal이 도착 → 발언 기록 후 round 완료 여부 확인
      if (isProposal && workerAuthors.includes(rev.author)) {
        roundSpokeActors.add(rev.author);
        checkRoundComplete(goalRevId);
      }

      // 각 worker dispatch — proposal이면 round gate 적용
      for (let i = 0; i < workerEntries.length; i++) {
        const { name, author, worker, isMock } = workerEntries[i];

        // round gate: 이미 이 라운드에서 dispatch된 actor는 skip
        if (isProposal && roundDispatchedActors.has(author)) {
          console.log(`[live] skip dispatch (round gate): ${author} revId=${rev.id}`);
          continue;
        }

        if (isProposal) {
          // 새 라운드 첫 dispatch 시 timeout 시작
          if (roundDispatchedActors.size === 0) {
            const capturedGoalRevId = goalRevId;
            roundTimeoutHandle = setTimeout(() => {
              // terminated 이후 fired된 경우 timer handle만 정리하고 종료
              if (this.terminated) { roundTimeoutHandle = null; return; }
              console.warn(`[live] round timeout — forced complete. spoke: [${[...roundSpokeActors].join(",")}] bailed: [${[...roundBailedActors].join(",")}]`);
              completeRound(capturedGoalRevId);
            }, 60_000);
          }
          roundDispatchedActors.add(author);
        }

        const capturedAuthor     = author;
        const capturedIsProposal = isProposal;
        const capturedGoalRevId  = goalRevId;
        const capturedRoundId    = currentRoundId;   // 이 dispatch 시점의 라운드 ID
        const delayMs = isMock && !hasRealApi ? i * 300 : 0;

        this.track(async () => {
          if (delayMs > 0) await sleep(delayMs);
          if (capturedGoalRevId !== null && this.decidedGoalRevIds.has(capturedGoalRevId)) {
            console.log("[live] worker blocked by decided gate", { goalRevId: capturedGoalRevId, revId: rev.id, name });
            return;
          }
          console.log("[live] worker allowed", { goalRevId: capturedGoalRevId, revId: rev.id, type, name });
          this.onStatus(`${name} responding...`);
          await worker.handle(rev, capturedGoalRevId);
        }, () => {
          // stale 라운드의 bail callback 무시 — roundId가 다르면 이미 다른 라운드
          if (capturedRoundId !== currentRoundId) return;
          // track 완료 시 이 actor가 발언 없이 bail했으면 bailed 처리 후 round 완료 확인
          if (
            capturedIsProposal &&
            roundDispatchedActors.has(capturedAuthor) &&
            !roundSpokeActors.has(capturedAuthor)
          ) {
            roundBailedActors.add(capturedAuthor);
            console.log(`[live] round bail: ${capturedAuthor} revId=${rev.id}`);
            checkRoundComplete(capturedGoalRevId);
          }
        });
      }
    });
  }

  private buildRunResult(): RunResult {
    const state = this.store.rebuildState();
    return {
      mode:          "live",
      metrics:       this.metrics,
      revisionCount: this.store.getHistory().length,
      topics:        state.topics,
      history:       this.store.getHistory(),
    };
  }

  /**
   * goals를 순서대로 실행한 뒤 continuation loop에 진입한다.
   *
   * onGoalsDone: 초기 goals 완료 시 + 각 interjection 사이클 완료 시 호출됨.
   * → main이 이 콜백에서 discussion:done 이벤트를 renderer로 전송한다.
   *
   * terminate()가 호출되거나 CONTINUATION_IDLE_TIMEOUT 동안 interjection이 없으면
   * continuation loop를 종료하고 return한다.
   */
  async runGoals(
    goals: string[],
    discussionMode: DiscussionMode = "general",
    budget: DiscussionBudget = DEPTH_BUDGETS.balanced,
    onGoalsDone?: (result: RunResult) => void,
    consensusMode: ConsensusMode = "auto",
    providers?: ProvidersConfig,
  ): Promise<RunResult> {
    this.onGoalsDone = onGoalsDone;

    // providers가 없으면 env var 기반 기본값 사용 (하위 호환)
    const resolvedProviders: ProvidersConfig = providers ?? {
      gpt:    { enabled: true,  apiKey: process.env.OPENAI_API_KEY ?? "",    model: "gpt-4o-mini" },
      claude: { enabled: !process.env.GEMINI_API_KEY && !providers, apiKey: process.env.ANTHROPIC_API_KEY ?? "", model: "claude-haiku-4-5-20251001" },
      gemini: { enabled: !!process.env.GEMINI_API_KEY, apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" },
    };

    this.setupWorkers(budget, consensusMode === "auto", resolvedProviders);

    const isRealApi = Object.values(resolvedProviders).some(p => p.enabled && p.apiKey);
    const goalTimeoutMs = isRealApi ? 90_000 : 20_000;

    // ── 초기 goal 실행 루프 ───────────────────────────────────────────
    for (const goal of goals) {
      if (this.terminated) break;
      console.log(`[live] starting goal: "${goal}" (mode=${discussionMode})`);
      this.store.append("user", {
        type: "set_goal",
        payload: { type: "set_goal", goal, mode: discussionMode },
      });

      const deadline = Date.now() + goalTimeoutMs;
      while (this.pending > 0 && !this.terminated && Date.now() < deadline) {
        await sleep(100);
      }
      if (this.pending > 0 && !this.terminated) {
        console.warn(`[Live] timeout for goal "${goal}" pending=${this.pending}`);
        // 시간 초과: late worker append 차단 + discussion_paused 기록
        const timedOutRevId = getGoalRevId(this.store);
        if (timedOutRevId !== null && !this.decidedGoalRevIds.has(timedOutRevId)) {
          this.decidedGoalRevIds.add(timedOutRevId);
          this.store.append("system", {
            type: "discussion_paused",
            payload: { type: "discussion_paused", reason: "timeout" },
            rationale: `목표 응답 대기 ${goalTimeoutMs / 1000}s 초과 — 진행 중인 worker 차단됨`,
          });
        }
        this.terminated = true;
      }
      console.log(`[live] goal done: "${goal}"`);
      this.flushInterjections();
    }

    if (!this.terminated) {
      this.onStatus("Decided ✓");
      // 초기 결과를 renderer에 전달 (liveRunning = false로 전환됨)
      onGoalsDone?.(this.buildRunResult());
    }

    // ── Continuation loop ─────────────────────────────────────────────
    // decided 이후에도 사용자 interjection을 처리하기 위해 대기한다.
    // terminate() 또는 10분 비활동 시 종료.
    let lastActivity = Date.now();

    while (!this.terminated && Date.now() - lastActivity < CONTINUATION_IDLE_TIMEOUT) {
      if (this.interjectQueue.length > 0) {
        lastActivity = Date.now();
        this.flushInterjections();
        this.onStatus("토론 재개 중...");

        const deadline = Date.now() + goalTimeoutMs;
        while (this.pending > 0 && !this.terminated && Date.now() < deadline) {
          await sleep(100);
        }

        if (!this.terminated) {
          this.onStatus("");
          this.pushUpdate();
          // interjection 사이클 완료 → 갱신된 결과 전달
          onGoalsDone?.(this.buildRunResult());
        }
      } else {
        await sleep(500);
      }
    }

    return this.buildRunResult();
  }

  interject(message: string): void {
    this.interjectQueue.push(message);
    // 큐에만 추가하고 continuation loop에서 처리한다.
    // 여기서 직접 flushInterjections()를 호출하면 loop가 queue를 볼 수 없어
    // onGoalsDone 경로가 우회되고 discussion:done이 전송되지 않는다.
  }

  /**
   * Manual 모드 — policy 기준 최고 점수 제안을 자동 채택.
   * pending 중에도 호출 가능: decidedGoalRevIds gate로 late worker 차단.
   */
  acceptConsensus(): boolean {
    const history = this.store.getHistory();
    const state   = this.store.rebuildState();
    const topic   = state.topics[state.topics.length - 1];
    if (!topic || (topic.status !== "active" && topic.status !== "reopened")) return false;

    const goalRevId = topic.startRevId;
    if (this.decidedGoalRevIds.has(goalRevId)) return false; // 이미 확정됨
    this.decidedGoalRevIds.add(goalRevId);

    const topicRevs = history.filter(r => r.id >= topic.startRevId);
    const winner = selectByPolicy(topicRevs, history);
    if (!winner) {
      this.decidedGoalRevIds.delete(goalRevId); // rollback
      return false;
    }

    this.store.append("system", {
      type: "consensus_reached",
      references: [winner.id],
      payload: {
        type:     "consensus_reached",
        selected: (winner.patch.payload as { value: string }).value,
        winner:   winner.author,
      },
      rationale: "User accepted best proposal (auto-policy)",
    });

    // setTimeout 없이 즉시 호출 — 렌더러가 즉각 decided 반영
    this.onGoalsDone?.(this.buildRunResult());
    return true;
  }

  /**
   * Manual 모드 — 사용자가 특정 proposal revision을 직접 채택.
   * 토론 중(pending > 0)에도 호출 가능.
   * 채택 후 해당 topic에 대한 late worker 응답은 차단된다.
   */
  selectProposal(revisionId: number): boolean {
    const rev = this.store.getRevision(revisionId);
    if (!rev) return false;

    const { type } = rev.patch.payload;
    if (type !== "propose_decision" && type !== "propose_alternative") return false;

    // 이 revision이 속한 goalRevId 탐색
    const history = this.store.getHistory();
    const revIdx  = history.findIndex(r => r.id === revisionId);
    if (revIdx === -1) return false;

    let goalRevId: number | null = null;
    for (let i = revIdx; i >= 0; i--) {
      if (history[i].patch.payload.type === "set_goal") {
        goalRevId = history[i].id;
        break;
      }
    }
    if (goalRevId === null) return false;

    if (this.decidedGoalRevIds.has(goalRevId)) return false; // 이미 확정됨

    const state = this.store.rebuildState();
    const topic = state.topics.find(t => t.startRevId === goalRevId);
    if (!topic || (topic.status !== "active" && topic.status !== "reopened")) return false;

    this.decidedGoalRevIds.add(goalRevId);

    const value = (rev.patch.payload as { value: string }).value;

    this.store.append("system", {
      type: "consensus_reached",
      references: [revisionId],
      payload: {
        type:     "consensus_reached",
        selected: value,
        winner:   rev.author,
      },
      rationale: "User directly selected this proposal",
    });

    // setTimeout 없이 즉시 호출 — 렌더러가 즉각 decided 반영
    this.onGoalsDone?.(this.buildRunResult());
    return true;
  }

  private flushInterjections(): void {
    while (this.interjectQueue.length > 0) {
      const msg = this.interjectQueue.shift()!;
      this.store.append("user", {
        type: "user_interjection",
        payload: { type: "user_interjection", message: msg },
      });
    }
  }
}
