/**
 * Convergence Freeze System
 *
 * "새로운 정보 없는 반복 defend"를 토론 지속이 아니라 수렴 완료로 간주.
 *
 * 핵심 감지 3가지:
 *   branch_frozen        — 동일 semantic defend 반복 → argument entropy 붕괴
 *   semantic_convergence — actor간 의미 유사도 > 0.88 고수렴
 *   discussion_exhausted — novelty 완전 소진 + 지배 branch 존재 → 수렴 완료
 */

import type {
  Proposal, BranchSurvivalAnalysis,
  ProposalNoveltyScore, ConvergenceFreezeAnalysis, ConvergenceFreezeType,
} from "./types.js";
import { normalizeProposal } from "./aggregation.js";
import { extractKeywordsNT } from "./novelty-tracker.js";

// ─── 상수 ─────────────────────────────────────────────────────────

const NOVELTY_STAGNANT_THRESHOLD = 0.10;  // 이 미만이면 stagnant
const ENTROPY_FROZEN_THRESHOLD   = 0.35;  // Shannon 정규화 이 미만이면 frozen
const CONVERGENCE_HIGH_THRESHOLD = 0.88;  // Jaccard 이 이상이면 semantic_convergence
const DEFEND_FREEZE_COUNT        = 4;     // 동일 normalKey defend 횟수
const EXHAUSTED_WINDOW           = 8;     // 최근 N 발언 모두 novelty 낮아야 exhausted
const EXHAUSTED_NOVELTY_MAX      = 0.05;  // exhausted 판단 novelty 상한

// ─── 유틸 ─────────────────────────────────────────────────────────

function propText(p: Proposal): string {
  const c = p.content as { value?: string; reason?: string };
  return `${c.value ?? ""} ${c.reason ?? ""} ${p.rationale ?? ""}`;
}

// ─── 1. Proposal별 novelty 점수 계산 ─────────────────────────────

export function computeProposalNoveltyScores(proposals: Proposal[]): ProposalNoveltyScore[] {
  const seenKwds      = new Set<string>();
  const actorLastStance = new Map<string, string>();
  const scores: ProposalNoveltyScore[] = [];

  for (const p of proposals) {
    const kwds      = extractKeywordsNT(propText(p));
    const newKwds   = [...kwds].filter(k => !seenKwds.has(k));
    const sa        = (p.content as { stanceAction?: string }).stanceAction ?? "propose";
    const prevStance = actorLastStance.get(p.author);
    const stanceShift = prevStance !== undefined && prevStance !== sa;

    const newKwdCount = newKwds.length;
    const totalKwds   = kwds.size;
    const kwdRatio    = totalKwds > 0 ? newKwdCount / totalKwds : 0;
    const novelty     = Math.min(1, kwdRatio + (stanceShift ? 0.15 : 0));

    scores.push({
      revisionId:      p.revisionId,
      novelty,
      newKeywordCount: newKwdCount,
      totalKeywords:   totalKwds,
      stanceShift,
    });

    for (const k of newKwds) seenKwds.add(k);
    actorLastStance.set(p.author, sa);
  }

  return scores;
}

// ─── 2. Argument Entropy 계산 (Shannon, 정규화) ───────────────────

function entropyFromFreqMap(freq: Map<string, number>, n: number): number {
  const uniqueKeys = freq.size;
  if (uniqueKeys <= 1) return 0;

  let entropy = 0;
  for (const count of freq.values()) {
    const prob = count / n;
    entropy -= prob * Math.log2(prob);
  }
  return entropy / Math.log2(uniqueKeys);
}

/** Proposal value 문자열 목록으로 entropy 계산 (evaluator에서 사용) */
export function computeEntropyFromValues(values: string[]): number {
  if (values.length === 0) return 1.0;
  const freq = new Map<string, number>();
  for (const v of values) {
    const key = normalizeProposal(v);
    freq.set(key, (freq.get(key) ?? 0) + 1);
  }
  return entropyFromFreqMap(freq, values.length);
}

