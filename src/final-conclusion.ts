/**
 * Final Conclusion Resolver
 *
 * "누가 이겼는가(selectedOption)"가 아닌
 * "토론이 실제로 어디까지 진화했는가"를 결론으로 도출한다.
 *
 * 우선순위:
 *   A. synthesisQualityScore >= 0.55  → synthesized_consensus
 *   B. late-phase proposal의 sharedConcept coverage > selectedOption + 0.15 → hybrid
 *   C. otherwise                       → selected_option 유지
 */

import type {
  Topic, Proposal, FinalConclusion, DiscussionAnalysis, SynthesizedConsensus,
  ArgumentGraph, ArgumentEvolution, BranchSurvivalAnalysis,
} from "./types.js";
import { computeBranchInnovation } from "./evolution-pressure.js";

// ─── 유틸 ─────────────────────────────────────────────────────────

function propText(p: Proposal): string {
  const c = p.content as { value?: string; reason?: string };
  return `${c.value ?? ""} ${c.reason ?? ""} ${p.rationale ?? ""}`;
}

/**
 * proposal 텍스트에서 synthesis 공유 개념이 얼마나 커버되는지 0–1 반환.
 */
function computeSharedCoverage(
  text:      string,
  synthesis: SynthesizedConsensus | undefined | null,
): number {
  if (!synthesis || synthesis.sharedConcepts.length === 0) return 0;
  const lower = text.toLowerCase();
  const hits  = synthesis.sharedConcepts.filter(c => lower.includes(c.keyword)).length;
  return hits / synthesis.sharedConcepts.length;
}

// ─── Argument Graph 인덱스 ───────────────────────────────────────

interface ArgGraphIndex {
  influenceByRevId:    Map<number, number>;
  dominantChainRevIds: Set<number>;
  lineageRevIds:       Set<number>;
  concedeTargetRevIds: Set<number>;  // concede/synthesizes 엣지를 받은 노드 (흡수됨 = 진화 촉진)
}

function buildArgGraphIndex(
  graph?:     ArgumentGraph,
  evolution?: ArgumentEvolution,
): ArgGraphIndex {
  const influenceByRevId    = new Map<number, number>();
  const dominantChainRevIds = new Set<number>();
  const lineageRevIds       = new Set<number>();
  const concedeTargetRevIds = new Set<number>();

  if (!graph) return { influenceByRevId, dominantChainRevIds, lineageRevIds, concedeTargetRevIds };

  for (const node of graph.nodes) {
    influenceByRevId.set(node.revisionId, node.influenceScore);
  }
  for (const node of evolution?.dominantChain ?? []) {
    dominantChainRevIds.add(node.revisionId);
  }
  for (const node of evolution?.synthesisLineage ?? []) {
    lineageRevIds.add(node.revisionId);
  }
  // concede/synthesizes 엣지를 받은 노드 (다른 논리를 흡수한 노드)
  for (const edge of graph.edges) {
    if (edge.relation === "concedes" || edge.relation === "synthesizes") {
      const targetNode = graph.nodes.find(n => n.id === edge.to);
      if (targetNode) concedeTargetRevIds.add(targetNode.revisionId);
    }
  }

  return { influenceByRevId, dominantChainRevIds, lineageRevIds, concedeTargetRevIds };
}

/**
 * 후반부 proposal 하나에 대한 종합 점수 계산.
 * - sharedConcept coverage (핵심)
 * - stanceAction 보너스 (concede/refine = 적극 수렴) — 강화
 * - Argument Graph influence score
 * - dominant chain / synthesis lineage 보너스
 * - unresolvedConflict 언급 보너스
 */
