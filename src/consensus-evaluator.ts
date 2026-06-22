/**
 * ConsensusEvaluator
 *
 * AI 발언(evidence)과 별개로 system/engine 레벨에서 합의를 판정한다.
 * LiveOrchestrator가 매 "pair round"(양 워커 각 1회 발언 완료) 후 호출한다.
 *
 * Verdict:
 *  "consensus"      — system consensus_reached 를 append해야 함
 *  "deadlock"       — 교착 경고 revision 을 append해야 함 (토론 계속)
 *  "safety_limit"   — 안전 한도 도달 → discussion_paused 를 append하고 종료
 *  "stagnation"     — 새 논거 소진, semantic loop → discussion_paused(stagnation) 종료
 *  "soft_consensus" — actor간 의미 수렴 감지 → discussion_paused(soft_consensus) 종료
 *  "continue"       — 아직 판정 불가, 다음 라운드 진행
 *  null             — 아직 새 pair round가 완성되지 않음 → evaluator 무시
 */

import type { Revision, Topic, DiscussionBudget } from "./types.js";
import { computeAggregation } from "./aggregation.js";
import { normalizeProposal } from "./aggregation.js";
import { NoveltyTracker, ConvergenceDetector } from "./novelty-tracker.js";
import { computeEntropyFromValues } from "./convergence-freeze.js";

export type EvalVerdict =
  | "consensus"
  | "deadlock"
  | "safety_limit"
  | "stagnation"
  | "soft_consensus"
  | "convergence_freeze"
  | "pseudo_convergence"   // 표면 불일치 유지, 의미 구조 수렴 (semantic loop)
  | "continue";

// ─── 비 stabilityMode (fast/balanced/deep autoConsensus) 임계값 ────
const AUTO_MIN_SCORE = 4;
const AUTO_MIN_GAP   = 2;

// ─── stabilityMode (until_consensus) 합의 임계값 ─────────────────
const STABLE_MIN_SCORE     = 8;
const STABLE_MIN_GAP       = 4;
const STABLE_LEADER_ROUNDS = 3;  // N라운드 연속 동일 1위
const STABLE_MAX_DRIFT     = 1;  // 최근 2라운드 내 입장 변화 허용 횟수

// ─── 교착 감지 임계값 ─────────────────────────────────────────────
const DEADLOCK_SAME_LEADER = 4;
const DEADLOCK_MAX_GAP     = 2;
const DEADLOCK_MIN_ROUNDS  = 4;

// ─── Stagnation 임계값 ────────────────────────────────────────────
const STAGNATION_WINDOW    = 3;   // 연속 몇 라운드 novelty 낮으면 판정
const STAGNATION_THRESHOLD = 0.08; // round novelty rate 임계
const STAGNATION_MIN_ROUNDS = 5;  // 최소 라운드 이상일 때만 판정

// ─── Convergence Freeze 임계값 ────────────────────────────────────
const FREEZE_MIN_ROUNDS      = 5;  // 최소 라운드
const FREEZE_ENTROPY_MAX     = 0.35; // entropy 이 미만이면 frozen
const FREEZE_NOVELTY_WINDOW  = 4;  // 연속 N 라운드 novelty 극저
const FREEZE_NOVELTY_MAX     = 0.05; // 극저 novelty 기준

// ─── Soft Consensus 임계값 ───────────────────────────────────────
const SOFT_CONSENSUS_MIN_SCORE  = 0.32; // actor간 Jaccard 평균 임계
const SOFT_CONSENSUS_TREND_RNDS = 3;    // 단조 증가 확인 라운드 수
const SOFT_CONSENSUS_MIN_ROUNDS = 4;    // 최소 라운드 이상일 때만 판정

export class ConsensusEvaluator {
  private pairCount         = 0;
  private prevLeaderKey:    string | null = null;
  private sameLeaderRounds  = 0;
  private deadlockEmitted   = false;

  private noveltyTracker    = new NoveltyTracker();
  private convergenceDetector = new ConvergenceDetector();

  constructor(private readonly workerAuthors: string[]) {}

  reset(): void {
    this.pairCount        = 0;
    this.prevLeaderKey    = null;
    this.sameLeaderRounds = 0;
    this.deadlockEmitted  = false;
    this.noveltyTracker.reset();
    this.convergenceDetector.reset();
  }

