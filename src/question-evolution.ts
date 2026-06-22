import type {
  Author,
  Topic,
  Proposal,
  QuestionEvolutionAnalysis,
  QuestionEvolutionStep,
  QuestionPressureEntry,
  QuestionLockActor,
  TopicDriftType,
  QuestionPressureType,
  BranchSurvivalAnalysis,
  SynthesizedConsensus,
} from "./types.js";
import { extractKeywordsNT, jaccardSets } from "./novelty-tracker.js";

// ─── 헬퍼 ─────────────────────────────────────────────────────────

function kwds(text: string | undefined | null): Set<string> {
  if (!text) return new Set();
  return extractKeywordsNT(text);
}

function proposalText(p: Proposal): string {
  const c = p.content as { value?: string; reason?: string };
  return `${c.value ?? ""} ${c.reason ?? ""} ${p.rationale ?? ""}`;
}

// ─── centroid 키워드 계산 ─────────────────────────────────────────
// proposals 집합에서 일정 빈도 이상 등장한 키워드 = semantic centroid

function computeCentroid(proposals: Proposal[]): Set<string> {
  const freq = new Map<string, number>();
  for (const p of proposals) {
    for (const k of kwds(proposalText(p))) {
      freq.set(k, (freq.get(k) ?? 0) + 1);
    }
  }
  const threshold = Math.max(1, Math.floor(proposals.length * 0.25));
  return new Set(
    [...freq.entries()]
      .filter(([, c]) => c >= threshold)
      .map(([k]) => k),
  );
}

// ─── Topic Drift 분류 ─────────────────────────────────────────────

function classifyDrift(jaccard: number, newConceptRatio: number): TopicDriftType {
  if (jaccard >= 0.55)                          return "stable_topic";
  if (jaccard >= 0.35)                          return "reframed_topic";
  if (jaccard >= 0.15 || newConceptRatio >= 0.40) return "shifted_topic";
  return "transformed_topic";
}

// ─── Question Pressure 분류 ───────────────────────────────────────

function classifyQuestionPressure(
  p:              Proposal,
  goalKeywords:   Set<string>,
  accumulated:    Set<string>,
): QuestionPressureType {
  const pk = kwds(proposalText(p));
  if (pk.size === 0) return "preserve_question";

  const overlapWithGoal = jaccardSets(pk, goalKeywords);

  if (overlapWithGoal >= 0.50) return "preserve_question";

  if (overlapWithGoal >= 0.30) {
    const fresh = [...pk].filter(k => !accumulated.has(k));
    return fresh.length >= 3 ? "reframe_question" : "preserve_question";
  }

  if (overlapWithGoal >= 0.15) {
    const fresh = [...pk].filter(k => !accumulated.has(k));
    return fresh.length >= 2 ? "expand_question" : "reframe_question";
  }

  if (overlapWithGoal >= 0.06) return "redirect_question";
  return "replace_question";
}

// ─── Emergent Question 생성 ───────────────────────────────────────

function buildEmergentQuestion(
  goal:           string,
  lateCentroid:   Set<string>,
  initialCentroid: Set<string>,
  survivingBranch?: string,
  finalConcText?:  string,
): string {
  const newConcepts = [...lateCentroid]
    .filter(k => !initialCentroid.has(k))
    .slice(0, 3);

  // 생존 branch를 기반으로 질문 재구성
  const src = survivingBranch ?? finalConcText;
  if (src && src.length > 15) {
    const cleaned = src.replace(/[.。]$/, "").slice(0, 90);
    if (newConcepts.length >= 2) {
      const core = newConcepts.slice(0, 2).join("과(와) ");
      return `${cleaned}에서 ${core}은(는) 어떻게 작동하는가?`;
    }
    return `${cleaned}이(가) 어떻게 결정되는가?`;
  }

  // fallback: 새 개념 기반 질문
  if (newConcepts.length >= 2) {
    const core = newConcepts.slice(0, 2).join("와 ");
    const goalBase = goal.replace(/[?？\s]+$/, "");
    return `${goalBase}에서 ${core}의 역할과 작동 구조는 무엇인가?`;
  }

  return goal.endsWith("?") || goal.endsWith("？") ? goal : `${goal}?`;
}

