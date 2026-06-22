/**
 * Evolution Pressure System
 *
 * "누가 살아남았는가"가 아닌 "누가 논리를 진화시켰는가"를 측정한다.
 *
 * 핵심 지표:
 *  - SemanticPersistencePenalty : 동일 semantic defend 반복 시 decay
 *  - EvolutionMomentum          : refine/concede/synthesis 기반 진화 점수
 *  - BranchInnovation           : proposal별 혁신성 점수
 */

import type {
  Author, Proposal,
  ActorEvolutionMomentum, InnovationMoment, EvolutionPressureAnalysis,
} from "./types.js";
import { normalizeProposal } from "./aggregation.js";

// ─── Persistence Decay 상수 ────────────────────────────────────────
// 같은 actor가 동일 semantic 을 defend할수록 급격히 감쇠
// 1회: 1.0 / 2회: 0.72 / 3회: 0.51 / 4회: 0.36 / 5+회: 0.22
export const DEFENSE_DECAY = [1.0, 0.72, 0.51, 0.36, 0.22];

// ─── 유틸 ──────────────────────────────────────────────────────────

const EN_STOPWORDS = new Set([
  "the","a","an","is","are","was","were","be","been","have","has","had",
  "do","does","did","will","would","could","should","may","to","of","in",
  "on","at","by","for","with","as","from","or","and","but","if","it",
  "its","this","that","these","those","not","no",
]);