  /**
   * 새 proposal revision이 추가될 때마다 호출.
   * 양측 워커가 각각 한 번씩 발언을 완료한 "pair round"가 새로 완성됐을 때만
   * 판정을 실행하고 EvalVerdict를 반환한다. 그 전에는 null 반환.
   */
  maybeEvaluate(
    topicRevs: Revision[],
    topic:     Topic,
    budget:    DiscussionBudget,
    autoConsensus: boolean,
  ): EvalVerdict | null {
    if (!autoConsensus) return null;

    const proposals = topicRevs.filter(
      r => r.patch.payload.type === "propose_decision" ||
           r.patch.payload.type === "propose_alternative",
    );

    const counts       = this.workerAuthors.map(a => proposals.filter(r => r.author === a).length);
    const newPairCount = Math.max(...counts);

    if (newPairCount <= this.pairCount) return null;
    this.pairCount = newPairCount;

    // ── 안전 한도 먼저 체크 ───────────────────────────────────────
    if (newPairCount >= budget.maxRoundsPerWorker) return "safety_limit";

    // ── 품질 추적기 갱신 (매 round) ───────────────────────────────
    this.noveltyTracker.addRound(proposals);
    this.convergenceDetector.addRound(this.workerAuthors, proposals);

    const agg = computeAggregation(topic);
    if (agg.length === 0) return "continue";

    const top    = agg[0];
    const second = agg[1];
    const gap    = second ? top.score - second.score : top.score;

    // 1위 안정성 추적
    if (top.normalKey !== this.prevLeaderKey) {
      this.prevLeaderKey    = top.normalKey;
      this.sameLeaderRounds = 1;
      this.deadlockEmitted  = false;
    } else {
      this.sameLeaderRounds++;
    }

    return budget.stabilityMode
      ? this.evaluateStabilityMode(proposals, top, gap)
      : this.evaluateAutoMode(top, gap);
  }

  // ── 표준 autoConsensus 모드 ────────────────────────────────────
  private evaluateAutoMode(top: { score: number }, gap: number): EvalVerdict {
    if (top.score >= AUTO_MIN_SCORE && gap >= AUTO_MIN_GAP) return "consensus";
    return "continue";
  }

