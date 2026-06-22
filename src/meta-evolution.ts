import type {
  Topic,
  SegmentAnalysisView,
  MetaEvolutionAnalysis,
  MetaEvolutionStage,
  ConceptTransition,
  InterjectionImpact,
  TopicShiftType,
} from "./types.js";
import { extractKeywordsNT, jaccardSets } from "./novelty-tracker.js";

// ─── keyword 추출 헬퍼 ────────────────────────────────────────────

function kwds(text: string | undefined | null): Set<string> {
  if (!text) return new Set();
  return extractKeywordsNT(text);
}

function kSet(texts: (string | undefined | null)[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) for (const k of kwds(t)) out.add(k);
  return out;
}

// ─── segment dominant keywords 추출 ─────────────────────────────

function stageKeywords(view: SegmentAnalysisView): Set<string> {
  const a = view.analysis;
  const sources: (string | undefined | null)[] = [
    view.summary?.dominantConclusion,
    a.finalConclusion?.text,
    a.synthesizedConsensus?.text,
    a.dominantStance,
    a.dominantReason,
    a.branchSurvival?.dominantBranch?.finalProposalValue,
    // 상위 shared concepts
    ...(a.synthesizedConsensus?.sharedConcepts.slice(0, 5).map(c => c.keyword) ?? []),
  ];
  return kSet(sources);
}

function stageConclusion(view: SegmentAnalysisView): string {
  return (
    view.summary?.dominantConclusion ??
    view.analysis.finalConclusion?.text ??
    view.analysis.synthesizedConsensus?.text ??
    view.analysis.dominantStance ??
    ""
  );
}

// ─── ConceptTransition 계산 ──────────────────────────────────────

function buildTransition(
  fromView: SegmentAnalysisView,
  toView:   SegmentAnalysisView,
): ConceptTransition {
  const fromKw = stageKeywords(fromView);
  const toKw   = stageKeywords(toView);

  const persisted  = [...fromKw].filter(k => toKw.has(k));
  const abandoned  = [...fromKw].filter(k => !toKw.has(k)).slice(0, 6);
  const introduced = [...toKw].filter(k => !fromKw.has(k)).slice(0, 6);

  const shiftScore = 1 - jaccardSets(fromKw, toKw);

  return {
    fromSegment:        fromView.segmentId,
    toSegment:          toView.segmentId,
    persistedConcepts:  persisted.slice(0, 6),
    abandonedConcepts:  abandoned,
    introducedConcepts: introduced,
    semanticShiftScore: Math.round(shiftScore * 100) / 100,
  };
}

// ─── TopicShiftType 판정 ─────────────────────────────────────────

function classifyShift(transitions: ConceptTransition[]): TopicShiftType {
  if (transitions.length === 0) return "refinement";

  const avgShift = transitions.reduce((s, t) => s + t.semanticShiftScore, 0) / transitions.length;
  const anyMajorRedirect = transitions.some(t =>
    t.semanticShiftScore > 0.6 && t.abandonedConcepts.length > t.persistedConcepts.length,
  );
  const allLowShift = transitions.every(t => t.semanticShiftScore < 0.3);
  const allHighNew  = transitions.every(t => t.introducedConcepts.length > t.persistedConcepts.length);

  if (anyMajorRedirect) return "pivot";
  if (avgShift > 0.55)  return "expansion";
  if (allLowShift)      return "refinement";
  if (allHighNew)       return "synthesis";
  if (avgShift > 0.35)  return "expansion";
  return "refinement";
}

// ─── InterjectionImpact 분석 ─────────────────────────────────────

