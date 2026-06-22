import { RevisionStore } from "./RevisionStore.js";
import { createMetrics } from "./metrics.js";
import { Revision, Topic, ProvidersConfig } from "./types.js";
import { buildChatWorkers } from "./workers/chat-workers.js";
import type { RunResult } from "./test-modes.js";

// ─── 설정 ──────────────────────────────────────────────────────────

/** 모든 AI의 총 발화 수 */
const CONV_MAX_TURNS = 6;

/** 턴 사이 자연스러운 간격 (ms) */
const TURN_DELAY_MS = 300;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ─── ConversationOrchestrator ─────────────────────────────────────
//
// Debate Engine(LiveOrchestrator)과 완전히 독립된 경량 대화 오케스트레이터.
//
// 제거한 요소:
//   - ConsensusEvaluator   (수렴 평가 없음)
//   - PhaseController      (단계 전환 없음)
//   - round gate           (동시 dispatch 없음)
//   - actor bail system    (bail 개념 없음)
//   - deadlock detection   (교착 없음)
//   - synthesis/saturation (분석 없음)
//   - subscriber pattern   (RevisionStore 구독 없음)
//
// 실행 흐름:
//   set_goal → [GPT reply] → [Claude reply] → [Gemini reply] → ... → conversation_end
//   (turn-based sequential, round-robin speaker order)

export class ConversationOrchestrator {
  private store   = new RevisionStore();
  private metrics = createMetrics();
  private terminated        = false;
  private lastSentRevCount  = 0;
  private onGoalsDone?: (result: RunResult) => void;

  constructor(
    private onUpdate: (history: Revision[], topics: Topic[]) => void,
    private onStatus: (msg: string) => void,
  ) {}

  // ── 외부 제어 ─────────────────────────────────────────────────────

  terminate(): void {
    this.terminated = true;
  }

  stopDiscussion(): void {
    if (this.terminated) {
      this.onGoalsDone?.(this.buildResult());
      return;
    }
    const state = this.store.rebuildState();
    const topic = state.topics[state.topics.length - 1];
    if (topic && (topic.status === "active" || topic.status === "reopened")) {
      this.store.append("system", {
        type: "discussion_paused",
        payload: { type: "discussion_paused", reason: "user_stop" },
      });
      this.pushUpdate();
    }
    this.terminated = true;
    this.onGoalsDone?.(this.buildResult());
  }

  hardTerminate(): void {
    if (this.terminated) {
      this.onGoalsDone?.(this.buildResult());
      return;
    }
    const state = this.store.rebuildState();
    const topic = state.topics[state.topics.length - 1];
    if (topic && (topic.status === "active" || topic.status === "reopened")) {
      this.store.append("system", {
        type: "discussion_paused",
        payload: { type: "discussion_paused", reason: "hard_timeout" },
      });
      this.pushUpdate();
    }
    this.terminated = true;
    this.onGoalsDone?.(this.buildResult());
  }

  // ── 내부 헬퍼 ─────────────────────────────────────────────────────

  private pushUpdate(): void {
    const history = this.store.getHistory();
    if (history.length === this.lastSentRevCount) return;
    this.lastSentRevCount = history.length;
    const state = this.store.rebuildState();
    this.onUpdate(history, state.topics);
  }

  private buildResult(): RunResult {
    const state   = this.store.rebuildState();
    const history = this.store.getHistory();
    return {
      mode:          "live",
      metrics:       this.metrics,
      revisionCount: history.length,
      topics:        state.topics,
      history,
      analyses:      undefined, // 대화 모드에서는 debate 분석 없음
    };
  }

  // ── 메인 실행 ─────────────────────────────────────────────────────

  async runConversation(
    goal: string,
    providers: ProvidersConfig,
    maxTurns = CONV_MAX_TURNS,
    onGoalsDone?: (result: RunResult) => void,
  ): Promise<RunResult> {
    this.onGoalsDone = onGoalsDone;

    const workers = buildChatWorkers(providers);
    if (workers.length === 0) {
      console.warn("[ConvOrch] no workers available");
      onGoalsDone?.(this.buildResult());
      return this.buildResult();
    }

    console.log(`[ConvOrch] start  goal="${goal}"  workers=[${workers.map(w => w.name).join(",")}]  maxTurns=${maxTurns}`);

    // 대화 토픽 시작
    const goalRev = this.store.append("user", {
      type: "set_goal",
      payload: { type: "set_goal", goal, mode: "general", interactionStyle: "conversation" },
    });
    const goalRevId = goalRev.id;
    this.pushUpdate();

    // Turn-based sequential conversation — no round gate, no evaluator
    for (let turn = 0; turn < maxTurns; turn++) {
      if (this.terminated) break;

      const worker = workers[turn % workers.length];
      this.onStatus(`${worker.name} 응답 중...`);
      console.log(`[ConvOrch] turn ${turn + 1}/${maxTurns}  speaker=${worker.name}`);

      await worker.chatReply(this.store, goalRevId, this.metrics);
      this.pushUpdate();
      this.onStatus("");

      // 자연스러운 간격
      if (!this.terminated && turn < maxTurns - 1) {
        await sleep(TURN_DELAY_MS);
      }
    }

    if (!this.terminated) {
      console.log(`[ConvOrch] conversation_end after ${maxTurns} turns`);
      this.store.append("system", {
        type: "discussion_paused",
        payload: { type: "discussion_paused", reason: "conversation_end" },
        rationale: `대화 ${maxTurns}턴 완료 — 자동 종료`,
      });
      this.pushUpdate();
    }

    this.terminated = true;
    const result = this.buildResult();
    onGoalsDone?.(result);
    return result;
  }
}