  // ── until_consensus stabilityMode ────────────────────────────
  private evaluateStabilityMode(
    proposals: Revision[],
    top:       { score: number; normalKey: string },
    gap:       number,
  ): EvalVerdict {
    const recentN    = Math.min(this.workerAuthors.length * 2, proposals.length);
    const recentProps = proposals.slice(-recentN);
    const olderProps  = proposals.slice(0, Math.max(0, proposals.length - recentN));

    // 최근 2라운드 내 입장 변화 수 (drift)
    const recentDrift = this.workerAuthors.filter(actor => {
      const actorRecent = recentProps.filter(r => r.author === actor);
      if (actorRecent.length < 2) return false;
      const vals = new Set(
        actorRecent.map(r => normalizeProposal((r.patch.payload as { value: string }).value)),
      );
      return vals.size > 1;
    }).length;

    const oldKeys = new Set(
      olderProps.map(r => normalizeProposal((r.patch.payload as { value: string }).value)),
    );
    const hasNewMajorProposal =
      olderProps.length > 0 &&
      recentProps.some(r => !oldKeys.has(normalizeProposal((r.patch.payload as { value: string }).value)));

    // ── 합의 판정 ─────────────────────────────────────────────
    if (
      top.score >= STABLE_MIN_SCORE &&
      gap       >= STABLE_MIN_GAP   &&
      this.sameLeaderRounds >= STABLE_LEADER_ROUNDS &&
      recentDrift           <= STABLE_MAX_DRIFT     &&
      !hasNewMajorProposal
    ) return "consensus";

    // ── Soft Consensus 판정 (수렴 중, 아직 완전 합의 아님) ─────
    if (
      this.pairCount >= SOFT_CONSENSUS_MIN_ROUNDS &&
      this.convergenceDetector.isSoftConsensus(SOFT_CONSENSUS_MIN_SCORE, SOFT_CONSENSUS_TREND_RNDS)
    ) return "soft_consensus";

    // ── 교착 판정 ─────────────────────────────────────────────
    const recentConcedes = recentProps.filter(
      r => (r.patch.payload as { stanceAction?: string }).stanceAction === "concede",
    ).length;

    if (
      !this.deadlockEmitted                         &&
      this.sameLeaderRounds >= DEADLOCK_SAME_LEADER &&
      gap < DEADLOCK_MAX_GAP                         &&
      recentConcedes === 0                           &&
      this.pairCount  >= DEADLOCK_MIN_ROUNDS
    ) {
      this.deadlockEmitted = true;
      return "deadlock";
    }

    // ── 논거 다양성 침체 교착 (기존 defend-only 체크) ───────────
    if (!this.deadlockEmitted && this.pairCount >= DEADLOCK_MIN_ROUNDS + 1) {
      const olderKeywords = new Set<string>();
      for (const r of olderProps) {
        const rat = r.patch.rationale ?? "";
        if (rat) rat.toLowerCase().split(/\s+/).forEach(t => { if (t.length >= 2) olderKeywords.add(t); });
      }
      const recentHasNovelty = recentProps.some(r => {
        const rat = r.patch.rationale ?? "";
        if (!rat) return false;
        return rat.toLowerCase().split(/\s+/).filter(t => t.length >= 2 && !olderKeywords.has(t)).length >= 2;
      });
      const recentDefendOnly =
        recentProps.length > 0 &&
        recentProps.every(r => (r.patch.payload as { stanceAction?: string }).stanceAction === "defend");

      if (!recentHasNovelty && recentDefendOnly && olderProps.length > 0) {
        this.deadlockEmitted = true;
        return "deadlock";
      }
    }

    // ── Convergence Freeze 판정 ──────────────────────────────────
    // entropy 붕괴 + 극저 novelty 연속 → discussion_exhausted 로 종료
    if (this.pairCount >= FREEZE_MIN_ROUNDS) {
      const noveltyRates = this.noveltyTracker.getRates();
      const recentRates  = noveltyRates.slice(-FREEZE_NOVELTY_WINDOW);
      const propValues   = proposals.map(
        r => (r.patch.payload as { value?: string }).value ?? "",
      );
      const entropyFrozen = computeEntropyFromValues(propValues) < FREEZE_ENTROPY_MAX;

      if (
        entropyFrozen &&
        recentRates.length >= FREEZE_NOVELTY_WINDOW &&
        recentRates.every(v => v <= FREEZE_NOVELTY_MAX)
      ) return "convergence_freeze";
    }

    // ── Pseudo-Convergence 판정 (semantic loop) ──────────────────
    // stagnation보다 먼저 체크: 표면 불일치는 유지되나 의미 구조는 수렴
    // 조건: novelty 저 + 수렴도 중간 이상 + 합의 점수는 아직 미달
    if (this.pairCount >= STAGNATION_MIN_ROUNDS) {
      const noveltyRates   = this.noveltyTracker.getRates();
      const recentRates    = noveltyRates.slice(-STAGNATION_WINDOW);
      const convHist       = this.convergenceDetector.getHistory();
      const convScore      = convHist[convHist.length - 1] ?? 0;
      const pseudoNoveltyLow = recentRates.length >= STAGNATION_WINDOW &&
        recentRates.every(v => v <= STAGNATION_THRESHOLD);

      if (pseudoNoveltyLow && convScore >= 0.30 && gap < AUTO_MIN_GAP) {
        return "pseudo_convergence";
      }
    }

    // ── Stagnation 판정 (novelty 고갈 → semantic loop) ──────────
    if (
      this.pairCount >= STAGNATION_MIN_ROUNDS &&
      this.noveltyTracker.isStagnating(STAGNATION_WINDOW, STAGNATION_THRESHOLD)
    ) return "stagnation";

    return "continue";
  }

  // ── 외부 접근자 ───────────────────────────────────────────────
  getPairCount():           number            { return this.pairCount; }
  getNoveltyRates():        readonly number[] { return this.noveltyTracker.getRates(); }
  getConvergenceHistory():  readonly number[] { return this.convergenceDetector.getHistory(); }
  getStagnationRounds():    number            { return this.noveltyTracker.stagnationRounds(STAGNATION_THRESHOLD); }

  /**
   * phase 전환 시 호출. novelty/convergence 이력만 초기화해 새 phase에서 다시 측정.
   * pairCount / leaderRounds 등 aggregation 상태는 유지.
   */
  resetForPhaseTransition(): void {
    this.noveltyTracker.resetRates();
    this.convergenceDetector.resetHistory();
    this.deadlockEmitted = false;
  }
}