// ─── Evolution Path 구성 ──────────────────────────────────────────

function buildEvolutionPath(
  goal:            string,
  proposals:       Proposal[],
  driftType:       TopicDriftType,
  initialCentroid: Set<string>,
  lateCentroid:    Set<string>,
  emergentQ:       string,
): QuestionEvolutionStep[] {
  const steps: QuestionEvolutionStep[] = [];

  // 1. 초기 질문
  steps.push({
    stage:        "initial",
    questionText: goal,
    keywords:     [...initialCentroid].slice(0, 6),
  });

  if (driftType === "stable_topic") return steps;

  // 2. 중간 단계 (proposals 중간 1/3)
  const midStart   = Math.floor(proposals.length / 3);
  const midEnd     = Math.floor(proposals.length * 2 / 3);
  const midProps   = proposals.slice(midStart, midEnd);
  const midCentroid = computeCentroid(midProps);

  if (midCentroid.size > 0 && driftType !== "reframed_topic") {
    const midNew = [...midCentroid].filter(k => !initialCentroid.has(k)).slice(0, 3);
    const midJ   = jaccardSets(initialCentroid, midCentroid);
    const midKwds = [...new Set([...[...initialCentroid].slice(0, 2), ...midNew])].slice(0, 6);

    const goalBase = goal.replace(/[?？\s]+$/, "");
    const midQ = midNew.length >= 1
      ? `${goalBase} — 특히 ${midNew.slice(0, 2).join(", ")}의 관점에서`
      : goalBase;

    steps.push({
      stage:         "middle",
      questionText:  midQ,
      keywords:      midKwds,
      driftFromPrev: Math.round((1 - midJ) * 100),
    });
  }

  // 3. Emergent question
  const prevKwds = steps.length >= 2
    ? new Set(steps[steps.length - 1].keywords)
    : initialCentroid;
  const lateJ = jaccardSets(prevKwds, lateCentroid);
  const lateKwds = [...new Set([
    ...[...lateCentroid].slice(0, 3),
    ...[...lateCentroid].filter(k => !initialCentroid.has(k)).slice(0, 3),
  ])].slice(0, 6);

  steps.push({
    stage:         "emergent",
    questionText:  emergentQ,
    keywords:      lateKwds,
    driftFromPrev: Math.round((1 - lateJ) * 100),
  });

  return steps;
}

// ─── main: detectQuestionEvolution ───────────────────────────────