function analyzeInterjectionImpact(
  segViews:  SegmentAnalysisView[],
  trans:     ConceptTransition[],
): InterjectionImpact[] {
  const impacts: InterjectionImpact[] = [];

  for (let i = 1; i < segViews.length; i++) {
    const view = segViews[i];
    if (!view.interjectionMessage) continue;

    const t = trans.find(tr => tr.fromSegment === i && tr.toSegment === i + 1)
           ?? trans.find(tr => tr.fromSegment === i - 1 && tr.toSegment === i);

    const interjKwds  = kwds(view.interjectionMessage);
    const changedConcepts = t
      ? [...new Set([...t.introducedConcepts, ...t.abandonedConcepts])].slice(0, 5)
      : [...interjKwds].slice(0, 5);

    // impactType 판정
    let impactType: InterjectionImpact["impactType"];
    const shiftScore = t?.semanticShiftScore ?? 0;
    const abandRatio = t
      ? t.abandonedConcepts.length / Math.max(t.persistedConcepts.length + t.abandonedConcepts.length, 1)
      : 0;

    if (shiftScore > 0.55 && abandRatio > 0.45) {
      impactType = "topic_redirect";
    } else if (shiftScore > 0.35) {
      impactType = "perspective_shift";
    } else if (t && t.introducedConcepts.length > t.persistedConcepts.length) {
      impactType = "scope_expansion";
    } else {
      impactType = "constraint_addition";
    }

    // 영향 요약문 생성
    const prevConclusion = stageConclusion(segViews[i - 1]);
    const nextConclusion = stageConclusion(view);
    let reasoningImpactSummary: string;

    if (impactType === "topic_redirect") {
      reasoningImpactSummary = prevConclusion && nextConclusion
        ? `논점이 "${truncate(prevConclusion, 40)}"에서 "${truncate(nextConclusion, 40)}"으로 전환됨`
        : "개입 후 논점 프레임이 크게 전환됨";
    } else if (impactType === "perspective_shift") {
      const newKwStr = t?.introducedConcepts.slice(0, 3).join(", ") ?? "";
      reasoningImpactSummary = newKwStr
        ? `새 관점 "${newKwStr}" 도입으로 논거 방향 조정됨`
        : "개입 후 논거 방향이 조정됨";
    } else if (impactType === "scope_expansion") {
      const newKwStr = t?.introducedConcepts.slice(0, 3).join(", ") ?? "";
      reasoningImpactSummary = newKwStr
        ? `논의 범위가 "${newKwStr}" 방향으로 확장됨`
        : "개입 후 논의 범위가 확장됨";
    } else {
      reasoningImpactSummary = "기존 논의 프레임 내에서 제약 조건이 추가됨";
    }

    impacts.push({
      segmentId:              view.segmentId,
      interjection:           view.interjectionMessage,
      impactType,
      changedConcepts,
      reasoningImpactSummary,
    });
  }

  return impacts;
}

// ─── dominantEvolutionPath 생성 ──────────────────────────────────

function buildEvolutionPath(segViews: SegmentAnalysisView[]): string[] {
  return segViews
    .map(v => stageConclusion(v))
    .filter(Boolean);
}

// ─── metaSummary + finalMetaConclusion 생성 ──────────────────────

function buildMetaSummary(
  segViews:    SegmentAnalysisView[],
  transitions: ConceptTransition[],
  shiftType:   TopicShiftType,
): string {
  const n = segViews.length;
  const avgShift = transitions.length > 0
    ? transitions.reduce((s, t) => s + t.semanticShiftScore, 0) / transitions.length
    : 0;

  const SHIFT_TYPE_DESC: Record<TopicShiftType, string> = {
    refinement:   "동일 프레임 내에서 논리를 정교화했습니다",
    pivot:        "논점 자체가 전환되었습니다",
    expansion:    "논의 범위를 확장하며 발전했습니다",
    contradiction:"이전 결론과 상충하는 방향으로 이동했습니다",
    synthesis:    "복수의 관점을 통합하며 수렴했습니다",
  };

  const shiftDesc = avgShift < 0.25 ? "작은 변화" : avgShift < 0.5 ? "중간 변화" : "큰 전환";
  return `${n}개 세그먼트에 걸쳐 ${SHIFT_TYPE_DESC[shiftType]}. 세그먼트 간 평균 의미 이동: ${shiftDesc} (${Math.round(avgShift * 100)}%).`;
}

