import type {
  DiscussionAnalysis,
  CognitiveFramework,
  FrameworkType,
  FrameworkPrinciple,
  PrincipleRole,
  StructuralRelationship,
  RelationType,
  ReasoningPattern,
  ReasoningPatternType,
} from "./types.js";

// ─── Framework Type 키워드 사전 ───────────────────────────────────

const FRAMEWORK_KEYWORDS: Record<Exclude<FrameworkType, "hybrid_framework">, string[]> = {
  governance_model:   [
    "governance", "참여", "거버넌스", "구조", "제도", "규제", "정책",
    "통제", "oversight", "제도화", "stakeholder", "accountability",
    "민주", "transparency", "투명성", "참여형", "공공",
  ],
  ethical_model:      [
    "윤리", "책임", "안전", "도덕", "신뢰", "ethics", "safety",
    "responsibility", "accountability", "bias", "fairness", "공정",
    "가치", "존엄", "권리", "harm",
  ],
  systemic_model:     [
    "시스템", "구조", "메커니즘", "체계", "네트워크", "system",
    "mechanism", "feedback", "loop", "상호작용", "복잡계",
    "emergence", "interdependence", "생태계",
  ],
  adaptive_model:     [
    "적응", "실험", "피드백", "학습", "진화", "adaptation",
    "iterative", "agile", "탄력", "유연", "변화", "innovation",
    "반복", "개선", "evolution",
  ],
  dialectical_model:  [
    "대립", "갈등", "synthesis", "테제", "반테제", "dialectical",
    "contradiction", "긴장", "tension", "opposition", "통합",
    "변증", "antithesis",
  ],
};

// ─── 개념 풀 수집 ─────────────────────────────────────────────────

interface ConceptEntry {
  concept:        string;
  score:          number;    // gravity or frequency based
  actors:         Set<string>;
  isEmergent:     boolean;   // appeared in late phase
  hasHighConcede: boolean;   // drove concessions
  isSynthetic:    boolean;   // appeared in synthesis
  isStructural:   boolean;   // in structural consensus
}

function collectConceptPool(analysis: DiscussionAnalysis): ConceptEntry[] {
  const pool = new Map<string, ConceptEntry>();

  function add(
    concept: string,
    score:          number,
    actors:         string[],
    isEmergent?:    boolean,
    hasHighConcede?: boolean,
    isSynthetic?:   boolean,
    isStructural?:  boolean,
  ) {
    if (!concept || concept.length < 2) return;
    const key = concept.toLowerCase();
    const existing = pool.get(key);
    if (existing) {
      existing.score          = Math.max(existing.score, score);
      actors.forEach(a => existing.actors.add(a));
      if (isEmergent)    existing.isEmergent    = true;
      if (hasHighConcede) existing.hasHighConcede = true;
      if (isSynthetic)   existing.isSynthetic   = true;
      if (isStructural)  existing.isStructural  = true;
    } else {
      pool.set(key, {
        concept,
        score,
        actors:         new Set(actors),
        isEmergent:     isEmergent    ?? false,
        hasHighConcede: hasHighConcede ?? false,
        isSynthetic:    isSynthetic   ?? false,
        isStructural:   isStructural  ?? false,
      });
    }
  }

  // 1. Concept Gravity (최우선 — scored)
  for (const cg of analysis.conceptGravity?.topConcepts ?? []) {
    add(
      cg.concept,
      cg.gravityScore,
      [cg.firstActor, ...(cg.adoptersCount > 1 ? ["multi"] : [])],
      false,
      cg.concedeInfluence > 0,
      cg.synthesisParticipation,
      false,
    );
  }

  // 2. Structural Consensus
  for (const k of analysis.structuralConsensus?.sharedStructure ?? []) {
    add(k, 8, [], false, false, false, true);
  }

  // 3. Synthesized Consensus shared concepts
  for (const sc of analysis.synthesizedConsensus?.sharedConcepts ?? []) {
    add(sc.keyword, sc.frequency * 2, sc.actors as string[], false, false, true, false);
  }

  // 4. Question Evolution — newly dominant (emergent)
  for (const k of analysis.questionEvolution?.newlyDominantConcepts ?? []) {
    add(k, 5, [], true, false, false, false);
  }

  // 5. Branch survival shared concepts
  for (const k of analysis.branchSurvival?.dominantBranch?.sharedConcepts ?? []) {
    add(k, 6, [], false, false, false, false);
  }

  return [...pool.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);
}

// ─── Framework Type 결정 ─────────────────────────────────────────