export function detectQuestionEvolution(
  topic:     Topic,
  proposals: Proposal[],
  actors:    Author[],
  partial?: {
    branchSurvival?:       BranchSurvivalAnalysis;
    synthesizedConsensus?: SynthesizedConsensus;
  },
): QuestionEvolutionAnalysis | undefined {
  if (proposals.length < 4 || actors.length < 1) return undefined;

  const goal     = topic.goal;
  const goalKwds = kwds(goal);

  // ── 초기 20% / 후반 20% 분할 ────────────────────────────────────
  const splitSize      = Math.max(2, Math.floor(proposals.length * 0.20));
  const initialProps   = proposals.slice(0, splitSize);
  const lateProps      = proposals.slice(-splitSize);

  let initialCentroid  = computeCentroid(initialProps);
  const lateCentroid   = computeCentroid(lateProps);

  // goal keywords를 initial centroid에 보강 (centroid가 비어있는 경우 대비)
  if (initialCentroid.size < 3) {
    for (const k of goalKwds) initialCentroid.add(k);
  }

  // ── 거리 계산 ────────────────────────────────────────────────────
  const overlapJ          = jaccardSets(initialCentroid, lateCentroid);
  const semanticDistance  = 1 - overlapJ;
  const newlyDominant     = [...lateCentroid].filter(k => !initialCentroid.has(k)).slice(0, 8);
  const vanished          = [...initialCentroid].filter(k => !lateCentroid.has(k)).slice(0, 8);
  const newConceptRatio   = lateCentroid.size > 0
    ? newlyDominant.length / lateCentroid.size
    : 0;

  const driftType    = classifyDrift(overlapJ, newConceptRatio);
  const driftPercent = Math.round(semanticDistance * 100);

  // ── Question Pressure per revision ──────────────────────────────
  const questionPressures: QuestionPressureEntry[] = [];
  const accumulated = new Set<string>(goalKwds);

  for (const p of proposals) {
    const pressureType = classifyQuestionPressure(p, goalKwds, accumulated);
    questionPressures.push({
      revisionId:    p.revisionId,
      actor:         p.author,
      pressureType,
      proposalValue: ((p.content as { value?: string }).value ?? "").slice(0, 60),
    });
    for (const k of kwds(proposalText(p))) accumulated.add(k);
  }

  // ── Question Lock Detection ──────────────────────────────────────
  const actorCounts = new Map<Author, Map<QuestionPressureType, number>>();
  for (const entry of questionPressures) {
    const a = entry.actor as Author;
    if (a === "system" || a === "user") continue;
    if (!actorCounts.has(a)) actorCounts.set(a, new Map());
    const m = actorCounts.get(a)!;
    m.set(entry.pressureType, (m.get(entry.pressureType) ?? 0) + 1);
  }

  const lockedActors: QuestionLockActor[] = [];
  for (const [actor, counts] of actorCounts.entries()) {
    const preserve = counts.get("preserve_question") ?? 0;
    const total    = [...counts.values()].reduce((s, c) => s + c, 0);
    if (total >= 3 && preserve / total >= 0.65) {
      lockedActors.push({
        actor,
        preserveRatio:  Math.round((preserve / total) * 100),
        totalPressures: total,
      });
    }
  }

  // ── Dominant Redirect Actor ──────────────────────────────────────
  const redirectScore = new Map<Author, number>();
  for (const entry of questionPressures) {
    const a = entry.actor as Author;
    if (a === "system" || a === "user") continue;
    if (entry.pressureType === "redirect_question" || entry.pressureType === "replace_question") {
      redirectScore.set(a, (redirectScore.get(a) ?? 0) + 1);
    }
  }
  const dominantRedirectActor = redirectScore.size > 0
    ? [...redirectScore.entries()].sort((a, b) => b[1] - a[1])[0][0]
    : undefined;

  // ── Emergent Question ────────────────────────────────────────────
  const survivingBranch = partial?.branchSurvival?.dominantBranch?.finalProposalValue;
  const finalConcText   = partial?.synthesizedConsensus?.text;

  const emergentQuestion = buildEmergentQuestion(
    goal, lateCentroid, initialCentroid, survivingBranch, finalConcText,
  );

  // ── Evolution Path ───────────────────────────────────────────────
  const evolutionPath = buildEvolutionPath(
    goal, proposals, driftType, initialCentroid, lateCentroid, emergentQuestion,
  );

  const DRIFT_LABEL: Record<TopicDriftType, string> = {
    stable_topic:      "원래 질문 유지",
    reframed_topic:    "관점 재구성",
    shifted_topic:     "논점 이동",
    transformed_topic: "질문 진화",
  };

  return {
    initialQuestion:       goal,
    emergentQuestion,
    driftType,
    driftPercent,
    sharedConceptOverlap:  Math.round(overlapJ * 100),
    newlyDominantConcepts: newlyDominant,
    vanishedConcepts:      vanished,
    evolutionPath,
    questionPressures,
    lockedActors,
    dominantRedirectActor,
    transformationStage:   DRIFT_LABEL[driftType],
  };
}