function buildFinalMetaConclusion(
  segViews:    SegmentAnalysisView[],
  transitions: ConceptTransition[],
  shiftType:   TopicShiftType,
): string {
  if (segViews.length < 2) {
    return stageConclusion(segViews[0] ?? segViews[segViews.length - 1]) || "단일 세그먼트 — 메타 결론 없음";
  }

  const first  = stageConclusion(segViews[0]);
  const last   = stageConclusion(segViews[segViews.length - 1]);

  // 누적 유지 키워드 (모든 세그먼트에서 공통으로 유지된 것)
  let persistedAll: string[] | null = null;
  for (const t of transitions) {
    const ps = new Set<string>(t.persistedConcepts);
    persistedAll = persistedAll
      ? persistedAll.filter((k: string) => ps.has(k))
      : [...ps];
  }
  const coreKwds: string[] = persistedAll ? persistedAll.slice(0, 3) : [];

  if (shiftType === "refinement") {
    return coreKwds.length > 0
      ? `"${coreKwds.join(", ")}"를 핵심 축으로 유지하며 논리를 정교화했습니다. 최종: ${truncate(last, 80)}`
      : `논점 프레임을 유지하며 심화했습니다. 최종: ${truncate(last, 80)}`;
  }
  if (shiftType === "pivot") {
    return first && last
      ? `"${truncate(first, 50)}"에서 "${truncate(last, 50)}"으로 논점 자체가 전환되었습니다.`
      : `논점 프레임이 전환되었습니다. 최종: ${truncate(last, 80)}`;
  }
  if (shiftType === "expansion") {
    const all = transitions.flatMap(t => t.introducedConcepts).slice(0, 4);
    return all.length > 0
      ? `"${all.join(", ")}" 개념을 통합하며 논의 범위를 확장했습니다. 최종: ${truncate(last, 60)}`
      : `논의 범위를 확장하며 발전했습니다. 최종: ${truncate(last, 80)}`;
  }
  if (shiftType === "synthesis") {
    return coreKwds.length > 0
      ? `"${coreKwds.join(", ")}"를 교집합으로 복수 관점을 통합했습니다. 최종: ${truncate(last, 70)}`
      : `복수 관점을 통합하며 수렴했습니다. 최종: ${truncate(last, 80)}`;
  }
  // contradiction
  return first && last
    ? `"${truncate(first, 45)}"와 상충하는 방향으로 이동했습니다. 최종: ${truncate(last, 60)}`
    : `이전 결론과 상충하는 방향으로 이동했습니다. 최종: ${truncate(last, 80)}`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// ─── 메인 export ─────────────────────────────────────────────────

export function analyzeMetaEvolution(
  _topic:       Topic,
  segmentViews: SegmentAnalysisView[],
): MetaEvolutionAnalysis {
  if (segmentViews.length === 0) {
    return {
      evolutionStages:       [],
      topicShiftType:        "refinement",
      dominantEvolutionPath: [],
      conceptTransitions:    [],
      interjectionImpacts:   [],
      metaSummary:           "분석할 세그먼트가 없습니다.",
      finalMetaConclusion:   "",
    };
  }

  // 1. Evolution stages 빌드
  const evolutionStages: MetaEvolutionStage[] = segmentViews.map(v => ({
    segmentId:          v.segmentId,
    dominantConclusion: stageConclusion(v),
    dominantKeywords:   [...stageKeywords(v)].slice(0, 8),
    convergenceType:    v.summary?.convergenceType,
    survivingBranch:    v.summary?.survivingBranch,
    entropy:            v.analysis.convergenceFreeze?.argumentEntropy,
  }));

  // 2. Concept transitions (인접 세그먼트 쌍)
  const conceptTransitions: ConceptTransition[] = [];
  for (let i = 0; i < segmentViews.length - 1; i++) {
    conceptTransitions.push(buildTransition(segmentViews[i], segmentViews[i + 1]));
  }

  // 3. TopicShiftType
  const topicShiftType = classifyShift(conceptTransitions);

  // 4. Evolution path
  const dominantEvolutionPath = buildEvolutionPath(segmentViews);

  // 5. Interjection impacts
  const interjectionImpacts = analyzeInterjectionImpact(segmentViews, conceptTransitions);

  // 6. Meta summary + final conclusion
  const metaSummary          = buildMetaSummary(segmentViews, conceptTransitions, topicShiftType);
  const finalMetaConclusion  = buildFinalMetaConclusion(segmentViews, conceptTransitions, topicShiftType);

  return {
    evolutionStages,
    topicShiftType,
    dominantEvolutionPath,
    conceptTransitions,
    interjectionImpacts,
    metaSummary,
    finalMetaConclusion,
  };
}
