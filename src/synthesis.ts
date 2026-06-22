/**
 * Consensus Synthesis Layer
 *
 * AI 추가 호출 없이 revision graph에서 heuristic으로 합성 결론을 도출한다.
 *
 * selectByPolicy가 "가장 강했던 proposal"(early dominant)을 선택하는 편향을 보완:
 * → late-phase에서 actor 간 공유 키워드 coverage가 가장 높은 proposal을 합성 결론으로 선택.
 * → 논거 흡수(concede/refine)로 형성된 새 프레임을 추적한다.
 */

import type {
  Author, Proposal, SharedConcept, AbsorbedArgument,
  SynthesizedConsensus, RepetitionCluster, UnresolvedConflict,
} from "./types.js";
import { extractKeywordsNT } from "./novelty-tracker.js";

interface SynthesisOptions {
  repetitionClusters?:  RepetitionCluster[];
  unresolvedConflicts?: UnresolvedConflict[];
  isFinalization?:      boolean;
}

// ─── 유틸 ─────────────────────────────────────────────────────────

function propText(p: Proposal): string {
  const c = p.content as { value?: string; reason?: string };
  return `${c.value ?? ""} ${c.reason ?? ""} ${p.rationale ?? ""}`;
}

function buildPool(proposals: Proposal[]): Set<string> {
  const pool = new Set<string>();
  for (const p of proposals)
    for (const k of extractKeywordsNT(propText(p))) pool.add(k);
  return pool;
}

// ─── 메인 합성 함수 ───────────────────────────────────────────────