function scoreLateProposal(
  prop:                Proposal,
  synthesis:           SynthesizedConsensus | undefined | null,
  unresolvedConflicts: { dimension: string }[],
  argIdx:              ArgGraphIndex,
  innovationScores:    Map<number, number>,
): number {
  const text = propText(prop);
  let score  = computeSharedCoverage(text, synthesis);

  const sa = (prop.content as { stanceAction?: string }).stanceAction;
  if (sa === "concede") score += 0.30;
  if (sa === "refine")  score += 0.22;

  // Argument Graph 기반 Evolution 보너스
  const influence = argIdx.influenceByRevId.get(prop.revisionId) ?? 0;
  score += influence * 0.25;
  if (argIdx.dominantChainRevIds.has(prop.revisionId))  score += 0.18;
  if (argIdx.lineageRevIds.has(prop.revisionId))         score += 0.12;
  if (argIdx.concedeTargetRevIds.has(prop.revisionId))   score += 0.10;

  // Branch Innovation Score
  const innovScore = innovationScores.get(prop.revisionId) ?? 0;
  if (innovScore > 0)  score += innovScore * 0.35;
  if (innovScore < 0)  score += innovScore * 0.20; // 반복 defend 감점

  const conflictHits = unresolvedConflicts.filter(c =>
    c.dimension.split(",").some(kwd => text.toLowerCase().includes(kwd.trim())),
  ).length;
  score += conflictHits * 0.08;

  return score;
}

// ─── revision ID 수집 ─────────────────────────────────────────────

function buildSynthesisRevIds(
  synthesis: SynthesizedConsensus,
  proposals: Proposal[],
): number[] {
  const ids = new Set<number>();

  for (const a of synthesis.absorbedArguments) ids.add(a.revisionId);

  const third = Math.max(1, Math.ceil(proposals.length / 3));
  for (const p of proposals.slice(-third)) {
    if (computeSharedCoverage(propText(p), synthesis) > 0.20) ids.add(p.revisionId);
  }

  return [...ids].slice(0, 5);
}

// ─── reason 문장 생성 ─────────────────────────────────────────────

function buildSynthesisReason(
  synthesis:        SynthesizedConsensus,
  selectedRevId:    number | null,
  selectedText:     string | null,
): string {
  const parts: string[] = [];

  if (selectedRevId !== null && selectedText) {
    const preview = selectedText.length > 35
      ? selectedText.slice(0, 35) + "…"
      : selectedText;
    parts.push(`초기 selectedOption(#${selectedRevId}: '${preview}')보다 후반부 수렴 프레임이 강함`);
  }

  if (synthesis.absorbedArguments.length > 0) {
    const absStr = synthesis.absorbedArguments.slice(0, 2)
      .map(a => `${a.by}가 ${a.from}의 '${a.concept}'를 흡수`)
      .join("; ");
    parts.push(absStr);
  }

  if (synthesis.sharedConcepts.length > 0) {
    const kwds = synthesis.sharedConcepts.slice(0, 3)
      .map(c => `'${c.keyword}'`).join(", ");
    parts.push(`공유 개념 ${kwds} 중심으로 수렴`);
  }

  return parts.join(". ") || "합성 품질이 selectedOption보다 높음";
}

function buildHybridReason(
  lateProp:      Proposal,
  selectedRevId: number | null,
): string {
  const parts: string[] = [];
  if (selectedRevId !== null) {
    parts.push(`후반부 proposal(#${lateProp.revisionId})이 selectedOption(#${selectedRevId})보다 공유 개념 coverage가 높음`);
  }
  const sa = (lateProp.content as { stanceAction?: string }).stanceAction;
  if (sa === "concede" || sa === "refine") {
    parts.push(`stanceAction=${sa}으로 적극 수렴 중인 발언`);
  }
  return parts.join(". ") || `후반부 proposal #${lateProp.revisionId}을 기반으로 결론 생성`;
}

// ─── 메인 함수 ────────────────────────────────────────────────────

