import { RevisionStore } from "./RevisionStore.js";
import { RealGPTWorker } from "./workers/gpt.js";
import { createDefaultProviders, PROVIDER_LABELS, PROVIDER_NAMES } from "./provider-config.js";
import { createMetrics } from "./metrics.js";
import { selectByPolicy } from "./policy.js";
import { ConsensusEvaluator } from "./consensus-evaluator.js";
import { PhaseController } from "./phase-controller.js";
import { detectConsensusSaturation } from "./saturation.js";
import { Revision, Topic, DiscussionMode, DiscussionBudget, ConsensusMode, DEPTH_BUDGETS, MIN_PROPOSALS_BY_TARGET, TargetCondition, DiscussionPausedPayload, ProvidersConfig, SegmentMemoryContext, Author } from "./types.js";
import { analyzeTopics, analyzeDiscussion } from "./analysis.js";
import { detectQuestionEvolution } from "./question-evolution.js";
import type { EvalVerdict } from "./consensus-evaluator.js";
import type { RunResult } from "./test-modes.js";

type PhaseInjectable    = { setPhaseInstruction: (s: string) => void };
type MemoryInjectable   = { setMemoryContext:    (s: string) => void };
type BudgetInjectable   = { setDiscussionBudget: (budget: DiscussionBudget) => void };

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
  // 최초 합의가 기록된 goalRevId 집합 — 중복 방지
  private initialConsensusRecordedGoalIds = new Set<number>();

  // Run lifecycle — 종료 후 in-flight worker 응답 폐기용
  private activeRunId = "";   // setupWorkers마다 갱신; stopRun 시 "" 로 무효화
  private isStopped   = false;
  private cleanupRound: (() => void) | null = null;  // round 상태 즉시 정리
  // continuation loop에서 재사용할 goal 수준 timeout (setupWorkers 후 runGoals에서 설정)
  private effectiveGoalTimeoutMs = 90_000;
  private baseGoalTimeoutMs = 90_000;

  // ConsensusEvaluator 인스턴스 — setupWorkers 시 초기화
  private evaluator: ConsensusEvaluator | null = null;
  private evalBudget: DiscussionBudget | null   = null;
  private baseBudget: DiscussionBudget | null   = null;
  private evalAutoConsensus = true;
  private budgetInjectableWorkers: BudgetInjectable[] = [];
  // 교착 경고가 이미 emit된 goalRevId 집합 — 중복 방지
  private deadlockWarned = new Set<number>();
  // Phase system
  private phaseController    = new PhaseController();
  private phaseableWorkers:  PhaseInjectable[]  = [];
  private memoryInjectableWorkers: MemoryInjectable[] = [];

  constructor(
    private onUpdate: (history: Revision[], topics: Topic[]) => void,
    private onStatus: (msg: string) => void,
  ) {}

  private toEffectiveBudget(budget: DiscussionBudget): DiscussionBudget {
    return budget.safetyLimitEnabled
      ? { ...budget }
      : { ...budget, maxRoundsPerWorker: Number.MAX_SAFE_INTEGER };
  }

  private formatBudgetForLog(budget: DiscussionBudget): Record<string, string | number | boolean> {
    return {
      maxRoundsPerWorker: budget.maxRoundsPerWorker === Number.MAX_SAFE_INTEGER ? "unlimited" : budget.maxRoundsPerWorker,
      maxDistinctProposals: budget.maxDistinctProposals,
      safetyLimitEnabled: budget.safetyLimitEnabled,
    };
  }

  private refreshEffectiveBudgetForResume(safetyLimitEnabled?: boolean): void {
    if (!this.baseBudget) return;
    if (safetyLimitEnabled !== undefined) {
      this.baseBudget = { ...this.baseBudget, safetyLimitEnabled };
    }
    const effectiveBudget = this.toEffectiveBudget(this.baseBudget);
    this.evalBudget = effectiveBudget;
    this.effectiveGoalTimeoutMs = this.baseBudget.safetyLimitEnabled ? this.baseGoalTimeoutMs : Infinity;
    for (const worker of this.budgetInjectableWorkers) worker.setDiscussionBudget(effectiveBudget);
    console.log("[budget] resume effective", this.formatBudgetForLog(effectiveBudget));
  }

  /** 진행 중인 continuation loop를 중단 (새 세션 시작 시 호출) */
  terminate(): void {
    this.terminated = true;
  }

  /**
   * 앱 보호용 강제 종료 — main process hard timeout에서 호출.
   * discussion_paused(hard_timeout)를 append하고 onGoalsDone을 반드시 호출한다.
   * safetyLimitEnabled 관계없이 항상 종료.
   */
  hardTerminate(): void {
    if (this.terminated) {
      this.onGoalsDone?.(this.buildRunResult());
      return;
    }
    console.warn("[stop] hard emergency timeout — forcing terminate");
    const state = this.store.rebuildState();
    const topic = state.topics[state.topics.length - 1];
    if (topic && (topic.status === "active" || topic.status === "reopened")) {
      this.decidedGoalRevIds.add(topic.startRevId);
      this.store.append("system", {
        type: "discussion_paused",
        payload: { type: "discussion_paused", reason: "hard_timeout" },
        rationale: "앱 보호용 강제 종료 한도 도달",
      });
    }
    this.stopRun("hard_timeout");
    this.onGoalsDone?.(this.buildRunResult());
  }

  /**
   * 사용자 요청으로 토론 중지 (until_consensus 모드 전용).
   * 현재 topic에 discussion_paused revision을 append하고
   * decidedGoalRevIds gate로 late worker를 차단한 뒤 onGoalsDone을 호출한다.
   */
  stopDiscussion(): void {
    const state0   = this.store.rebuildState();
    const isPaused = state0.topics.some(t => t.status === "paused");
    console.log("[stop] requested", { terminated: this.terminated, isPaused });
    if (this.terminated) {
      // 이미 terminated — 렌더러가 아직 done을 못 받았을 수 있으므로 재전송
      this.onGoalsDone?.(this.buildRunResult());
      return;
    }

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

    this.stopRun("user_stop");
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
    const capturedRunId = this.activeRunId;
    this.pending++;
    fn()
      .catch(e => console.error("[Live] worker error:", e))
      .finally(() => {
        // runId가 다르면 이미 stopRun이 호출됐음 — pending은 stopRun에서 0으로 세팅됨
        if (capturedRunId !== this.activeRunId) {
          console.log(`[live] stale worker response discarded { capturedRunId: "${capturedRunId}", activeRunId: "${this.activeRunId}" }`);
          onComplete?.();
          return;
        }
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
   * 토론 종료 시 공통 정리.
   * - activeRunId 무효화 → in-flight track() finally가 stale로 판단해 pending-- 스킵
   * - pending 강제 0 + onStatus("") → UI 스피너 즉시 제거
   * - cleanupRound → round timeout 해제 + actor 집합 초기화
   */
  private stopRun(reason: string): void {
    if (this.isStopped) return;   // 중복 호출 방지
    const prevRunId  = this.activeRunId;
    this.isStopped   = true;
    this.terminated  = true;
    this.activeRunId = "";        // in-flight track() stale 처리용
    this.pending     = 0;
    this.onStatus("");
    this.cleanupRound?.();
    console.log(`[live] run stopped { runId: "${prevRunId}", reason: "${reason}" }`);
  }

  /** phase 전환 시 모든 injectable worker에 새 instruction 전달 + evaluator tracker 리셋 */
  private applyPhaseTransition(): void {
    const instruction = this.phaseController.getPhaseInstruction();
    for (const w of this.phaseableWorkers) w.setPhaseInstruction(instruction);
    this.evaluator?.resetForPhaseTransition();
    console.log(`[phase] workers updated → "${this.phaseController.getCurrentPhase()}"`);
  }

  /**
   * 현재 topic의 분석 결과에서 memory context 문자열을 구성.
   * worker prompt에 주입되지만 score 계산에는 영향 없음.
   */
  private buildMemoryContextString(topic: Topic): string {
    const analysis = analyzeDiscussion(topic, this.store.getHistory(), {
      segmentStartRevId: topic.currentSegmentStartRevId,
    });

    const lines: string[] = [];

    if (analysis.finalConclusion) {
      lines.push(`이전 결론: ${analysis.finalConclusion.text}`);
    }

    if (analysis.branchSurvival?.dominantBranch) {
      const dom = analysis.branchSurvival.dominantBranch;
      lines.push(`주요 주장: ${dom.finalProposalValue}`);
      if (dom.sharedConcepts.length > 0) {
        lines.push(`공유 개념: ${dom.sharedConcepts.slice(0, 5).join(", ")}`);
      }
    } else if (analysis.synthesizedConsensus?.sharedConcepts.length) {
      const kws = analysis.synthesizedConsensus.sharedConcepts.slice(0, 5).map(c => c.keyword);
      lines.push(`공유 개념: ${kws.join(", ")}`);
    }

    if (analysis.unresolvedConflicts.length > 0) {
      const dims = analysis.unresolvedConflicts.slice(0, 3).map(c => c.dimension);
      lines.push(`미해결 쟁점: ${dims.join(", ")}`);
    }

    return lines.join("\n");
  }

  /**
   * finalization 단계에서 의미 포화 조건 충족 시 discussion_paused(consensus_saturated) 기록.
   * 최소 12개 proposal, 2 actor, 최근 3라운드 novelty 정체 조건 선충족.
   */
  private checkConsensusSaturation(goalRevId: number, topic: Topic): void {
    if (!this.evaluator) return;
    const props = topic.proposals;
    if (props.length < 12) return;

    const actors = [...new Set(props.map(p => p.author))].filter(
      a => a !== "system" && a !== "user",
    );
    if (actors.length < 2) return;

    // 최근 3 round novelty 정체 확인
    const noveltyRates = this.evaluator.getNoveltyRates();
    const recent3      = noveltyRates.slice(-3);
    if (recent3.length < 3 || !recent3.every(r => r <= 0.15)) return;

    const convHist   = this.evaluator.getConvergenceHistory();
    const saturation = detectConsensusSaturation(props, convHist, noveltyRates);

    if (!saturation.saturated) return;

    console.log(`[saturation] consensus saturated (confidence=${saturation.confidence.toFixed(2)}, round=${this.evaluator.getPairCount()}) — terminating`);
    this.decidedGoalRevIds.add(goalRevId);
    this.store.append("system", {
      type: "discussion_paused",
      payload: { type: "discussion_paused", reason: "consensus_saturated" },
      rationale: saturation.reason,
    });
    this.stopRun("consensus_saturated");
    this.onGoalsDone?.(this.buildRunResult());
  }

  /** 매 pair round 완성 후 PhaseController에 알리고, 전환 시 워커 업데이트 */
  private tryPhaseTransition(): void {
    if (!this.evaluator) return;
    const convHist = this.evaluator.getConvergenceHistory();
    const advanced = this.phaseController.onRoundComplete({
      pairCount:        this.evaluator.getPairCount(),
      noveltyRates:     this.evaluator.getNoveltyRates(),
      convergenceScore: convHist[convHist.length - 1] ?? 0,
      stagnationRounds: this.evaluator.getStagnationRounds(),
    });
    if (advanced) this.applyPhaseTransition();
  }

  /**
   * question_evolution 모드 전용 — 라운드 완료 후 질문 변화 감지.
   * MIN_PROPOSALS 충족 후 detectQuestionEvolution 실행; reframed/shifted/transformed 시 종료.
   */
  private checkQuestionDrift(goalRevId: number): void {
    if (!this.evalBudget || this.evalBudget.targetCondition !== "question_drift") return;
    if (this.terminated || this.decidedGoalRevIds.has(goalRevId)) return;

    const state = this.store.rebuildState();
    const topic = state.topics.find(t => t.startRevId === goalRevId);
    if (!topic) return;

    const minProposals = MIN_PROPOSALS_BY_TARGET["question_drift"];
    if (topic.proposals.length < Math.max(4, minProposals)) return;

    const actors = [...new Set(topic.proposals.map(p => p.author))] as Author[];
    const qe = detectQuestionEvolution(topic, topic.proposals, actors);
    if (!qe) return;

    const hasDrift = qe.driftType === "reframed_topic"
      || qe.driftType === "shifted_topic"
      || qe.driftType === "transformed_topic";
    if (!hasDrift) return;

    console.log(`[question_drift] detected driftType=${qe.driftType} percent=${qe.driftPercent} proposals=${topic.proposals.length}`);
    this.finalizeDiscussion(goalRevId, "question_drift_detected", "question_drift_detected");
  }

  // ─── 최초 합의 기록 (중복 방지) ────────────────────────────────────
  private recordInitialConsensusOnce(goalRevId: number, winner: Revision): void {
    if (this.initialConsensusRecordedGoalIds.has(goalRevId)) {
      console.log("[target] initial consensus already recorded for this goal, skipping");
      return;
    }
    this.initialConsensusRecordedGoalIds.add(goalRevId);
    this.store.append("system", {
      type: "initial_consensus_noted",
      references: [winner.id],
      payload: {
        type:              "initial_consensus_noted",
        selected:          (winner.patch.payload as { value: string }).value,
        winner:            winner.author,
        convergenceSource: "auto_evaluator",
      },
      rationale: "최초 합의 기록 — 토론 계속 진행 (selectedOption 설정, status 유지)",
    });
    console.log("[target] initial consensus recorded, discussion continues");
  }

  // ─── 최종 종료 (discussion_paused 기록 + stopRun + onGoalsDone) ────
  private finalizeDiscussion(
    goalRevId:   number,
    reason:      string,
    pauseReason: DiscussionPausedPayload["reason"],
    rationale?:  string,
  ): void {
    if (this.decidedGoalRevIds.has(goalRevId)) return;
    this.decidedGoalRevIds.add(goalRevId);
    this.store.append("system", {
      type: "discussion_paused",
      payload: { type: "discussion_paused", reason: pauseReason },
      rationale: rationale ?? `[target] 종료 조건 달성 — ${reason}`,
    });
    this.stopRun(reason);
    console.log(`[target] target condition reached, finalizing discussion { reason: "${reason}" }`);
    this.onGoalsDone?.(this.buildRunResult());
  }

  // ─── verdict → pauseReason 매핑 ────────────────────────────────────
  private verdictToPauseReason(verdict: EvalVerdict): DiscussionPausedPayload["reason"] {
    switch (verdict) {
      case "stagnation":         return "stagnation";
      case "soft_consensus":     return "soft_consensus";
      case "convergence_freeze": return "discussion_exhausted";
      case "pseudo_convergence": return "pseudo_convergence";
      case "safety_limit":       return "safety_limit";
      default:                   return "stagnation";
    }
  }

  // ─── targetCondition별 종료 여부 결정 ──────────────────────────────
  /**
   * consensus 이외의 verdict에 대해, 현재 targetCondition에서 종료해야 하는지 판단.
   * MIN_PROPOSALS 가드는 호출 전에 처리하므로 여기서는 판단 로직만 담는다.
   */
  private shouldTerminateForTarget(targetCondition: TargetCondition, verdict: EvalVerdict): boolean {
    switch (targetCondition) {
      case "first_consensus":
        // consensus 이외 verdict (stagnation/freeze 등)는 모두 종료
        return true;

      case "structural_convergence":
        // soft_consensus / pseudo / freeze / stagnation → 종료 (구조 수렴 달성)
        return verdict === "soft_consensus"
          || verdict === "pseudo_convergence"
          || verdict === "convergence_freeze"
          || verdict === "stagnation";

      case "question_drift":
        // 주 종료는 checkQuestionDrift(); 보조: 의미 수렴 또는 소진 시 허용
        return verdict === "soft_consensus"
          || verdict === "pseudo_convergence"
          || verdict === "convergence_freeze"
          || verdict === "stagnation";

      case "exhaustive":
        // deep_evolution: finalization 단계에서만 종료
        return this.phaseController.isFinalization();
    }
  }

  /**
   * Evaluator 실행 — 새 pair round가 완성됐을 때만 판정 실행.
   *
   * 모드별 종료 전략:
   *  quick_conclusion     — 첫 consensus 즉시 종료 (MIN_PROPOSALS=2)
   *  structural_convergence — consensus는 최초 합의 기록만, soft/pseudo/freeze/stag 후 종료 (MIN=8)
   *  question_evolution   — consensus 기록만, checkQuestionDrift()가 주 종료 (MIN=8)
   *  deep_evolution       — finalization 단계 도달 후에만 수렴 신호로 종료 (MIN=12)
   */
  private runEvaluator(goalRevId: number): void {
    if (this.terminated) return;
    if (!this.evaluator || !this.evalBudget) return;
    if (this.decidedGoalRevIds.has(goalRevId)) return;

    const history    = this.store.getHistory();
    const topicStart = history.findIndex(r => r.id === goalRevId);
    if (topicStart === -1) return;
    const topicRevs = history.slice(topicStart);

    const state = this.store.rebuildState();
    const topic = state.topics.find(t => t.startRevId === goalRevId);
    // initial_consensus_noted는 status를 "active"로 유지하므로 여기서도 통과
    if (!topic || (topic.status !== "active" && topic.status !== "reopened")) return;

    const verdict = this.evaluator.maybeEvaluate(topicRevs, topic, this.evalBudget, this.evalAutoConsensus);
    if (verdict === null) return;

    // 매 pair round 완성 시 phase 전환 체크
    this.tryPhaseTransition();

    // finalization 단계에서 포화 수렴 감지 → 자동 종료
    if (verdict === "continue" && this.phaseController.isFinalization()) {
      this.checkConsensusSaturation(goalRevId, topic);
      if (this.terminated) return;
    }
    if (verdict === "continue") return;

    const targetCondition = this.evalBudget.targetCondition;
    const proposalCount   = topic.proposals.length;
    const pairCount       = this.evaluator.getPairCount();
    const minProposals    = MIN_PROPOSALS_BY_TARGET[targetCondition];
    const isForceTerminate = verdict === "safety_limit";

    // ── 상세 로그 ──────────────────────────────────────────────────
    const convHist   = this.evaluator.getConvergenceHistory();
    const convScore  = (convHist[convHist.length - 1] ?? 0).toFixed(2);
    console.log(`[target] evaluation { targetCondition="${targetCondition}" proposalCount=${proposalCount} minProposals=${minProposals} pairCount=${pairCount} verdict="${verdict}" isFinalization=${this.phaseController.isFinalization()} convergenceScore=${convScore} shouldCheckTerminate=${!isForceTerminate && proposalCount < minProposals ? "false(belowMin)" : "true"} }`);

    // ── deadlock: 기록만, 종료 없음 ────────────────────────────────
    if (verdict === "deadlock") {
      if (!this.deadlockWarned.has(goalRevId)) {
        this.deadlockWarned.add(goalRevId);
        this.store.append("system", {
          type: "discussion_deadlock",
          payload: {
            type:   "discussion_deadlock",
            reason: "교착 상태: AI들이 서로 다른 입장을 유지하고 있습니다. 최근 양보 없음.",
          },
          rationale: `sameLeaderRounds=${this.evaluator["sameLeaderRounds"]} pairCount=${pairCount}`,
        });
      }
      return;
    }

    // ── safety_limit: 항상 종료 (최소 proposal 무관) ───────────────
    if (verdict === "safety_limit") {
      if (!this.evalBudget.safetyLimitEnabled) {
        console.log(`[safety] limit reached but disabled — continuing (round=${pairCount})`);
        return;
      }
      console.log(`[safety] limit reached { reason: "maxRoundsPerWorker", limit: ${this.evalBudget.maxRoundsPerWorker} }`);
      this.finalizeDiscussion(
        goalRevId, "safety_limit", "safety_limit",
        `안전 한도 도달 — maxRoundsPerWorker=${this.evalBudget.maxRoundsPerWorker}`,
      );
      return;
    }

    // ── consensus: 모드별 분기 ─────────────────────────────────────
    if (verdict === "consensus") {
      const winner = selectByPolicy(topicRevs, history);
      if (!winner) return;

      if (targetCondition === "first_consensus" && proposalCount >= minProposals) {
        // quick_conclusion: 첫 합의로 최종 종료
        this.decidedGoalRevIds.add(goalRevId);
        this.store.append("system", {
          type: "consensus_reached",
          references: [winner.id],
          payload: {
            type:              "consensus_reached",
            selected:          (winner.patch.payload as { value: string }).value,
            winner:            winner.author,
            convergenceSource: "auto_evaluator",
          },
          rationale: "Evaluator: first_consensus target reached",
        });
        console.log("[target] target condition reached, finalizing discussion { reason: \"first_consensus\" }");
        // decided gate가 설정됐으므로 worker는 차단됨 → 자연 종료(pending→0)
      } else {
        // quick_conclusion 미만 proposal 수 / 또는 다른 모드: 최초 합의 기록 후 계속
        this.recordInitialConsensusOnce(goalRevId, winner);
        console.log("[target] initial consensus recorded, discussion continues");
      }
      return;
    }

    // ── MIN_PROPOSALS 미충족: phase 전환 시도 후 계속 ──────────────
    if (!isForceTerminate && proposalCount < minProposals) {
      const isConvergenceSignal = verdict === "stagnation"
        || verdict === "soft_consensus"
        || verdict === "convergence_freeze"
        || verdict === "pseudo_convergence";
      if (isConvergenceSignal && !this.phaseController.isFinalization()) {
        const hint = (verdict === "soft_consensus" || verdict === "pseudo_convergence")
          ? "soft_consensus" : "stagnation";
        const forced = this.phaseController.forceAdvance(pairCount, hint);
        if (forced) {
          this.applyPhaseTransition();
          console.log(`[phase] ${verdict} (belowMin proposals=${proposalCount}<${minProposals}) → advanced to "${this.phaseController.getCurrentPhase()}"`);
        }
      }
      console.log(`[target] below minProposals=${minProposals} (current=${proposalCount}), continuing`);
      return;
    }

    // ── MIN_PROPOSALS 충족 / 이상: targetCondition별 종료 판단 ────
    const shouldTerminate = this.shouldTerminateForTarget(targetCondition, verdict);

    if (!shouldTerminate) {
      // deep_evolution에서 finalization 이전: phase 전환 시도
      const isConvergenceSignal2 = verdict === "stagnation"
        || verdict === "soft_consensus"
        || verdict === "convergence_freeze"
        || verdict === "pseudo_convergence";
      if (isConvergenceSignal2 && !this.phaseController.isFinalization()) {
        const hint2 = (verdict === "soft_consensus" || verdict === "pseudo_convergence")
          ? "soft_consensus" : "stagnation";
        const forced2 = this.phaseController.forceAdvance(pairCount, hint2);
        if (forced2) {
          this.applyPhaseTransition();
          console.log(`[phase] ${verdict} → advanced to "${this.phaseController.getCurrentPhase()}"`);
        }
      }
      return;
    }

    // ── 최종 종료 ──────────────────────────────────────────────────
    const pauseReason = this.verdictToPauseReason(verdict);
    const rationale   = (() => {
      if (verdict === "convergence_freeze")
        return `novelty 소진 + entropy 붕괴 — Jaccard=${convScore} (${pairCount}라운드)`;
      if (verdict === "soft_consensus" || verdict === "pseudo_convergence")
        return `의미 수렴 감지 — actor간 Jaccard=${convScore} (${pairCount}라운드, targetCondition=${targetCondition})`;
      return `${verdict} 감지 — (${pairCount}라운드, targetCondition=${targetCondition})`;
    })();
    this.finalizeDiscussion(goalRevId, verdict, pauseReason, rationale);
  }

  private activeWorkerNames: string[] = [];

  private setupWorkers(budget: DiscussionBudget, autoConsensus: boolean, providers: ProvidersConfig): void {
    this.lastSentRevCount  = 0;
    this.decidedGoalRevIds.clear();
    this.deadlockWarned.clear();
    this.initialConsensusRecordedGoalIds.clear();
    this.phaseController.reset();
    this.phaseableWorkers        = [];
    this.memoryInjectableWorkers = [];

    // 새 run 시작 — runId 갱신 + isStopped 초기화
    this.activeRunId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    this.isStopped   = false;
    this.cleanupRound = null;   // subscribe 등록 전에 리셋; setupWorkers 후반에 할당됨
    console.log(`[live] new run started { runId: "${this.activeRunId}" }`);

    // safetyLimitEnabled=false → worker의 spokenAt 한도(maxRoundsPerWorker)도 해제
    // maxRoundsPerWorker=20 그대로두면 20라운드 후 모든 worker가 bail → round 완료 불가
    this.baseBudget = { ...budget };
    this.budgetInjectableWorkers = [];
    const effectiveBudget = this.toEffectiveBudget(this.baseBudget);

    // Provider 상태 스냅샷 로그 (버그 추적용)
    console.log("[providers] settings snapshot:", Object.fromEntries(PROVIDER_NAMES.map(name => [name, { enabled: providers[name].enabled, hasKey: !!providers[name].apiKey, model: providers[name].model }])));
    console.log("[budget] effective", this.formatBudgetForLog(effectiveBudget));

    type WorkerHandle = { handle: (rev: Revision, id: number | null) => Promise<void> };
    const workerEntries: Array<{ name: string; author: string; worker: WorkerHandle }> = [];

    for (const provider of PROVIDER_NAMES) {
      const config = providers[provider];
      if (!config.enabled) continue;
      const w = new RealGPTWorker(provider, config, this.store, this.metrics, effectiveBudget, providers.testMode, message => this.onStatus(message));
      this.phaseableWorkers.push(w);
      this.memoryInjectableWorkers.push(w);
      this.budgetInjectableWorkers.push(w);
      workerEntries.push({ name: `${PROVIDER_LABELS[provider]}${providers.testMode ? " (Test)" : ""}`, author: provider, worker: w });
    }

    if (workerEntries.length < 2) {
      throw new Error("실시간 토론에는 API 키가 설정된 AI provider가 최소 2개 필요합니다");
    }

    this.activeWorkerNames = workerEntries.map(e => e.name);
    this.evaluator         = new ConsensusEvaluator(workerEntries.map(e => e.author));
    this.evalBudget        = effectiveBudget;
    this.evalAutoConsensus = autoConsensus;

    const workerAuthors = workerEntries.map(e => e.author);
    console.log("[providers] active workers:", workerEntries.map(e => `${e.author}(real)`));
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

    // 종료 시 round 상태 즉시 정리 — stopRun에서 호출
    this.cleanupRound = () => {
      if (roundTimeoutHandle) { clearTimeout(roundTimeoutHandle); roundTimeoutHandle = null; }
      currentRoundId++;
      roundDispatchedActors.clear();
      roundSpokeActors.clear();
      roundBailedActors.clear();
    };

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
      const prevRoundId = currentRoundId;
      const spoke = [...roundSpokeActors];
      roundDispatchedActors.clear();
      roundSpokeActors.clear();
      roundBailedActors.clear();
      console.log(`[round] complete { roundId: ${prevRoundId}, resolvedActors: [${spoke.join(",")}] }`);
      if (currentGoalRevId !== null) {
        this.runEvaluator(currentGoalRevId);
        if (!this.terminated) this.checkQuestionDrift(currentGoalRevId);
      }
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

      // interjection → decided gate 해제 + memory 주입 + evaluator 리셋 + 라운드 리셋 + phase 리셋
      if (type === "user_interjection" && goalRevId !== null) {
        if (this.decidedGoalRevIds.has(goalRevId)) {
          console.log("[live] reopen topic, decided gate cleared", { goalRevId });
          this.decidedGoalRevIds.delete(goalRevId);
        }

        // 이전 세그먼트 분석을 추출해 memory worker들에 주입 (평가 리셋 전에 실행)
        const stateForMem = this.store.rebuildState();
        const topicForMem = stateForMem.topics.find(t => t.startRevId === goalRevId);
        if (topicForMem && topicForMem.proposals.length > 0) {
          const memCtxStr = this.buildMemoryContextString(topicForMem);
          if (memCtxStr) {
            for (const w of this.memoryInjectableWorkers) w.setMemoryContext(memCtxStr);
            console.log("[memory] injected to workers:", memCtxStr.slice(0, 80));
          }
        }

        this.deadlockWarned.delete(goalRevId);
        this.evaluator?.reset();
        this.phaseController.reset();
        // interjection 후 initial_position 지시를 다시 주입
        const instruction = this.phaseController.getPhaseInstruction();
        for (const w of this.phaseableWorkers) w.setPhaseInstruction(instruction);
        resetRound();
      }

      if (goalRevId !== null && this.decidedGoalRevIds.has(goalRevId)) return;

      // AI actor의 proposal이 도착 → 발언 기록 후 round 완료 여부 확인
      if (isProposal && workerAuthors.includes(rev.author)) {
        roundSpokeActors.add(rev.author);
        console.log(`[round] resolved { actor: "${rev.author}", status: "spoke" }`);
        checkRoundComplete(goalRevId);
        // completeRound → runEvaluator → safety_limit 이 terminated를 세웠을 수 있음
        if (this.terminated) return;
      }

      // 각 worker dispatch — proposal이면 round gate 적용
      for (let i = 0; i < workerEntries.length; i++) {
        const { name, author, worker } = workerEntries[i];

        // round gate: 이미 이 라운드에서 dispatch된 actor는 skip
        if (isProposal && roundDispatchedActors.has(author)) {
          console.log(`[live] skip dispatch (round gate): ${author} revId=${rev.id}`);
          continue;
        }

        if (isProposal) {
          // 새 라운드 첫 dispatch 시 timeout 시작
          if (roundDispatchedActors.size === 0) {
            console.log(`[round] start { roundId: ${currentRoundId}, expectedActors: [${workerAuthors.join(",")}] }`);
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
        this.track(async () => {
          // isStopped: 토론 종료 후 in-flight worker 응답 즉시 폐기
          if (this.isStopped) {
            console.log(`[live] worker blocked by isStopped { actor: "${name}", revId: ${rev.id} }`);
            return;
          }
          if (capturedGoalRevId !== null && this.decidedGoalRevIds.has(capturedGoalRevId)) {
            console.log("[live] worker blocked by decided gate", { goalRevId: capturedGoalRevId, revId: rev.id, name });
            return;
          }
          console.log("[live] worker allowed", { goalRevId: capturedGoalRevId, revId: rev.id, type, name });
          this.onStatus(`${name} responding...`);
          await worker.handle(rev, capturedGoalRevId);
          // 응답 수신 후에도 정지됐으면 — 상태 메시지 잔류 방지
          if (this.isStopped) this.onStatus("");
        }, () => {
          // terminated 이후 bail 노이즈 차단
          if (this.terminated) return;
          // stale 라운드의 bail callback 무시 — roundId가 다르면 이미 다른 라운드
          if (capturedRoundId !== currentRoundId) return;
          // track 완료 시 이 actor가 발언 없이 bail했으면 bailed 처리 후 round 완료 확인
          if (
            capturedIsProposal &&
            roundDispatchedActors.has(capturedAuthor) &&
            !roundSpokeActors.has(capturedAuthor)
          ) {
            roundBailedActors.add(capturedAuthor);
            console.log(`[round] resolved { actor: "${capturedAuthor}", status: "bail" }`);
            checkRoundComplete(capturedGoalRevId);
          }
        });
      }
    });
  }

  private buildRunResult(): RunResult {
    const state   = this.store.rebuildState();
    const history = this.store.getHistory();
    return {
      mode:          "live",
      metrics:       this.metrics,
      revisionCount: history.length,
      topics:        state.topics,
      history,
      analyses:      analyzeTopics(state.topics, history),
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
    budget: DiscussionBudget = DEPTH_BUDGETS.structural_convergence,
    onGoalsDone?: (result: RunResult) => void,
    consensusMode: ConsensusMode = "auto",
    providers?: ProvidersConfig,
  ): Promise<RunResult> {
    this.onGoalsDone = onGoalsDone;

    // providers가 없으면 env var 기반 기본값 사용 (하위 호환)
    const defaults = createDefaultProviders();
    defaults.gpt = { ...defaults.gpt, enabled: true, apiKey: process.env.OPENAI_API_KEY ?? "", model: "gpt-4o-mini" };
    defaults.claude = { ...defaults.claude, enabled: !process.env.GEMINI_API_KEY, apiKey: process.env.ANTHROPIC_API_KEY ?? "" };
    defaults.gemini = { ...defaults.gemini, enabled: !!process.env.GEMINI_API_KEY, apiKey: process.env.GEMINI_API_KEY ?? "" };
    const resolvedProviders: ProvidersConfig = providers ?? defaults;

    this.setupWorkers(budget, consensusMode === "auto", resolvedProviders);

    const isRealApi = !resolvedProviders.testMode && [resolvedProviders.gpt, resolvedProviders.claude, resolvedProviders.gemini].some(p => p.enabled && p.apiKey);
    const goalTimeoutMs = isRealApi ? 90_000 : 20_000;
    // safetyLimitEnabled=false → goal timeout 무제한 (main hard timeout에 의존)
    const effectiveGoalTimeoutMs = budget.safetyLimitEnabled ? goalTimeoutMs : Infinity;
    this.baseGoalTimeoutMs       = goalTimeoutMs;
    this.effectiveGoalTimeoutMs  = effectiveGoalTimeoutMs; // 재개 시 continuation loop에서 재사용

    // ── 초기 goal 실행 루프 ───────────────────────────────────────────
    for (const goal of goals) {
      if (this.terminated) break;
      console.log(`[live] starting goal: "${goal}" (mode=${discussionMode})`);
      this.store.append("user", {
        type: "set_goal",
        payload: { type: "set_goal", goal, mode: discussionMode },
      });

      const deadline = Date.now() + effectiveGoalTimeoutMs;
      while (this.pending > 0 && !this.terminated && Date.now() < deadline) {
        await sleep(100);
      }
      // effectiveGoalTimeoutMs=Infinity 이면 deadline < 현재시간은 불가능
      // → 이 블록은 safetyLimitEnabled=true 일 때만 실행됨
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
        this.stopRun("goal_timeout");
        // 타임아웃 경로에서도 done 전송 — 렌더러가 계속 stop 버튼을 표시하지 않도록
        this.onGoalsDone?.(this.buildRunResult());
      }
      console.log(`[live] goal done: "${goal}"`);
      this.flushInterjections();
    }

    if (!this.terminated) {
      this.onStatus("Decided ✓");
      // 초기 결과를 renderer에 전달 (liveRunning = false로 전환됨)
      onGoalsDone?.(this.buildRunResult());
    }

    await this.runContinuationLoop(this.activeRunId);

    return this.buildRunResult();
  }

  /**
   * interjection 사이클 루프 — runGoals 완료 후 & resumeFromStop 이후 공통으로 사용.
   * capturedRunId: 이 루프 인스턴스가 속한 runId.
   *   새 run(resumeFromStop)이 시작되면 activeRunId가 바뀌어 이 루프가 조기 종료됨.
   */
  private async runContinuationLoop(capturedRunId: string): Promise<void> {
    let lastActivity = Date.now();

    while (
      !this.terminated &&
      capturedRunId === this.activeRunId &&
      Date.now() - lastActivity < CONTINUATION_IDLE_TIMEOUT
    ) {
      if (this.interjectQueue.length > 0) {
        lastActivity = Date.now();
        this.flushInterjections();
        this.onStatus("토론 재개 중...");

        const deadline = Date.now() + this.effectiveGoalTimeoutMs;
        while (this.pending > 0 && !this.terminated && Date.now() < deadline) {
          await sleep(100);
        }

        if (!this.terminated) {
          this.onStatus("");
          this.pushUpdate();
          this.onGoalsDone?.(this.buildRunResult());
        }
      } else {
        await sleep(500);
      }
    }
  }

  /**
   * 토론이 종료(isStopped)된 후 새 추가 의견으로 새 segment 재개.
   * - terminated/isStopped 리셋 + 새 runId 생성
   * - subscribe 콜백은 setupWorkers에서 이미 등록됨 — workers 재등록 불필요
   * - 새 continuation loop를 백그라운드 task로 시작
   */
  private resumeFromStop(safetyLimitEnabled?: boolean): void {
    console.log("[live] reopening stopped discussion as new segment", { safetyLimitEnabled });
    this.refreshEffectiveBudgetForResume(safetyLimitEnabled);
    this.isStopped   = false;
    this.terminated  = false;
    this.activeRunId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    console.log(`[live] new run started { runId: "${this.activeRunId}" }`);
    const capturedRunId = this.activeRunId;
    this.runContinuationLoop(capturedRunId).catch(e =>
      console.error("[live] continuation error:", e),
    );
  }

  interject(message: string, options: { safetyLimitEnabled?: boolean } = {}): void {
    console.log("[live] interject options", { safetyLimitEnabled: options.safetyLimitEnabled });
    if (this.isStopped) {
      // 토론이 종료됐어도 새 segment로 재개 — run/topic 종료를 분리
      this.interjectQueue.push(message);
      this.resumeFromStop(options.safetyLimitEnabled);
      return;
    }
    this.refreshEffectiveBudgetForResume(options.safetyLimitEnabled);
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
        convergenceSource: "manual_policy",
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
        convergenceSource: "manual_select",
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
