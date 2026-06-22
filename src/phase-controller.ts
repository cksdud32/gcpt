/**
 * PhaseController — 토론을 5단계로 구조화해 무한 semantic loop를 방지한다.
 *
 * Phase 흐름:
 *   initial_position → cross_critique → refinement → convergence_attempt → finalization
 *
 * LiveOrchestrator가 매 pair round 완료 후 onRoundComplete()를 호출한다.
 * stagnation/soft_consensus 감지 시 terminate 대신 forceAdvance()로 다음 phase 이동.
 */

export type DiscussionPhase =
  | "initial_position"
  | "cross_critique"
  | "refinement"
  | "convergence_attempt"
  | "finalization";

export interface PhaseState {
  phase:         DiscussionPhase;
  startRound:    number;   // 이 phase가 시작될 때의 evaluator pairCount
  roundsInPhase: number;   // 이 phase에서 완료된 round 수
}

export interface PhaseFlowSummary {
  phase:       DiscussionPhase;
  rounds:      number;
  keyEvent:    string;
  noveltyMean: number;
}

export const PHASE_ORDER: DiscussionPhase[] = [
  "initial_position",
  "cross_critique",
  "refinement",
  "convergence_attempt",
  "finalization",
];

export const PHASE_LABELS: Record<DiscussionPhase, string> = {
  initial_position:    "초기 입장",
  cross_critique:      "교차 비판",
  refinement:          "입장 정제",
  convergence_attempt: "수렴 시도",
  finalization:        "최종 판정",
};

// 각 phase별 AI 워커에게 주입할 영어 지시문 (JSON 출력 규칙과 언어 규칙은 SYSTEM에서 처리)
const PHASE_INSTRUCTIONS: Record<DiscussionPhase, string> = {
  initial_position:
    "DISCUSSION PHASE — Initial Position: " +
    "Present your core argument and supporting rationale clearly. " +
    "Do NOT rebut the other party yet — this is the position-setting phase.",

  cross_critique:
    "DISCUSSION PHASE — Cross Critique: " +
    "Identify a SPECIFIC weakness in the other party's premise and challenge it directly. " +
    "Introduce new evidence or counterarguments not yet stated. " +
    "Prefer stanceAction='defend' or 'propose'.",

  refinement:
    "DISCUSSION PHASE — Refinement: " +
    "Incorporate the strongest valid points from the opposing argument into your position. " +
    "Improve or narrow your stance rather than repeating prior arguments. " +
    "Prefer stanceAction='refine' or 'concede' where genuinely warranted.",

  convergence_attempt:
    "DISCUSSION PHASE — Convergence Attempt: " +
    "Actively seek a shared framework or common ground both parties can accept. " +
    "Explicitly name any remaining unresolvable conflict points. " +
    "Avoid restating positions already covered — move toward synthesis.",

  finalization:
    "DISCUSSION PHASE — Finalization: " +
    "Summarize your FINAL position in one concise sentence. " +
    "Acknowledge areas of agreement AND remaining irreconcilable differences. " +
    "Do not introduce new arguments.",
};

export function getPhaseInstruction(phase: DiscussionPhase): string {
  return PHASE_INSTRUCTIONS[phase];
}

// ─── Phase transition thresholds ─────────────────────────────────

const PHASE_ROUND_THRESHOLDS: Partial<Record<DiscussionPhase, number>> = {
  initial_position:    1,  // 1라운드 후 이동
  cross_critique:      2,  // 2라운드 후 이동
  refinement:          3,  // 3라운드 후 이동
  convergence_attempt: 4,  // 4라운드 OR 수렴/stagnation 조건 충족 시 이동
};

const CONVERGENCE_SCORE_THRESHOLD = 0.28; // actor간 Jaccard 평균 임계
const STAGNATION_FOR_CONV_ADVANCE = 2;    // convergence_attempt에서 연속 저-novelty 라운드 수