export function computeArgumentEntropy(proposals: Proposal[]): number {
  if (proposals.length === 0) return 1.0;

  const freq = new Map<string, number>();
  for (const p of proposals) {
    const key = normalizeProposal((p.content as { value?: string }).value ?? "");
    freq.set(key, (freq.get(key) ?? 0) + 1);
  }
  return entropyFromFreqMap(freq, proposals.length);
}

// ─── 3. Branch Frozen 감지 ────────────────────────────────────────

function detectBranchFrozenRevId(proposals: Proposal[]): number | undefined {
  const actorDefendMap = new Map<string, { count: number; revId: number }>();

  for (const p of proposals) {
    const sa  = (p.content as { stanceAction?: string }).stanceAction;
    if (sa !== "defend") continue;

    const key = `${p.author}::${normalizeProposal((p.content as { value?: string }).value ?? "")}`;
    const entry = actorDefendMap.get(key) ?? { count: 0, revId: p.revisionId };
    entry.count++;
    if (entry.count === 1) entry.revId = p.revisionId;
    actorDefendMap.set(key, entry);

    if (entry.count >= DEFEND_FREEZE_COUNT) return p.revisionId;
  }
  return undefined;
}

// ─── 4. Semantic Convergence 감지 ────────────────────────────────

function detectSemanticConvergenceRevId(
  proposals:          Proposal[],
  convergenceHistory: readonly number[],
): number | undefined {
  if (convergenceHistory.length < 3) return undefined;

  const last3 = convergenceHistory.slice(-3);
  if (last3.every(v => v >= CONVERGENCE_HIGH_THRESHOLD)) {
    // 몇 번째 proposal에서 수렴이 시작됐는지 추정 (convergenceHistory round당 actors.length개 proposals)
    const approxIdx = Math.max(0, proposals.length - last3.length * 2);
    return proposals[approxIdx]?.revisionId;
  }
  return undefined;
}

// ─── 5. Discussion Exhausted 감지 ────────────────────────────────

function detectExhaustedRevId(
  noveltyScores:  ProposalNoveltyScore[],
  branchSurvival: BranchSurvivalAnalysis | undefined,
): number | undefined {
  if (!branchSurvival?.dominantBranch) return undefined;
  if (branchSurvival.dominantBranch.concedeDepth + branchSurvival.dominantBranch.refineDepth === 0) return undefined;
  if (noveltyScores.length < EXHAUSTED_WINDOW) return undefined;

  const window = noveltyScores.slice(-EXHAUSTED_WINDOW);
  if (window.every(s => s.novelty <= EXHAUSTED_NOVELTY_MAX)) {
    return window[0].revisionId;
  }
  return undefined;
}

// ─── 6. Last Meaningful Revision 탐색 ────────────────────────────

function findLastMeaningfulRevId(noveltyScores: ProposalNoveltyScore[]): number | undefined {
  for (let i = noveltyScores.length - 1; i >= 0; i--) {
    if (noveltyScores[i].novelty > NOVELTY_STAGNANT_THRESHOLD) {
      return noveltyScores[i].revisionId;
    }
  }
  return undefined;
}

// ─── 7. Entropy Collapse 시점 탐색 ───────────────────────────────

function findEntropyCollapseRevId(proposals: Proposal[]): number | undefined {
  for (let i = 4; i < proposals.length; i++) {
    const entropy = computeArgumentEntropy(proposals.slice(0, i + 1));
    if (entropy < ENTROPY_FROZEN_THRESHOLD) return proposals[i].revisionId;
  }
  return undefined;
}

// ─── 메인 함수 ───────────────────────────────────────────────────