function detectFrameworkTypeClean(
  concepts: ConceptEntry[],
  stanceChanges:      number,
  unresolvedConflicts: number,
): FrameworkType {
  const conceptTexts = concepts.map(c => c.concept.toLowerCase());
  const scores: Record<Exclude<FrameworkType, "hybrid_framework">, number> = {
    governance_model:  0,
    ethical_model:     0,
    systemic_model:    0,
    adaptive_model:    0,
    dialectical_model: 0,
  };

  for (const [ftype, kwds] of Object.entries(FRAMEWORK_KEYWORDS) as Array<[Exclude<FrameworkType, "hybrid_framework">, string[]]>) {
    for (const kw of kwds) {
      for (const concept of conceptTexts) {
        if (concept.includes(kw) || kw.includes(concept)) {
          scores[ftype] += 1;
        }
      }
    }
  }

  // dialectical_model 보정
  if (stanceChanges >= 3 && unresolvedConflicts >= 2) {
    scores.dialectical_model += 2;
  }

  const topTypes = Object.entries(scores).sort((a, b) => b[1] - a[1]) as Array<[Exclude<FrameworkType, "hybrid_framework">, number]>;
  const [first, second] = topTypes;

  if (first[1] === 0) return "hybrid_framework";
  if (second && second[1] >= first[1] * 0.7 && first[1] >= 2) return "hybrid_framework";
  return first[0];
}

// ─── Core Principles 빌드 ────────────────────────────────────────

function buildCorePrinciples(
  concepts:           ConceptEntry[],
  emergentConcepts:   Set<string>,
): FrameworkPrinciple[] {
  return concepts.slice(0, 6).map((c, idx) => {
    let role: PrincipleRole;

    if (c.isStructural && idx < 2)        role = "foundation";
    else if (c.hasHighConcede)            role = "driver";
    else if (c.isSynthetic)              role = "balancer";
    else if (c.isEmergent ||
             emergentConcepts.has(c.concept.toLowerCase())) role = "emergent";
    else if (idx >= 4)                   role = "constraint";
    else                                 role = "foundation";

    const actors = [...c.actors].filter(a => a !== "multi" && a !== "");
    const influence = Math.min(1, c.score / 20);

    return {
      concept:           c.concept,
      role,
      influence:         Math.round(influence * 100) / 100,
      supportedByActors: actors,
    };
  });
}

// ─── Structural Relationships 빌드 ───────────────────────────────

