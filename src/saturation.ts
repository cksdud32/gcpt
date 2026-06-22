/**
 * Consensus Saturation Detector
 *
 * AI 추가 호출 없이 novelty/convergence/repetition 지표로
 * "토론이 의미적으로 충분히 수렴했는지"를 감지한다.
 *
 * 목적: 단순 token 절약이 아닌, 새 논거 없이 표현 변형만 반복되는
 * 구조를 감지해 GCPT를 "합의 형성 엔진"으로 진화시킨다.
 */

import type { Author, Proposal, UnresolvedConflict, RepetitionCluster, ConsensusSaturation } from "./types.js";
import { normalizeProposal } from "./aggregation.js";

// ─── 반복 클러스터 감지 ───────────────────────────────────────────

export function detectRepetitionClusters(proposals: Proposal[]): RepetitionCluster[] {
  const clusterMap = new Map<string, {
    canonical: string;
    actors:    Set<Author>;
    count:     number;
    revisions: number[];
  }>();

  for (const p of proposals) {
    const val     = (p.content as { value: string }).value;
    const normKey = normalizeProposal(val);

    const entry = clusterMap.get(normKey) ?? {
      canonical: val,
      actors:    new Set<Author>(),
      count:     0,
      revisions: [],
    };
    entry.actors.add(p.author);
    entry.count++;
    entry.revisions.push(p.revisionId);
    clusterMap.set(normKey, entry);
  }

  return [...clusterMap.values()]
    .filter(c => c.count >= 2)
    .map(c => ({
      canonical: c.canonical,
      actors:    [...c.actors],
      count:     c.count,
      revisions: c.revisions,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);
}

// ─── 포화 감지 메인 ───────────────────────────────────────────────

export function detectConsensusSaturation(
  proposals:           Proposal[],
  convergenceHistory:  readonly number[],
  noveltyDecayRates:   readonly number[],
  unresolvedConflicts: UnresolvedConflict[] = [],
): ConsensusSaturation {
  // 반복 클러스터
  const repetitionClusters = detectRepetitionClusters(proposals);

  // ── 수렴도 ────────────────────────────────────────────────────
  const lastConv = convergenceHistory[convergenceHistory.length - 1] ?? 0;

  // ── 최근 5라운드 novelty 평균 ────────────────────────────────
  const recentNovelty = noveltyDecayRates.slice(-5);
  const avgNovelty    = recentNovelty.length > 0
    ? recentNovelty.reduce((s, r) => s + r, 0) / recentNovelty.length
    : 1;

  // ── defend/refine 비율 (최근 절반 proposals) ─────────────────
  const recentProps  = proposals.slice(-Math.ceil(proposals.length / 2));
  const defendCount  = recentProps.filter(p => {
    const sa = (p.content as { stanceAction?: string }).stanceAction;
    return sa === "defend" || sa === "refine";
  }).length;
  const defendRatio  = recentProps.length > 0 ? defendCount / recentProps.length : 0;

  // ── 반복 비율 ────────────────────────────────────────────────
  const totalReps      = repetitionClusters.reduce((s, c) => s + c.count, 0);
  const repetitionRatio = proposals.length > 0
    ? Math.min(1, totalReps / proposals.length)
    : 0;

  // ── 저-novelty 점수 (novelty가 낮을수록 높음) ─────────────────
  const lowNoveltyScore = Math.max(0, 1 - avgNovelty / 0.15);

  // ── 신뢰도 계산 ──────────────────────────────────────────────
  const confidence = Math.min(1,
    lastConv        * 0.40 +
    repetitionRatio * 0.30 +
    lowNoveltyScore * 0.30,
  );

  // ── 포화 판단 기준 ────────────────────────────────────────────
  const convergenceMet  = lastConv >= 0.82;
  const noveltyMet      = avgNovelty <= 0.15;
  const conflictsMet    = unresolvedConflicts.length <= 1;
  const repetitionMet   = repetitionRatio >= 0.40 || defendRatio >= 0.65;

  const saturated = convergenceMet && noveltyMet && conflictsMet && repetitionMet;

  // ── 이유 생성 ─────────────────────────────────────────────────
  let reason: string;
  if (saturated) {
    reason = `수렴도 ${(lastConv * 100).toFixed(0)}%, 평균 novelty ${(avgNovelty * 100).toFixed(0)}% — 의미적 포화 상태. 새로운 논거 없이 표현 변형만 반복 중.`;
  } else {
    const missing: string[] = [];
    if (!convergenceMet)
      missing.push(`수렴도 부족 (${(lastConv * 100).toFixed(0)}% < 82%)`);
    if (!noveltyMet)
      missing.push(`novelty 미소진 (${(avgNovelty * 100).toFixed(0)}% > 15%)`);
    if (!conflictsMet)
      missing.push(`미해결 충돌 ${unresolvedConflicts.length}개`);
    if (!repetitionMet)
      missing.push(`반복 비율 미달 (defend ${(defendRatio * 100).toFixed(0)}%)`);
    reason = missing.length > 0 ? missing.join("; ") : "포화 조건 미충족";
  }

  return { saturated, confidence, reason, repetitionClusters };
}