function buildSurvivingBranchReason(bs: BranchSurvivalAnalysis): string {
  const d = bs.dominantBranch!;
  const parts: string[] = [
    `${[...d.actors].join("+")} 공동 논리 lineage 생존 (생존점수 ${(d.survivalScore * 100).toFixed(0)}%)`,
  ];
  if (d.concedeDepth > 0) parts.push(`${d.concedeDepth}회 양보로 논리 흡수`);
  if (d.refineDepth > 0)  parts.push(`${d.refineDepth}회 발전으로 주장 진화`);
  if (d.sharedConcepts.length > 0) {
    parts.push(`공유 개념: ${d.sharedConcepts.slice(0, 3).map(k => `'${k}'`).join(", ")}`);
  }
  return parts.join(". ");
}

export function resolveFinalConclusion(
  topic:    Topic,
  analysis: DiscussionAnalysis,
): FinalConclusion | null {
  const { proposals, selectedOption } = topic;
  const { synthesizedConsensus: synthesis, unresolvedConflicts, argumentGraph, argumentEvolution, branchSurvival, convergenceFreeze } = analysis;

  // Argument Graph 인덱스 (evolution score 계산용)
  const argIdx = buildArgGraphIndex(argumentGraph, argumentEvolution);

  // Branch Innovation Score (proposal별 혁신성)
  const sharedKwds = new Set(
    (synthesis?.sharedConcepts ?? []).map(c => c.keyword),
  );
  const innovationScores = computeBranchInnovation(proposals, sharedKwds);

  if (proposals.length === 0) return null;

  const selRevId  = selectedOption?.revisionId ?? null;
  const selText   = selectedOption
    ? (selectedOption.content as { value: string }).value
    : null;

  const actors = [...new Set(proposals.map(p => p.author))].filter(
    a => a !== "system" && a !== "user",
  );

  // ── AAAA. Structural Consensus (pseudo-debate 확인) ──────────────
  // 표면 불일치 이면에 공유 구조가 확인되면 최우선으로 structural_consensus 반환
  const { semanticLoop, structuralConsensus } = analysis as {
    semanticLoop?:        { isPseudoDebate: boolean; sharedCoreConcepts: string[]; semanticDriftScore: number };
    structuralConsensus?: { sharedStructure: string[]; structuralNote: string };
  };
  if (
    semanticLoop?.isPseudoDebate &&
    structuralConsensus &&
    structuralConsensus.sharedStructure.length >= 4 &&
    semanticLoop.semanticDriftScore < 0.25
  ) {
    const core    = structuralConsensus.sharedStructure.slice(0, 5).join(", ");
    const text    = `공유 구조: ${core}. ${structuralConsensus.structuralNote}`;
    const revIds  = proposals.slice(-4).map(p => p.revisionId);
    return {
      text:               text.slice(0, 220),
      source:             "structural_consensus",
      confidence:         Math.min(0.9, 0.55 + (structuralConsensus.sharedStructure.length - 4) * 0.05),
      basedOnRevisionIds: revIds,
      reason:             `표면 불일치 이면에 "${core}" 구조 공유 — Semantic Loop로 구조 수렴 확인됨`,
    };
  }

  // ── AAA. Convergence Freeze: 마지막 의미 있는 revision 사용 ─────
  // frozen이고 lastMeaningfulRevisionId가 있으면 해당 proposal을 결론으로
  if (convergenceFreeze?.frozen && convergenceFreeze.lastMeaningfulRevisionId !== undefined) {
    const lastProp = proposals.find(p => p.revisionId === convergenceFreeze.lastMeaningfulRevisionId);
    if (lastProp) {
      const lc = lastProp.content as { value: string; reason?: string };
      const freezeLabel = convergenceFreeze.freezeType === "discussion_exhausted"
        ? "novelty 소진 — 마지막 의미 진화"
        : convergenceFreeze.freezeType === "semantic_convergence"
        ? "의미 수렴 완료 — 마지막 의미 진화"
        : "branch frozen — 마지막 의미 진화";
      return {
        text:               lc.value.slice(0, 200),
        source:             "surviving_branch",
        confidence:         Math.min(1, (branchSurvival?.dominantBranch?.survivalScore ?? 0.5) + 0.1),
        basedOnRevisionIds: [convergenceFreeze.lastMeaningfulRevisionId],
        reason:             `${freezeLabel} (revision #${convergenceFreeze.lastMeaningfulRevisionId}) — ${convergenceFreeze.reason}`,
      };
    }
  }

  // ── AA. 지배적 생존 Branch → surviving_branch ──────────────────
  const dominant = branchSurvival?.dominantBranch;
  if (
    dominant
    && dominant.survivalScore >= 0.40
    && actors.length >= 2
    && dominant.finalProposalValue.length > 0
  ) {
    return {
      text:               dominant.finalProposalValue.slice(0, 200),
      source:             "surviving_branch",
      confidence:         Math.min(1, dominant.survivalScore),
      basedOnRevisionIds: dominant.revisionIds.slice(-4),
      reason:             buildSurvivingBranchReason(branchSurvival!),
    };
  }

  // ── A. 고품질 synthesis → synthesized_consensus ───────────────
  const synthScore = synthesis?.synthesisQualityScore ?? synthesis?.confidence ?? 0;
  if (synthesis && synthScore >= 0.55) {
    return {
      text:               synthesis.text,
      source:             "synthesized_consensus",
      confidence:         Math.min(1, synthScore),
      basedOnRevisionIds: buildSynthesisRevIds(synthesis, proposals),
      reason:             buildSynthesisReason(synthesis, selRevId, selText),
    };
  }

  // ── B. late-phase bias: 후반 proposal vs selectedOption ──────
  const third     = Math.max(1, Math.ceil(proposals.length / 3));
  const lateProps = proposals.slice(-third);

  let bestLate: Proposal | null = null;
  let bestScore = -Infinity;
  for (const p of lateProps) {
    const s = scoreLateProposal(p, synthesis, unresolvedConflicts ?? [], argIdx, innovationScores);
    if (s > bestScore) { bestScore = s; bestLate = p; }
  }

  const selCoverage = selText
    ? computeSharedCoverage(selText, synthesis)
    : 0;

  if (bestLate && bestScore > selCoverage + 0.15) {
    const lc   = bestLate.content as { value: string; reason: string };
    // hybrid text: late proposal 텍스트 (reason이 더 길면 포함)
    const text = lc.reason && lc.reason.trim().length > lc.value.trim().length
      ? `${lc.value} — ${lc.reason}`.slice(0, 200)
      : lc.value.slice(0, 120);

    return {
      text,
      source:             "hybrid",
      confidence:         Math.min(1, (bestScore + (synthesis?.confidence ?? 0)) / 2),
      basedOnRevisionIds: selRevId !== null
        ? [bestLate.revisionId, selRevId]
        : [bestLate.revisionId],
      reason: buildHybridReason(bestLate, selRevId),
    };
  }

  // ── C. selectedOption 유지 ────────────────────────────────────
  if (selectedOption) {
    const c = selectedOption.content as { value: string };
    return {
      text:               c.value,
      source:             "selected_option",
      confidence:         0.60,
      basedOnRevisionIds: [selectedOption.revisionId],
      reason:             synthesis
        ? `synthesis 품질(${(synthScore * 100).toFixed(0)}%) 부족 — selectedOption(#${selectedOption.revisionId}) 유지`
        : `synthesis 없음 — selectedOption(#${selectedOption.revisionId}) 유지`,
    };
  }

  // ── Fallback: 마지막 proposal ────────────────────────────────
  const last = proposals[proposals.length - 1];
  const lc   = last.content as { value: string };
  return {
    text:               lc.value,
    source:             "selected_option",
    confidence:         0.30,
    basedOnRevisionIds: [last.revisionId],
    reason:             "selectedOption 없음 — 마지막 proposal 사용",
  };
}