function extractKws(text: string): string[] {
  if (!text) return [];
  return [...new Set(
    text.toLowerCase()
      .split(/[\s,.:;!?()\[\]{}"']+/)
      .filter(t => t.length >= 2 && !EN_STOPWORDS.has(t)),
  )];
}

function propText(p: Proposal): string {
  const c = p.content as { value?: string; reason?: string };
  return `${c.value ?? ""} ${c.reason ?? ""} ${p.rationale ?? ""}`.trim();
}

// ─── computeSemanticPersistencePenalty ────────────────────────────

/**
 * 각 proposal(revisionId)의 semantic persistence decay 계수를 반환.
 * defend 이외 proposal은 1.0 (감쇠 없음).
 * 같은 actor가 동일 normalKey 를 defend 할수록 DEFENSE_DECAY 적용.
 *
 * Returns: Map<revisionId, decayFactor>
 */
export function computeSemanticPersistencePenalty(
  proposals: Proposal[],
): Map<number, number> {
  const defendCounts = new Map<string, number>();
  const result       = new Map<number, number>();

  for (const p of proposals) {
    const c     = p.content as { value?: string; stanceAction?: string };
    const stance = c.stanceAction ?? "propose";

    if (stance !== "defend") {
      result.set(p.revisionId, 1.0);
      continue;
    }

    const normalKey = normalizeProposal(c.value ?? "");
    const key       = `${p.author}:${normalKey}`;
    const count     = (defendCounts.get(key) ?? 0) + 1;
    defendCounts.set(key, count);

    result.set(
      p.revisionId,
      DEFENSE_DECAY[Math.min(count - 1, DEFENSE_DECAY.length - 1)],
    );
  }

  return result;
}

// ─── computeEvolutionMomentum ────────────────────────────────────

/**
 * actor별 논리 진화 기여도 점수.
 * refine/concede 행동 + 상호 진화(mutual adaptation) 보너스.
 */
export function computeEvolutionMomentum(
  proposals:          Proposal[],
  actors:             Author[],
  absorbedArguments?: { from: Author; by: Author; concept: string }[],
): ActorEvolutionMomentum[] {
  const scoreMap = new Map<Author, { score: number; events: string[] }>();
  for (const a of actors) scoreMap.set(a, { score: 0, events: [] });

  for (const p of proposals) {
    const entry = scoreMap.get(p.author);
    if (!entry) continue;

    const c  = p.content as { value?: string; stanceAction?: string };
    const sa = c.stanceAction ?? "propose";
    const vp = (c.value ?? "").slice(0, 35);

    if      (sa === "refine")  { entry.score += 0.18; entry.events.push(`발전: '${vp}'`); }
    else if (sa === "concede") { entry.score += 0.28; entry.events.push(`수용: '${vp}'`); }
    else if (sa === "defend")  { entry.score -= 0.06; }
  }

  // Mutual Adaptation Bonus: A→흡수 B 이고 B→흡수 A 인 쌍
  if (absorbedArguments && absorbedArguments.length >= 2) {
    const seenMutual = new Set<string>();
    for (const a of absorbedArguments) {
      for (const b of absorbedArguments) {
        if (a.by !== b.from || a.from !== b.by) continue;
        const key = [a.by, a.from].sort().join("::");
        if (seenMutual.has(key)) continue;
        seenMutual.add(key);
        const ea = scoreMap.get(a.by);
        const eb = scoreMap.get(a.from);
        if (ea) { ea.score += 0.25; ea.events.push(`상호 진화 (${a.from}↔${a.by})`); }
        if (eb) { eb.score += 0.25; eb.events.push(`상호 진화 (${a.by}↔${a.from})`); }
      }
    }
  }

  return actors.map(actor => {
    const e = scoreMap.get(actor)!;
    return {
      actor,
      score:  Math.max(0, Math.round(e.score * 100) / 100),
      events: e.events.slice(0, 6),
    };
  }).sort((a, b) => b.score - a.score);
}

// ─── computeBranchInnovation ────────────────────────────────────

/**
 * 각 proposal의 혁신성 점수를 반환.
 * 새로운 개념 통합 / 공유 개념 확장 → 가점.
 * 동일 semantics 반복 defend → 감점.
 *
 * Returns: Map<revisionId, innovationScore>
 */
export function computeBranchInnovation(
  proposals:         Proposal[],
  sharedConceptKwds: Set<string> = new Set(),
): Map<number, number> {
  const result       = new Map<number, number>();
  const seenKwds     = new Set<string>();
  const seenNormKeys = new Set<string>();

  for (const p of proposals) {
    const c         = p.content as { value?: string; stanceAction?: string };
    const normalKey = normalizeProposal(c.value ?? "");
    const kwds      = extractKws(propText(p));
    const newKwds   = kwds.filter(k => !seenKwds.has(k));
    const newShared = kwds.filter(k => sharedConceptKwds.has(k) && !seenKwds.has(k));
    const stance    = c.stanceAction ?? "propose";

    let score = 0;

    if (newKwds.length >= 3) score += Math.min(0.40, newKwds.length * 0.07);
    if (newShared.length > 0) score += Math.min(0.25, newShared.length * 0.12);
    if (stance === "concede") score += 0.18;
    if (stance === "refine")  score += 0.12;
    if (stance === "defend" && seenNormKeys.has(normalKey)) score -= 0.18;

    for (const k of kwds) seenKwds.add(k);
    seenNormKeys.add(normalKey);

    result.set(p.revisionId, Math.max(-0.30, Math.min(1.0, score)));
  }

  return result;
}

// ─── computeEvolutionPressure (main) ────────────────────────────

/**
 * 토론 전체의 Evolution Pressure 분석 결과 반환.
 */
export function computeEvolutionPressure(
  proposals:          Proposal[],
  actors:             Author[],
  absorbedArguments?: { from: Author; by: Author; concept: string }[],
  sharedConceptKwds?: Set<string>,
): EvolutionPressureAnalysis {
  const empty = (): EvolutionPressureAnalysis => ({
    stagnationLevel:     0,
    actorMomentum:       actors.map(a => ({ actor: a, score: 0, events: [] })),
    innovationMoments:   [],
    semanticDecayActors: [],
  });

  if (proposals.length < 3) return empty();

  const persistencyMap = computeSemanticPersistencePenalty(proposals);
  const momentums      = computeEvolutionMomentum(proposals, actors, absorbedArguments);
  const innovationMap  = computeBranchInnovation(proposals, sharedConceptKwds ?? new Set());

  // Stagnation Level: decay ≤ 0.51 상태인 proposal 비율
  let lowDecayCount = 0;
  for (const [, decay] of persistencyMap) {
    if (decay <= 0.51) lowDecayCount++;
  }
  const stagnationLevel =
    Math.round((lowDecayCount / proposals.length) * 100) / 100;

  // Innovation Moments: score > 0.20 인 혁신 순간 (상위 6개)
  const innovationMoments: InnovationMoment[] = [];
  for (const p of proposals) {
    const score = innovationMap.get(p.revisionId) ?? 0;
    if (score <= 0.20) continue;
    const c  = p.content as { value?: string; stanceAction?: string };
    const sa = c.stanceAction ?? "propose";
    const desc =
      sa === "concede" ? `논거 수용 + 개념 확장` :
      sa === "refine"  ? `논리 발전: '${(c.value ?? "").slice(0, 30)}'` :
                         `새 개념 통합: '${(c.value ?? "").slice(0, 30)}'`;
    innovationMoments.push({
      revisionId:  p.revisionId,
      actor:       p.author,
      score:       Math.round(score * 100) / 100,
      description: desc,
    });
  }
  innovationMoments.sort((a, b) => b.score - a.score);

  // Semantic Decay Actors: decay ≤ 0.36 defend가 2회 이상인 actor
  const decayCountMap = new Map<string, number>();
  for (const p of proposals) {
    const c = p.content as { stanceAction?: string };
    if (c.stanceAction !== "defend") continue;
    const decay = persistencyMap.get(p.revisionId) ?? 1;
    if (decay <= 0.36) {
      decayCountMap.set(p.author, (decayCountMap.get(p.author) ?? 0) + 1);
    }
  }
  const semanticDecayActors = [...decayCountMap.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([actor]) => actor);

  return {
    stagnationLevel,
    actorMomentum:     momentums,
    innovationMoments: innovationMoments.slice(0, 6),
    semanticDecayActors,
  };
}
