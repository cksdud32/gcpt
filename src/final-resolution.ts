import type {
  Author,
  Proposal,
  DiscussionAnalysis,
  FinalResolution,
  ResolutionType,
  EvolutionaryTrajectoryStage,
  ResolutionTension,
} from "./types.js";
import { extractKeywordsNT } from "./novelty-tracker.js";

// ─── 헬퍼 ─────────────────────────────────────────────────────────

function kwds(text: string | undefined | null): Set<string> {
  if (!text) return new Set();
  return extractKeywordsNT(text);
}

function proposalText(p: Proposal): string {
  const c = p.content as { value?: string; reason?: string };
  return `${c.value ?? ""} ${c.reason ?? ""} ${p.rationale ?? ""}`;
}

// ─── Phase 분할 ───────────────────────────────────────────────────

function splitIntoPhases(proposals: Proposal[], numPhases: number): Proposal[][] {
  const size = Math.ceil(proposals.length / numPhases);
  const phases: Proposal[][] = [];
  for (let i = 0; i < numPhases; i++) {
    phases.push(proposals.slice(i * size, (i + 1) * size));
  }
  return phases.filter(p => p.length > 0);
}

// ─── Phase별 actor 키워드 풀 ──────────────────────────────────────

function phaseActorPools(phase: Proposal[], actors: Author[]): Map<Author, Set<string>> {
  const pools = new Map<Author, Set<string>>();
  for (const actor of actors) {
    const pool = new Set<string>();
    for (const p of phase) {
      if (p.author === actor) {
        for (const k of kwds(proposalText(p))) pool.add(k);
      }
    }
    pools.set(actor, pool);
  }
  return pools;
}

// ─── Phase 축 추출 ────────────────────────────────────────────────

function extractPhaseAxis(
  pools: Map<Author, Set<string>>,
  actors: Author[],
): { axis: string; dominant: string } {
  if (actors.length < 2) {
    const allKwds = [...pools.values()].flatMap(p => [...p]);
    return { axis: allKwds.slice(0, 2).join(", "), dominant: allKwds[0] ?? "" };
  }

  const [a, b] = actors;
  const poolA = pools.get(a) ?? new Set<string>();
  const poolB = pools.get(b) ?? new Set<string>();

  const onlyA  = [...poolA].filter(k => !poolB.has(k)).slice(0, 2);
  const onlyB  = [...poolB].filter(k => !poolA.has(k)).slice(0, 2);
  const shared = [...poolA].filter(k => poolB.has(k)).slice(0, 2);

  const dominant = shared[0] ?? onlyA[0] ?? onlyB[0] ?? "";

  if (onlyA.length >= 1 && onlyB.length >= 1) {
    return {
      axis:     `${onlyA[0]} vs ${onlyB[0]}`,
      dominant: dominant,
    };
  }
  if (shared.length >= 2) {
    return {
      axis:     `${shared.slice(0, 2).join(", ")} 수렴`,
      dominant: dominant,
    };
  }
  const all = [...new Set([...onlyA, ...onlyB, ...shared])].slice(0, 2);
  return { axis: all.join(", "), dominant: dominant };
}

// ─── Phase 전환 키워드 (keyShift) ────────────────────────────────

function extractKeyShift(
  prevPools: Map<Author, Set<string>>,
  nextPools: Map<Author, Set<string>>,
  actors:    Author[],
): string {
  if (actors.length < 2) return "";

  const [a, b] = actors;
  const prevA  = prevPools.get(a) ?? new Set<string>();
  const prevB  = prevPools.get(b) ?? new Set<string>();
  const nextA  = nextPools.get(a) ?? new Set<string>();
  const nextB  = nextPools.get(b) ?? new Set<string>();

  // 이전에 없던 새 공유 개념
  const prevShared = [...prevA].filter(k => prevB.has(k));
  const nextShared = [...nextA].filter(k => nextB.has(k));
  const newShared  = nextShared.filter(k => !prevShared.includes(k)).slice(0, 2);

  if (newShared.length >= 1) {
    return `"${newShared.join(", ")}" 개념 공유화`;
  }

  // 이전에만 있던 개념 소멸
  const prevOnlyA = [...prevA].filter(k => !prevB.has(k));
  const vanished  = prevOnlyA.filter(k => !nextA.has(k)).slice(0, 1);
  if (vanished.length >= 1) {
    return `"${vanished[0]}" 논거 소멸`;
  }

  return "논점 재구성";
}