export class PhaseController {
  private state: PhaseState = {
    phase:         "initial_position",
    startRound:    0,
    roundsInPhase: 0,
  };
  private flow: PhaseFlowSummary[] = [];

  getCurrentPhase(): DiscussionPhase     { return this.state.phase; }
  getState():        Readonly<PhaseState> { return this.state; }
  getFlowSummary():  PhaseFlowSummary[]  { return [...this.flow]; }
  getPhaseInstruction(): string          { return PHASE_INSTRUCTIONS[this.state.phase]; }
  isFinalization():  boolean             { return this.state.phase === "finalization"; }

  /**
   * 매 pair round 완성 직후 호출.
   * true 반환 → phase가 전환됨. caller는 workers에 새 phase instruction을 주입해야 한다.
   */
  onRoundComplete(params: {
    pairCount:        number;
    noveltyRates:     readonly number[];
    convergenceScore: number;
    stagnationRounds: number;
  }): boolean {
    this.state.roundsInPhase++;
    const { phase, roundsInPhase } = this.state;
    const { pairCount, noveltyRates, convergenceScore, stagnationRounds } = params;

    let shouldAdvance = false;
    let keyEvent      = "";

    const threshold = PHASE_ROUND_THRESHOLDS[phase];
    if (phase === "finalization") return false;

    if (phase === "convergence_attempt") {
      // convergence_attempt: round 한도 OR 수렴 조건 OR stagnation 누적
      const byRound       = threshold !== undefined && roundsInPhase >= threshold;
      const byConvergence = convergenceScore >= CONVERGENCE_SCORE_THRESHOLD;
      const byStagnation  = stagnationRounds >= STAGNATION_FOR_CONV_ADVANCE;
      shouldAdvance = byRound || byConvergence || byStagnation;
      keyEvent =
        byConvergence ? `수렴도 ${(convergenceScore * 100).toFixed(0)}%` :
        byStagnation  ? `stagnation ${stagnationRounds}라운드` :
                        "수렴 시도 완료";
    } else {
      shouldAdvance = threshold !== undefined && roundsInPhase >= threshold;
      keyEvent = `${PHASE_LABELS[phase]} 완료`;
    }

    if (!shouldAdvance) return false;

    return this.doAdvance(phase, pairCount, roundsInPhase, noveltyRates, keyEvent);
  }

  /**
   * stagnation/soft_consensus 감지 시 강제로 다음 phase로 이동.
   * finalization이면 false 반환 → caller가 종료 처리.
   */
  forceAdvance(pairCount: number, reason: string): boolean {
    if (this.state.phase === "finalization") return false;
    const { phase, roundsInPhase } = this.state;
    return this.doAdvance(phase, pairCount, roundsInPhase, [], `강제 이동: ${reason}`);
  }

  reset(): void {
    this.state = { phase: "initial_position", startRound: 0, roundsInPhase: 0 };
    this.flow  = [];
  }

  // ── 내부 전환 헬퍼 ────────────────────────────────────────────

  private doAdvance(
    fromPhase:    DiscussionPhase,
    pairCount:    number,
    roundsInPhase: number,
    noveltyRates: readonly number[],
    keyEvent:     string,
  ): boolean {
    const noveltyMean =
      noveltyRates.length > 0
        ? noveltyRates.reduce((s, r) => s + r, 0) / noveltyRates.length
        : 0;

    this.flow.push({ phase: fromPhase, rounds: roundsInPhase, keyEvent, noveltyMean });

    const idx      = PHASE_ORDER.indexOf(fromPhase);
    const nextIdx  = Math.min(idx + 1, PHASE_ORDER.length - 1);
    const nextPhase = PHASE_ORDER[nextIdx];

    this.state = { phase: nextPhase, startRound: pairCount, roundsInPhase: 0 };
    console.log(
      `[phase] ${fromPhase} → ${nextPhase}  (totalRound=${pairCount}, event="${keyEvent}")`,
    );
    return true;
  }
}