export function synthesizeConsensus(
  proposals:          Proposal[],
  actors:             Author[],
  convergenceHistory: number[],
  options:            SynthesisOptions = {},
): SynthesizedConsensus | null {
  if (proposals.length < 3 || actors.length < 2) return null;

  // ── 1. early / late window 분할 ─────────────────────────────
  const third      = Math.max(1, Math.ceil(proposals.length / 3));
  const earlyProps = proposals.slice(0, third);
  const lateProps  = proposals.slice(-third);

  // ── 2. actor별 early/late 키워드 풀 ─────────────────────────
  const earlyKwds = new Map<Author, Set<string>>();
  const lateKwds  = new Map<Author, Set<string>>();
  for (const actor of actors) {
    earlyKwds.set(actor, buildPool(earlyProps.filter(p => p.author === actor)));
    lateKwds.set(actor, buildPool(lateProps.filter(p => p.author === actor)));
  }

  // ── 3. late-phase 키워드 → 사용 actor 집합 ──────────────────
  const kwdActors = new Map<string, Set<Author>>();
  for (const [actor, pool] of lateKwds) {
    for (const kwd of pool) {
      if (!kwdActors.has(kwd)) kwdActors.set(kwd, new Set());
      kwdActors.get(kwd)!.add(actor);
    }
  }

  // 전체 빈도수 계산
  const kwdFreq = new Map<string, number>();
  for (const [kwd] of kwdActors) {
    let freq = 0;
    for (const p of proposals)
      if (propText(p).toLowerCase().includes(kwd)) freq++;
    kwdFreq.set(kwd, freq);
  }

  // ── 4. 공유 개념 (late-phase에서 ≥2 actor가 사용한 키워드) ──
  const sharedConcepts: SharedConcept[] = [];
  for (const [kwd, actorSet] of kwdActors) {
    if (actorSet.size < 2) continue;
    // 최초 도입 actor 탐색
    let firstActor: Author = actors[0];
    let firstIdx = Infinity;
    for (let i = 0; i < proposals.length; i++) {
      const p = proposals[i];
      if (actorSet.has(p.author) && propText(p).toLowerCase().includes(kwd) && i < firstIdx) {
        firstIdx = i;
        firstActor = p.author;
      }
    }
    sharedConcepts.push({
      keyword:    kwd,
      actors:     [...actorSet],
      frequency:  kwdFreq.get(kwd) ?? 1,
      firstActor,
    });
  }
  // 빈도 × actor 수 내림차순 정렬
  sharedConcepts.sort((a, b) => b.frequency * b.actors.length - a.frequency * a.actors.length);
  const topShared = sharedConcepts.slice(0, 8);
  const sharedSet = new Set(topShared.map(s => s.keyword));

  if (sharedSet.size === 0) return null; // 공통 프레임 없음

  // ── 5. 흡수된 논거 탐지 ─────────────────────────────────────
  // actor A의 late 키워드 중 A의 early에는 없고 actor B의 early에는 있으면 → A가 B로부터 흡수
  const absorbedArguments: AbsorbedArgument[] = [];
  for (const absorber of actors) {
    for (const originator of actors) {
      if (absorber === originator) continue;
      const latePool        = lateKwds.get(absorber)     ?? new Set();
      const earlyAbsorber   = earlyKwds.get(absorber)    ?? new Set();
      const earlyOriginator = earlyKwds.get(originator)  ?? new Set();
      for (const kwd of latePool) {
        if (!earlyAbsorber.has(kwd) && earlyOriginator.has(kwd)) {
          // 이미 기록된 (absorber, kwd) 쌍 중복 방지
          if (absorbedArguments.some(a => a.by === absorber && a.concept === kwd)) continue;
          const absRev = proposals.find(
            p => p.author === absorber && propText(p).toLowerCase().includes(kwd),
          );
          if (absRev) {
            absorbedArguments.push({
              from:       originator,
              by:         absorber,
              concept:    kwd,
              revisionId: absRev.revisionId,
            });
          }
        }
      }
    }
  }

  // ── 6. 미해결 키워드 (late-phase에서 한 actor만 유지) ────────
  const unresolvedKeywords: string[] = [];
  for (const [kwd, actorSet] of kwdActors) {
    if (actorSet.size === 1 && !sharedSet.has(kwd)) {
      unresolvedKeywords.push(kwd);
    }
  }

  // ── 7. 최적 합성 후보 선택 (late-phase) ─────────────────────
  // score = 공유키워드 coverage + stanceAction 보너스 (concede > refine > else)
  let bestProp:  Proposal | null = null;
  let bestScore  = -1;

  for (const prop of lateProps) {
    const kwds     = extractKeywordsNT(propText(prop));
    const overlap  = [...kwds].filter(k => sharedSet.has(k)).length;
    const c        = prop.content as { stanceAction?: string };
    const stanceBonus = c.stanceAction === "concede" ? 0.30
                      : c.stanceAction === "refine"  ? 0.20 : 0;
    const score = (kwds.size > 0 ? overlap / kwds.size : 0) + stanceBonus;
    if (score > bestScore) { bestScore = score; bestProp = prop; }
  }

  // fallback: 전체 proposals에서 역순으로 공유 키워드 있는 것 선택
  if (!bestProp) {
    for (let i = proposals.length - 1; i >= 0; i--) {
      const kwds = extractKeywordsNT(propText(proposals[i]));
      if ([...kwds].some(k => sharedSet.has(k))) { bestProp = proposals[i]; break; }
    }
  }
  if (!bestProp) return null;

  // ── 8. 합성 텍스트 구성 ─────────────────────────────────────
  const c = bestProp.content as { value: string; reason: string };
  const text = (c.reason && c.reason.trim().length > c.value.trim().length)
    ? `${c.value} — ${c.reason}`.slice(0, 200)
    : c.value.slice(0, 120);

  // ── 9. 신뢰도 점수 ──────────────────────────────────────────
  const lastConv        = convergenceHistory[convergenceHistory.length - 1] ?? 0;
  const concedeFraction = proposals.filter(p => {
    const sa = (p.content as { stanceAction?: string }).stanceAction;
    return sa === "concede" || sa === "refine";
  }).length / proposals.length;
  const sharedFraction = Math.min(1, topShared.length / 5);

  // Concede Chain Depth: 연속 concede 이벤트 최대 길이
  let concedeChainDepth = 0;
  let runLen = 0;
  for (const p of proposals) {
    const sa = (p.content as { stanceAction?: string }).stanceAction;
    if (sa === "concede") {
      runLen++;
      if (runLen > concedeChainDepth) concedeChainDepth = runLen;
    } else if (sa !== "refine") {
      runLen = 0;
    }
  }
  const concedeChainBonus = Math.min(0.15, concedeChainDepth * 0.05);

  // Mutual Adaptation: A가 B로부터, B가 A로부터 흡수한 쌍 개수
  const adaptationPairs = new Set<string>();
  for (const a of absorbedArguments) {
    for (const b of absorbedArguments) {
      if (a.by === b.from && a.from === b.by) {
        adaptationPairs.add([a.by, a.from].sort().join("::"));
      }
    }
  }
  const mutualAdaptationBonus = Math.min(0.10, adaptationPairs.size * 0.08);

  const confidence = Math.min(1,
    lastConv               * 0.28 +
    concedeFraction        * 0.35 +
    sharedFraction         * 0.20 +
    concedeChainBonus            +
    mutualAdaptationBonus,
  );

  // ── 10. 합성 근거 분류 ──────────────────────────────────────
  const basis: SynthesizedConsensus["basis"] =
    bestScore > 0.4              ? "convergence"  :
    absorbedArguments.length > 0 ? "late_concede" :
    topShared.length >= 3        ? "dominant"     : "fallback";

  const synthesisNote = buildNote(actors, topShared, absorbedArguments, basis);

  // ── 11. 합성 품질 점수 ──────────────────────────────────────────
  // base: confidence
  // + concede chain bonus (흡수 논거 ≥ 2개)
  // + finalization bonus
  // - repetition penalty (반복 클러스터 비중)
  // - unresolved conflict penalty
  let qualityScore = confidence;

  if (absorbedArguments.length >= 2) qualityScore += 0.05;
  if (concedeChainDepth >= 2)         qualityScore += 0.08;  // 연속 양보 체인 보너스
  if (adaptationPairs.size > 0)       qualityScore += 0.06;  // 상호 적응 보너스
  if (options.isFinalization)          qualityScore += 0.08;

  if (options.repetitionClusters && options.repetitionClusters.length > 0) {
    const totalReps = options.repetitionClusters.reduce((s, c) => s + c.count, 0);
    const repPenalty = Math.min(0.25, totalReps / (proposals.length * 2.5));
    qualityScore -= repPenalty;
  }

  if (options.unresolvedConflicts && options.unresolvedConflicts.length > 0)
    qualityScore -= options.unresolvedConflicts.length * 0.05;

  const synthesisQualityScore = Math.max(0, Math.min(1, qualityScore));

  return {
    text,
    confidence,
    basis,
    sharedConcepts:      topShared,
    absorbedArguments:   absorbedArguments.slice(0, 6),
    unresolvedKeywords:  unresolvedKeywords.slice(0, 6),
    synthesisNote,
    synthesisQualityScore,
  };
}