// ─── Evolutionary Trajectory 빌드 ────────────────────────────────

function buildEvolutionaryTrajectory(
  proposals: Proposal[],
  actors:    Author[],
  finalText: string,
): EvolutionaryTrajectoryStage[] {
  if (proposals.length < 4 || actors.length < 1) return [];

  const numPhases = proposals.length < 6 ? 2 : proposals.length < 12 ? 3 : 4;
  const phases    = splitIntoPhases(proposals, numPhases);

  const stages: EvolutionaryTrajectoryStage[] = [];
  const phasePools: Array<Map<Author, Set<string>>> = phases.map(ph => phaseActorPools(ph, actors));

  for (let i = 0; i < phases.length; i++) {
    const { axis, dominant } = extractPhaseAxis(phasePools[i], actors);
    const keyShift = i < phases.length - 1
      ? extractKeyShift(phasePools[i], phasePools[i + 1], actors)
      : undefined;

    stages.push({ stage: i + 1, axis, dominant, keyShift });
  }

  // 최종 단계: dominant structure
  if (finalText) {
    stages.push({
      stage:   stages.length + 1,
      axis:    finalText.slice(0, 80),
      dominant: "수렴 완료",
    });
  }

  return stages;
}

// ─── Unresolved Tensions ──────────────────────────────────────────

function buildUnresolvedTensions(
  analysis: Omit<DiscussionAnalysis, "finalResolution">,
): ResolutionTension[] {
  const tensions: ResolutionTension[] = [];

  // unresolvedConflicts에서 변환
  for (const uc of (analysis.unresolvedConflicts ?? []).slice(0, 3)) {
    if (uc.positions.length < 2) continue;
    const [posA, posB] = uc.positions;
    tensions.push({
      axis:          uc.dimension,
      sideA:         posA.stance,
      sideB:         posB.stance,
      whyUnresolved: `${posA.actor}와 ${posB.actor}의 핵심 전제가 끝까지 불일치`,
    });
  }

  // 비지배 branch의 핵심 개념 (unresolved 방향)
  const branches = analysis.branchSurvival?.branches ?? [];
  const nonDominant = branches.filter(b => !b.dominant).slice(0, 2);
  for (const branch of nonDominant) {
    if (branch.sharedConcepts.length < 2) continue;
    const core = branch.sharedConcepts.slice(0, 2).join(", ");
    const actor = branch.actors[0] ?? "unknown";
    tensions.push({
      axis:          core,
      sideA:         core,
      sideB:         analysis.branchSurvival?.dominantBranch?.sharedConcepts.slice(0, 2).join(", ") ?? "수렴 방향",
      whyUnresolved: `${actor}의 "${core}" 논거가 지배 branch에 흡수되지 않음`,
    });
  }

  return tensions.slice(0, 4);
}

// ─── Resolution Type 결정 ─────────────────────────────────────────

function determineResolutionType(
  analysis: Omit<DiscussionAnalysis, "finalResolution">,
): ResolutionType {
  const qe = analysis.questionEvolution;
  const sc = analysis.structuralConsensus;
  const sl = analysis.semanticLoop;
  const br = analysis.branchSurvival;
  const uc = analysis.unresolvedConflicts ?? [];

  // 질문 자체가 진화 + surviving structure 존재
  if (
    qe && (qe.driftType === "transformed_topic" || qe.driftType === "shifted_topic") &&
    (br?.dominantBranch || sc)
  ) return "transformed_resolution";

  // structural consensus (pseudo-debate 수렴)
  if (sl?.isPseudoDebate && sc && sc.sharedStructure.length >= 3) {
    return "synthesized_resolution";
  }

  // 합성 결론 존재
  if (
    analysis.synthesizedConsensus &&
    analysis.synthesizedConsensus.basis !== "fallback" &&
    analysis.synthesizedConsensus.confidence >= 0.45
  ) return "synthesized_resolution";

  // 강한 비수렴 긴장 유지
  if (uc.length >= 2 && analysis.outcome !== "decided" && !br?.dominantBranch) {
    return "unresolved_dynamic_tension";
  }

  return "stable_answer";
}

// ─── Primary Conclusion 생성 ─────────────────────────────────────

