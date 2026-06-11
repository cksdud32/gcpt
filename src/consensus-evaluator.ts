/**
 * ConsensusEvaluator
 *
 * AI 발언(evidence)과 별개로 system/engine 레벨에서 합의를 판정한다.
 * LiveOrchestrator가 매 "pair round"(양 워커 각 1회 발언 완료) 후 호출한다.
 *
 * Verdict:
 *  "consensus"     — system consensus_reached 를 append해야 함
 *  "deadlock"      — 교착 경고 revision 을 append해야 함 (토론 계속)
 *  "safety_limit"  — 안전 한도 도달 → discussion_paused 를 append하고 종료
 *  "continue"      — 아직 판정 불가, 다음 라운드 진행
 *  null            — 아직 새 pair round가 완성되지 않음 → evaluator 무시
 */

import type { Revision, Topic, DiscussionBudget } from "./types.js";
import { computeAggregation } from "./aggregation.js";
import { normalizeProposal } from "./aggregation.js";

export type EvalVerdict = "consensus" | "deadlock" | "safety_limit" | "continue";

// ─── 비 stabilityMode (fast/balanced/deep autoConsensus) 임계값 ────
const AUTO_MIN_SCORE = 4;
const AUTO_MIN_GAP   = 2;

// ─── stabilityMode (until_consensus) 합의 임계값 ─────────────────
const STABLE_MIN_SCORE    = 8;
const STABLE_MIN_GAP      = 4;
const STABLE_LEADER_ROUNDS = 3;   // N라운드 연속 동일 1위
const STABLE_MAX_DRIFT    = 1;    // 최근 2라운드 내 입장 변화 허용 횟수

// ─── 교착 감지 임계값 ─────────────────────────────────────────────
const DEADLOCK_SAME_LEADER = 4;   // 1위가 4라운드 연속 같아야 함
const DEADLOCK_MAX_GAP     = 2;   // 그런데도 점수 격차 < 2 (팽팽)
const DEADLOCK_MIN_ROUNDS  = 4;   // 최소 4라운드는 지나야 교착 판정

export class ConsensusEvaluator {
  private pairCount        = 0;                // 완성된 pair round 수
  private prevLeaderKey:   string | null = null;
  private sameLeaderRounds = 0;
  private deadlockEmitted  = false;            // 교착 경고 중복 방지

  constructor(private readonly workerAuthors: string[]) {}

  reset(): void {
    this.pairCount        = 0;
    this.prevLeaderKey    = null;
    this.sameLeaderRounds = 0;
    this.deadlockEmitted  = false;
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

    // 워커별 발언 횟수의 최솟값 = 완성된 pair round 수
    const counts = this.workerAuthors.map(a => proposals.filter(r => r.author === a).length);
    const newPairCount = Math.min(...counts);

    if (newPairCount <= this.pairCount) return null; // 아직 새 라운드 미완성
    this.pairCount = newPairCount;

    // 안전 한도 먼저 체크
    if (newPairCount >= budget.maxRoundsPerWorker) return "safety_limit";

    const agg = computeAggregation(topic);
    if (agg.length === 0) return "continue";

    const top    = agg[0];
    const second = agg[1];
    const gap    = second ? top.score - second.score : top.score;

    // 1위 안정성 추적
    if (top.normalKey !== this.prevLeaderKey) {
      this.prevLeaderKey    = top.normalKey;
      this.sameLeaderRounds = 1;
      this.deadlockEmitted  = false; // 리더 바뀌면 교착 플래그 리셋
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

    // 최근 라운드에 새 normalKey가 등장했는지 여부
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

    // ── 교착 판정 ─────────────────────────────────────────────
    // 양보(concede) stanceAction이 없고, 오래 팽팽하게 지속되는 경우
    const recentConcedes = recentProps.filter(
      r => (r.patch.payload as { stanceAction?: string }).stanceAction === "concede",
    ).length;

    if (
      !this.deadlockEmitted                     &&
      this.sameLeaderRounds >= DEADLOCK_SAME_LEADER &&
      gap < DEADLOCK_MAX_GAP                    &&
      recentConcedes === 0                      &&
      this.pairCount  >= DEADLOCK_MIN_ROUNDS
    ) {
      this.deadlockEmitted = true;
      return "deadlock";
    }

    return "continue";
  }
}