export function detectConvergenceFreeze(
  proposals:          Proposal[],
  branchSurvival:     BranchSurvivalAnalysis | undefined,
  convergenceHistory: readonly number[],
): ConvergenceFreezeAnalysis {
  if (proposals.length < 4) {
    return {
      frozen:          false,
      argumentEntropy: 1.0,
      noveltyScores:   [],
      reason:          "발언 수 부족 — freeze 감지 불가",
    };
  }

  const noveltyScores   = computeProposalNoveltyScores(proposals);
  const argumentEntropy = computeArgumentEntropy(proposals);
  const lastMeaningfulRevisionId = findLastMeaningfulRevId(noveltyScores);
  const entropyCollapseRevisionId = argumentEntropy < ENTROPY_FROZEN_THRESHOLD
    ? findEntropyCollapseRevId(proposals) : undefined;

  // 우선순위: discussion_exhausted > semantic_convergence > branch_frozen
  let freezeType: ConvergenceFreezeType | undefined;
  let frozenAtRevisionId: number | undefined;
  let convergenceMoment: string | undefined;

  const exhaustedRevId = detectExhaustedRevId(noveltyScores, branchSurvival);
  const semanticRevId  = detectSemanticConvergenceRevId(proposals, convergenceHistory);
  const branchRevId    = detectBranchFrozenRevId(proposals);

  if (exhaustedRevId !== undefined) {
    freezeType           = "discussion_exhausted";
    frozenAtRevisionId   = exhaustedRevId;
    const db = branchSurvival?.dominantBranch;
    convergenceMoment    = db
      ? `최근 ${EXHAUSTED_WINDOW}개 발언 novelty 소진 — '${[...db.actors].join("+")}' 공동 논리 lineage 생존으로 수렴 완료`
      : `최근 ${EXHAUSTED_WINDOW}개 발언 novelty 소진 — 더 이상 새로운 논거 없음`;

  } else if (semanticRevId !== undefined) {
    freezeType         = "semantic_convergence";
    frozenAtRevisionId = semanticRevId;
    const lastConv = convergenceHistory[convergenceHistory.length - 1] ?? 0;
    convergenceMoment  = `actor간 의미 유사도 ${(lastConv * 100).toFixed(0)}% — 3라운드 연속 ${(CONVERGENCE_HIGH_THRESHOLD * 100).toFixed(0)}% 이상 유지`;

  } else if (branchRevId !== undefined && argumentEntropy < ENTROPY_FROZEN_THRESHOLD) {
    freezeType         = "branch_frozen";
    frozenAtRevisionId = branchRevId;
    convergenceMoment  = `동일 semantic defend ${DEFEND_FREEZE_COUNT}회 이상 반복 — argument entropy ${(argumentEntropy * 100).toFixed(0)}% (임계 ${(ENTROPY_FROZEN_THRESHOLD * 100).toFixed(0)}% 미만)`;
  }

  const frozen = freezeType !== undefined;

  let reason: string;
  if (!frozen) {
    const reasons: string[] = [];
    if (exhaustedRevId === undefined && branchSurvival?.dominantBranch) {
      const recentWindow = noveltyScores.slice(-EXHAUSTED_WINDOW);
      const avgNovelty = recentWindow.length > 0
        ? recentWindow.reduce((s, x) => s + x.novelty, 0) / recentWindow.length : 1;
      reasons.push(`novelty 평균 ${(avgNovelty * 100).toFixed(0)}% (기준 ${EXHAUSTED_NOVELTY_MAX * 100}%)`);
    }
    if (!branchSurvival?.dominantBranch) reasons.push("지배적 생존 branch 없음");
    const lastConv = convergenceHistory[convergenceHistory.length - 1] ?? 0;
    if (lastConv < CONVERGENCE_HIGH_THRESHOLD) reasons.push(`수렴도 ${(lastConv * 100).toFixed(0)}% (기준 ${CONVERGENCE_HIGH_THRESHOLD * 100}%)`);
    reason = reasons.length > 0 ? `미동결: ${reasons.join("; ")}` : "미동결";
  } else {
    reason = convergenceMoment ?? freezeType!;
  }

  return {
    frozen,
    freezeType,
    frozenAtRevisionId,
    argumentEntropy,
    lastMeaningfulRevisionId,
    noveltyScores,
    entropyCollapseRevisionId,
    convergenceMoment,
    reason,
  };
}