function buildStructuralRelationships(
  principles: FrameworkPrinciple[],
  analysis:   DiscussionAnalysis,
): StructuralRelationship[] {
  const rels: StructuralRelationship[] = [];
  const concepts = principles.map(p => p.concept);

  // 1. structural consensus → "requires" 관계 (공유 구조 내부)
  const structCore = analysis.structuralConsensus?.sharedStructure ?? [];
  for (let i = 0; i < Math.min(structCore.length - 1, 2); i++) {
    const a = structCore[i], b = structCore[i + 1];
    if (concepts.includes(a) && concepts.includes(b)) {
      rels.push({ from: a, to: b, relation: "requires", confidence: 0.82 });
    }
  }

  // 2. unresolvedConflicts → "balances" 관계
  for (const uc of (analysis.unresolvedConflicts ?? []).slice(0, 2)) {
    if (uc.positions.length < 2) continue;
    const posA = uc.positions[0].stance.split(",")[0].trim().split(/\s+/)[0];
    const posB = uc.positions[1].stance.split(",")[0].trim().split(/\s+/)[0];
    if (posA && posB && posA !== posB && posA.length >= 2 && posB.length >= 2) {
      rels.push({ from: posA, to: posB, relation: "balances", confidence: 0.75 });
    }
  }

  // 3. driver concept → foundation: "amplifies"
  const drivers     = principles.filter(p => p.role === "driver");
  const foundations = principles.filter(p => p.role === "foundation");
  for (const d of drivers.slice(0, 2)) {
    for (const f of foundations.slice(0, 1)) {
      if (d.concept !== f.concept) {
        rels.push({ from: d.concept, to: f.concept, relation: "amplifies", confidence: 0.68 });
      }
    }
  }

  // 4. balancer → 인접 개념: "stabilizes"
  const balancers = principles.filter(p => p.role === "balancer");
  for (const bal of balancers.slice(0, 2)) {
    const target = foundations[0] ?? principles[0];
    if (target && target.concept !== bal.concept) {
      rels.push({ from: bal.concept, to: target.concept, relation: "stabilizes", confidence: 0.65 });
    }
  }

  // 5. emergent → foundation: "requires"
  const emergents = principles.filter(p => p.role === "emergent");
  for (const em of emergents.slice(0, 1)) {
    const base = principles.find(p => p.role === "foundation");
    if (base && base.concept !== em.concept) {
      rels.push({ from: em.concept, to: base.concept, relation: "requires", confidence: 0.60 });
    }
  }

  // 중복 제거 + 최대 6개
  const seen = new Set<string>();
  return rels.filter(r => {
    const key = `${r.from}→${r.to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 6);
}

// ─── Reasoning Pattern 추출 ──────────────────────────────────────

function extractReasoningPattern(analysis: DiscussionAnalysis): ReasoningPattern {
  const drivers      = analysis.progressDrivers ?? [];
  const stanceCount  = analysis.stanceChanges?.length ?? 0;
  const concedes     = drivers.flatMap(d => d.highlights).filter(h => h.startsWith("양보")).length;
  const refines      = drivers.flatMap(d => d.highlights).filter(h => h.startsWith("발전")).length;
  const evoMoments   = analysis.evolutionPressure?.innovationMoments?.length ?? 0;
  const stagnation   = analysis.evolutionPressure?.stagnationLevel ?? 0;
  const unresolvedN  = analysis.unresolvedConflicts?.length ?? 0;
  const isPseudo     = analysis.semanticLoop?.isPseudoDebate ?? false;

  let type: ReasoningPatternType;
  let desc: string;
  let conf = 0.70;

  if (isPseudo && refines >= 2) {
    type = "dialectical_synthesis";
    desc = "표면 불일치 이면에 구조 수렴 — 변증법적 통합 패턴";
    conf = 0.80;
  } else if (refines >= concedes && evoMoments >= 2) {
    type = "dialectical_synthesis";
    desc = "발전적 refine 중심, 혁신 포인트를 통한 단계적 통합";
    conf = 0.75;
  } else if (concedes >= 2 && stanceCount >= 2) {
    type = "conflict_resolution";
    desc = `${concedes}회 양보를 통해 대립 → 해소 경로를 밟음`;
    conf = 0.78;
  } else if (stagnation >= 0.5 && unresolvedN >= 2) {
    type = "system_balancing";
    desc = "복수의 미해결 긴장 축을 유지하며 균형점 탐색";
    conf = 0.72;
  } else if (evoMoments >= 3) {
    type = "recursive_adaptation";
    desc = `${evoMoments}회 혁신 포인트를 통한 반복 적응 및 재구성`;
    conf = 0.73;
  } else {
    type = "incremental_refinement";
    desc = "점진적 정교화 — 초기 프레임을 유지하며 세부 수렴";
    conf = 0.65;
  }

  return { type, confidence: conf, description: desc };
}

// ─── Framework Name 생성 ─────────────────────────────────────────

function buildFrameworkName(
  frameworkType: FrameworkType,
  topConcepts:   string[],
): string {
  const top2 = topConcepts.slice(0, 2).join("+");
  const top3 = topConcepts.slice(0, 3).join("+");

  const SUFFIX: Record<FrameworkType, string> = {
    governance_model:   "거버넌스 모델",
    ethical_model:      "윤리 프레임",
    systemic_model:     "시스템 모델",
    adaptive_model:     "적응형 모델",
    dialectical_model:  "변증법적 프레임",
    hybrid_framework:   "복합 프레임",
  };

  const base = frameworkType === "hybrid_framework" ? top3 : top2;
  return `${base} ${SUFFIX[frameworkType]}`;
}

// ─── Dominant Worldview ──────────────────────────────────────────

function buildDominantWorldview(
  frameworkType: FrameworkType,
  topConcepts:   string[],
  analysis:      DiscussionAnalysis,
): string {
  const dominant = analysis.branchSurvival?.dominantBranch?.finalProposalValue
    ?? analysis.synthesizedConsensus?.text
    ?? topConcepts.slice(0, 3).join(", ");

  const WORLDVIEW_PREFIX: Record<FrameworkType, string> = {
    governance_model:   "참여와 구조 기반의 공동 조율이",
    ethical_model:      "책임과 가치 기반의 신뢰 형성이",
    systemic_model:     "상호의존적 시스템 메커니즘이",
    adaptive_model:     "지속적 피드백과 적응이",
    dialectical_model:  "대립과 통합의 반복이",
    hybrid_framework:   "복합적 사고 구조가",
  };

  return `${WORLDVIEW_PREFIX[frameworkType]} ${dominant.slice(0, 80)}를 결정한다`;
}

// ─── Generated Perspective ───────────────────────────────────────

function buildGeneratedPerspective(
  frameworkName:     string,
  frameworkType:     FrameworkType,
  analysis:          DiscussionAnalysis,
): string {
  const qe          = analysis.questionEvolution;
  const fr          = analysis.finalResolution;
  const initQ       = qe?.initialQuestion ?? "";
  const emergentQ   = qe?.emergentQuestion ?? fr?.emergentQuestion ?? "";
  const dominant    = fr?.dominantStructure ?? analysis.branchSurvival?.dominantBranch?.finalProposalValue ?? "";
  const driftType   = qe?.driftType;
  const resType     = fr?.resolutionType;

  if (driftType === "transformed_topic" && emergentQ) {
    return `토론은 '${initQ.slice(0, 40)}'에서 출발했지만, ${frameworkName}이라는 새로운 사고 구조를 형성하며 '${emergentQ.slice(0, 80)}'로 진화했다.`;
  }

  if (driftType === "shifted_topic" && dominant) {
    return `논의는 ${frameworkName}을 통해 초기 대립 구도를 넘어서, ${dominant.slice(0, 80)}로 수렴됐다.`;
  }

  if (resType === "synthesized_resolution") {
    const core = analysis.structuralConsensus?.sharedStructure.slice(0, 3).join(", ")
      ?? analysis.synthesizedConsensus?.sharedConcepts.slice(0, 3).map(c => c.keyword).join(", ")
      ?? "";
    return core
      ? `${frameworkName}을 통해 초기 대립을 넘어, ${core}의 공유 구조 위에서 합성적 이해에 도달했다.`
      : `${frameworkName}은 대립하는 입장들을 하나의 구조적 이해로 통합했다.`;
  }

  if (resType === "unresolved_dynamic_tension") {
    const tensions = (analysis.unresolvedConflicts ?? []).slice(0, 2).map(t => t.dimension);
    return tensions.length >= 2
      ? `${frameworkName} 안에서, ${tensions[0]}와 ${tensions[1]}의 긴장이 해소되지 않은 채 동적으로 유지됐다.`
      : `${frameworkName}은 긴장을 해소하기보다 생산적 긴장 상태를 유지하는 방향으로 작동했다.`;
  }

  return dominant
    ? `토론은 ${frameworkName}의 관점에서 '${dominant.slice(0, 80)}'로 수렴됐다.`
    : `${frameworkName}이 토론 전체를 지배하는 사고 구조로 등장했다.`;
}

// ─── Framework Summary ────────────────────────────────────────────

function buildFrameworkSummary(
  frameworkName:  string,
  principles:     FrameworkPrinciple[],
  pattern:        ReasoningPattern,
): string {
  const topPrinciples = principles
    .filter(p => p.role === "foundation" || p.role === "driver")
    .slice(0, 3)
    .map(p => p.concept)
    .join(", ");

  return `${frameworkName}: ${topPrinciples} 중심, ${pattern.description}`;
}

// ─── main: extractCognitiveFramework ────────────────────────────

export function extractCognitiveFramework(
  analysis: DiscussionAnalysis,
): CognitiveFramework | undefined {
  // 최소 데이터 요건
  const hasConcepts = (analysis.conceptGravity?.topConcepts?.length ?? 0) >= 2
    || (analysis.synthesizedConsensus?.sharedConcepts?.length ?? 0) >= 2
    || (analysis.structuralConsensus?.sharedStructure?.length ?? 0) >= 2;

  if (!hasConcepts) return undefined;

  // ── 개념 풀 수집 ──────────────────────────────────────────────────
  const concepts = collectConceptPool(analysis);
  if (concepts.length < 2) return undefined;

  const emergentSet = new Set(
    (analysis.questionEvolution?.newlyDominantConcepts ?? []).map(k => k.toLowerCase()),
  );

  // ── Framework Type ────────────────────────────────────────────────
  const frameworkType = detectFrameworkTypeClean(
    concepts,
    analysis.stanceChanges?.length ?? 0,
    analysis.unresolvedConflicts?.length ?? 0,
  );

  // ── Core Principles ───────────────────────────────────────────────
  const corePrinciples = buildCorePrinciples(concepts, emergentSet);

  // ── Structural Relationships ──────────────────────────────────────
  const structuralRelationships = buildStructuralRelationships(corePrinciples, analysis);

  // ── Reasoning Pattern ─────────────────────────────────────────────
  const reasoningPattern = extractReasoningPattern(analysis);

  // ── Framework Name ────────────────────────────────────────────────
  const topConceptNames = corePrinciples.slice(0, 4).map(p => p.concept);
  const frameworkName   = buildFrameworkName(frameworkType, topConceptNames);

  // ── Dominant Worldview ────────────────────────────────────────────
  const dominantWorldview = buildDominantWorldview(frameworkType, topConceptNames, analysis);

  // ── Generated Perspective ─────────────────────────────────────────
  const generatedPerspective = buildGeneratedPerspective(frameworkName, frameworkType, analysis);

  // ── Framework Summary ─────────────────────────────────────────────
  const frameworkSummary = buildFrameworkSummary(frameworkName, corePrinciples, reasoningPattern);

  return {
    frameworkType,
    frameworkName,
    corePrinciples,
    structuralRelationships,
    reasoningPattern,
    dominantWorldview,
    generatedPerspective,
    frameworkSummary,
  };
}