function buildPrimaryConclusion(
  resolutionType: ResolutionType,
  dominantStructure: string,
  analysis: Omit<DiscussionAnalysis, "finalResolution">,
): string {
  const qe = analysis.questionEvolution;
  const sc = analysis.structuralConsensus;
  const br = analysis.branchSurvival?.dominantBranch;

  switch (resolutionType) {
    case "transformed_resolution": {
      const emergent = qe?.emergentQuestion;
      if (emergent && emergent.length > 10) {
        return emergent.slice(0, 160);
      }
      const core = sc?.sharedStructure.slice(0, 3).join(", ");
      return core
        ? `${dominantStructure.slice(0, 80)}에서 ${core}의 구조로 수렴됨`
        : dominantStructure.slice(0, 160);
    }

    case "synthesized_resolution": {
      const core = sc?.sharedStructure.slice(0, 3).join(", ") ??
        analysis.synthesizedConsensus?.sharedConcepts.slice(0, 3).map(c => c.keyword).join(", ");
      return core
        ? `${core} 구조 위에서 합성 해결`
        : (analysis.synthesizedConsensus?.text ?? dominantStructure).slice(0, 160);
    }

    case "unresolved_dynamic_tension": {
      const tensions = analysis.unresolvedConflicts ?? [];
      const axes     = tensions.slice(0, 2).map(t => t.dimension);
      return axes.length >= 2
        ? `${axes[0]}와 ${axes[1]} 사이의 긴장이 유지됨`
        : "핵심 논점에서 지속적인 긴장 유지";
    }

    default: // stable_answer
      return (br?.finalProposalValue ?? dominantStructure).slice(0, 160);
  }
}

// ─── main: buildFinalResolution ──────────────────────────────────

export function buildFinalResolution(
  proposals: Proposal[],
  actors:    Author[],
  analysis:  Omit<DiscussionAnalysis, "finalResolution">,
): FinalResolution | undefined {
  if (proposals.length < 4) return undefined;

  // ── dominant structure 우선순위 ──────────────────────────────────
  const structCore  = analysis.structuralConsensus?.sharedStructure;
  const branchText  = analysis.branchSurvival?.dominantBranch?.finalProposalValue;
  const synthText   = analysis.synthesizedConsensus?.text;
  const fcText      = analysis.finalConclusion?.text;

  const dominantStructure = (
    (structCore && structCore.length >= 2 ? structCore.join(", ") : null) ??
    branchText ?? synthText ?? fcText ?? ""
  ).slice(0, 200);

  // ── surviving branches ───────────────────────────────────────────
  const survivingBranches = (analysis.branchSurvival?.branches ?? [])
    .filter(b => b.dominant || b.semanticPersistence >= 0.4)
    .map(b => b.finalProposalValue)
    .slice(0, 4);

  // ── resolution type ──────────────────────────────────────────────
  const resolutionType = determineResolutionType(analysis);

  // ── primary conclusion ───────────────────────────────────────────
  const primaryConclusion = buildPrimaryConclusion(resolutionType, dominantStructure, analysis);

  // ── evolutionary trajectory ──────────────────────────────────────
  const evolutionaryTrajectory = buildEvolutionaryTrajectory(
    proposals, actors, dominantStructure,
  );

  // ── unresolved tensions ──────────────────────────────────────────
  const unresolvedTensions = buildUnresolvedTensions(analysis);

  // ── confidence ──────────────────────────────────────────────────
  const baseConf = analysis.finalConclusion?.confidence
    ?? analysis.synthesizedConsensus?.confidence
    ?? 0.4;
  const boosts =
    (analysis.structuralConsensus ? 0.08 : 0) +
    (analysis.questionEvolution?.driftType === "transformed_topic" ? 0.06 : 0) +
    (analysis.branchSurvival?.dominantBranch ? 0.05 : 0);
  const confidence = Math.min(0.95, baseConf + boosts);

  // ── source description ───────────────────────────────────────────
  const SOURCE_DESC: Record<ResolutionType, string> = {
    stable_answer:              "안정 수렴",
    synthesized_resolution:     "합성 해결",
    transformed_resolution:     "질문 진화 해결",
    unresolved_dynamic_tension: "동적 긴장",
  };

  return {
    resolutionType,
    primaryConclusion,
    dominantStructure,
    survivingBranches,
    emergentQuestion:        analysis.questionEvolution?.emergentQuestion,
    structuralConsensusCore: structCore,
    evolutionaryTrajectory,
    unresolvedTensions,
    confidence,
    source: SOURCE_DESC[resolutionType],
  };
}