// ─── 합성 설명 생성 ───────────────────────────────────────────────

function buildNote(
  actors:            Author[],
  sharedConcepts:    SharedConcept[],
  absorbedArguments: AbsorbedArgument[],
  basis:             SynthesizedConsensus["basis"],
): string {
  if (basis === "fallback" || sharedConcepts.length === 0) {
    return "공통 합성 프레임이 약합니다. 의미 있는 수렴이 감지되지 않았습니다.";
  }

  const topKwds = sharedConcepts.slice(0, 3).map(s => `'${s.keyword}'`).join(", ");

  // 흡수 사례 요약
  const absMap = new Map<string, string[]>(); // "by|from" → concepts
  for (const a of absorbedArguments.slice(0, 4)) {
    const key = `${a.by}|${a.from}`;
    if (!absMap.has(key)) absMap.set(key, []);
    absMap.get(key)!.push(a.concept);
  }

  const absParts = [...absMap.entries()].map(([key, kwds]) => {
    const [by, from] = key.split("|");
    return `${by}가 ${from}의 논거(${kwds.slice(0, 2).join(", ")})를 흡수`;
  });

  if (basis === "convergence") {
    const absNote = absParts.length > 0 ? ` ${absParts.join("; ")}.` : "";
    return `강한 의미 수렴 감지. 공유 개념(${topKwds}) 중심으로 합의 구조 형성.${absNote}`;
  }

  if (basis === "late_concede" && absParts.length > 0) {
    return `공유 개념(${topKwds}) 중심으로 수렴. ${absParts.join("; ")}.`;
  }

  return `${actors.join(" ↔ ")} 간 공유 개념(${topKwds})을 중심으로 합의 구조가 형성되었습니다.`;
}
