import { RevisionStore } from "./RevisionStore.js";
import { MockGPTWorker, MockClaudeWorker, MockUserWorker } from "./orchestrator.js";
import { RealGPTWorker } from "./workers/gpt.js";
import { RealGeminiWorker } from "./workers/gemini.js";
import { createMetrics } from "./metrics.js";
import { selectByPolicy } from "./policy.js";
import { Revision, Topic, DiscussionMode, DiscussionBudget, DEPTH_BUDGETS } from "./types.js";
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
  private terminated = false; // terminate() 호출 시 continuation loop 즉시 중단
  private lastSentRevCount = 0; // pushUpdate 중복 전송 방지
  private onGoalsDone?: (result: RunResult) => void; // acceptConsensus/selectProposal에서 재호출용
  // 사용자가 직접 결론을 확정한 goalRevId 집합 — late worker가 해당 topic에 append 못하도록 gate
  private decidedGoalRevIds = new Set<number>();

  constructor(
    private onUpdate: (history: Revision[], topics: Topic[]) => void,
    private onStatus: (msg: string) => void,
  ) {}

  /** 진행 중인 continuation loop를 중단 (새 세션 시작 시 호출) */
  terminate(): void {
    this.terminated = true;
  }

  private pushUpdate(): void {
    const history = this.store.getHistory();
    // 동일 snapshot 중복 전송 방지 — 새 revision이 없으면 skip
    if (history.length === this.lastSentRevCount) return;
    this.lastSentRevCount = history.length;
    const state = this.store.rebuildState();
    this.onUpdate(history, state.topics);
  }

  private track(fn: () => Promise<void>): void {
    this.pending++;
    fn()
      .catch(e => console.error("[Live] worker error:", e))
      .finally(() => {
        this.pending--;
        console.log(`[live] pending=${this.pending}`);
        if (this.pending === 0) {
          this.onStatus("");
          this.pushUpdate();
        }
      });
  }

  private setupWorkers(budget: DiscussionBudget): void {
    this.lastSentRevCount = 0;
    this.decidedGoalRevIds.clear(); // 새 세션이므로 초기화
    const gptKey    = process.env.OPENAI_API_KEY;
    const geminiKey = process.env.GEMINI_API_KEY;

    const gpt: { handle: (rev: Revision, id: number | null) => Promise<void> } =
      gptKey
        ? new RealGPTWorker(gptKey, this.store, this.metrics, budget)
        : new MockGPTWorker(this.store, this.metrics, LIVE_MOCK_CONFIG, budget);
    const gptName = gptKey ? "GPT" : "GPT (Mock)";

    const counterWorker: { handle: (rev: Revision, id: number | null) => Promise<void> } =
      geminiKey
        ? new RealGeminiWorker(geminiKey, this.store, this.metrics, budget)
        : new MockClaudeWorker(this.store, this.metrics, LIVE_MOCK_CONFIG, budget);
    const counterName = geminiKey ? "Gemini" : "Claude (Mock)";

    const user = new MockUserWorker(this.store, budget);

    console.log(`[Live] workers: ${gptName} ↔ ${counterName}`);

    this.store.subscribe((rev) => {
      console.log(`[live] revision #${rev.id} ${rev.author} ${rev.patch.payload.type}`);
      this.pushUpdate(); // update는 항상 전송 (consensus_reached도 UI에 표시)

      const goalRevId = getGoalRevId(this.store);

      // 사용자가 이미 결론을 확정한 topic이면 새 worker track 시작 안 함
      if (goalRevId !== null && this.decidedGoalRevIds.has(goalRevId)) return;

      this.track(async () => {
        // in-flight 중 topic이 decided되면 handle 호출 생략
        if (goalRevId !== null && this.decidedGoalRevIds.has(goalRevId)) return;
        this.onStatus(`${gptName} responding...`);
        await gpt.handle(rev, goalRevId);
      });

      this.track(async () => {
        if (!gptKey) await sleep(300);
        if (goalRevId !== null && this.decidedGoalRevIds.has(goalRevId)) return;
        this.onStatus(`${counterName} responding...`);
        await counterWorker.handle(rev, goalRevId);
      });

      user.handle(rev, goalRevId);
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
  ): Promise<RunResult> {
    this.onGoalsDone = onGoalsDone;
    this.setupWorkers(budget);

    const isRealApi = !!(process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY);
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

    setTimeout(() => this.onGoalsDone?.(this.buildRunResult()), 50);
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

    setTimeout(() => this.onGoalsDone?.(this.buildRunResult()), 50);
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
