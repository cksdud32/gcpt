import type {
  Topic, Proposal, Author,
  ArgumentGraph, ArgumentEvolution,
  ReasoningBranch, BranchSurvivalAnalysis,
} from "./types.js";
import { DEFENSE_DECAY } from "./evolution-pressure.js";
import { extractKeywordsNT } from "./novelty-tracker.js";

// ─── Union-Find ───────────────────────────────────────────────────

class UnionFind {
  private parent: Map<number, number> = new Map();

  find(x: number): number {
    if (!this.parent.has(x)) this.parent.set(x, x);
    const p = this.parent.get(x)!;
    if (p !== x) {
      const root = this.find(p);
      this.parent.set(x, root);
      return root;
    }
    return x;
  }

  union(x: number, y: number): void {
    this.parent.set(this.find(y), this.find(x));
  }
}

// ─── 유틸 ─────────────────────────────────────────────────────────

function propText(p: Proposal): string {
  const c = p.content as { value?: string; reason?: string };
  return `${c.value ?? ""} ${c.reason ?? ""} ${p.rationale ?? ""}`;
}

function propValue(p: Proposal): string {
  return (p.content as { value?: string }).value ?? "";
}

function jaccardKwds(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const k of a) if (b.has(k)) inter++;
  return inter / (a.size + b.size - inter);
}

// ─── Branch 구성 (Union-Find 기반) ───────────────────────────────

interface RawBranchData {
  revisionIds: number[];
  actors: Set<Author>;
  proposalIndexes: number[];
}

function buildReasoningBranches(
  proposals: Proposal[],
  graph:     ArgumentGraph | undefined,
): RawBranchData[] {
  if (proposals.length === 0) return [];

  const uf = new UnionFind();
  // 모든 proposal을 자기 자신으로 초기화
  for (const p of proposals) uf.find(p.revisionId);

  // 1. Argument Graph 진화 엣지로 연결 (refines / concedes / synthesizes)
  if (graph) {
    const EVOLUTIONARY_RELATIONS = new Set(["refines", "concedes", "synthesizes"]);
    const nodeRevId = new Map(graph.nodes.map(n => [n.id, n.revisionId]));

    for (const edge of graph.edges) {
      if (!EVOLUTIONARY_RELATIONS.has(edge.relation)) continue;
      const fromRevId = nodeRevId.get(edge.from);
      const toRevId   = nodeRevId.get(edge.to);
      if (fromRevId !== undefined && toRevId !== undefined) {
        uf.union(fromRevId, toRevId);
      }
    }
  }

  // 2. references 기반 lineage 연결
  for (const p of proposals) {
    const refs = (p.content as { references?: number[] }).references ?? [];
    for (const refId of refs) {
      if (proposals.some(q => q.revisionId === refId)) {
        uf.union(refId, p.revisionId);
      }
    }
  }

  // 3. Semantic Jaccard >= 0.55 이면 같은 branch
  const kwdCache = new Map<number, Set<string>>();
  for (const p of proposals) {
    kwdCache.set(p.revisionId, extractKeywordsNT(propText(p)));
  }

  for (let i = 0; i < proposals.length; i++) {
    for (let j = i + 1; j < proposals.length; j++) {
      const pi = proposals[i], pj = proposals[j];
      const ki = kwdCache.get(pi.revisionId)!;
      const kj = kwdCache.get(pj.revisionId)!;
      if (jaccardKwds(ki, kj) >= 0.55) {
        uf.union(pi.revisionId, pj.revisionId);
      }
    }
  }

  // 컴포넌트 수집
  const components = new Map<number, RawBranchData>();
  for (let i = 0; i < proposals.length; i++) {
    const p    = proposals[i];
    const root = uf.find(p.revisionId);
    let comp   = components.get(root);
    if (!comp) {
      comp = { revisionIds: [], actors: new Set(), proposalIndexes: [] };
      components.set(root, comp);
    }
    comp.revisionIds.push(p.revisionId);
    comp.actors.add(p.author);
    comp.proposalIndexes.push(i);
  }

  return [...components.values()];
}

// ─── Branch Scoring ───────────────────────────────────────────────

function scoreBranch(
  raw:       RawBranchData,
  proposals: Proposal[],
  totalProp: number,
): ReasoningBranch {
  const branchProposals = raw.proposalIndexes.map(i => proposals[i]);

  // 기본 카운트
  let concedeCount = 0, refineCount = 0, defendCount = 0, proposeCount = 0;
  const actorConcedeMap = new Map<Author, number>();

  for (const p of branchProposals) {
    const sa = (p.content as { stanceAction?: string }).stanceAction;
    if (sa === "concede")       { concedeCount++; actorConcedeMap.set(p.author, (actorConcedeMap.get(p.author) ?? 0) + 1); }
    else if (sa === "refine")   refineCount++;
    else if (sa === "defend")   defendCount++;
    else                        proposeCount++;
  }

  const total = branchProposals.length;
  const repeatedDefenseRatio = total > 0 ? defendCount / total : 0;

  // rootRevisionId = 가장 작은 revisionId (가장 먼저 등장)
  const sortedRevIds = [...raw.revisionIds].sort((a, b) => a - b);
  const rootRevisionId   = sortedRevIds[0];
  const latestRevisionId = sortedRevIds[sortedRevIds.length - 1];

  // Semantic Persistence — defend decay 적용
  const defendCounts = new Map<Author, number>();
  let persistenceSum = 0;
  for (const p of branchProposals) {
    const sa = (p.content as { stanceAction?: string }).stanceAction;
    if (sa === "defend") {
      const cnt = (defendCounts.get(p.author) ?? 0) + 1;
      defendCounts.set(p.author, cnt);
      persistenceSum += DEFENSE_DECAY[Math.min(cnt - 1, DEFENSE_DECAY.length - 1)];
    } else {
      persistenceSum += 1.0;
    }
  }
  const semanticPersistence = total > 0 ? persistenceSum / total : 0;

  // Innovation Retention — 새 키워드 비율
  const seenKwds = new Set<string>();
  let newKwdTotal = 0, allKwdTotal = 0;
  for (const p of branchProposals) {
    const kwds = extractKeywordsNT(propText(p));
    let newCount = 0;
    for (const k of kwds) {
      allKwdTotal++;
      if (!seenKwds.has(k)) { newCount++; seenKwds.add(k); }
    }
    newKwdTotal += newCount;
  }
  const innovationRetention = allKwdTotal > 0 ? newKwdTotal / allKwdTotal : 0;

  // sharedConcepts: branch 내에서 2개 이상 actor가 사용하는 키워드
  const actorKwds = new Map<Author, Set<string>>();
  for (const p of branchProposals) {
    const kwds = extractKeywordsNT(propText(p));
    const pool = actorKwds.get(p.author) ?? new Set<string>();
    for (const k of kwds) pool.add(k);
    actorKwds.set(p.author, pool);
  }
  const sharedConcepts: string[] = [];
  if (actorKwds.size >= 2) {
    const allKwds = new Set([...actorKwds.values()].flatMap(s => [...s]));
    for (const kwd of allKwds) {
      const usedBy = [...actorKwds.values()].filter(s => s.has(kwd)).length;
      if (usedBy >= 2) sharedConcepts.push(kwd);
    }
  }

  // convergenceScore = actor간 jaccard 평균
  let convergenceScore = 0;
  if (actorKwds.size >= 2) {
    const pools = [...actorKwds.values()];
    let total2 = 0, pairs = 0;
    for (let i = 0; i < pools.length; i++) {
      for (let j = i + 1; j < pools.length; j++) {
        total2 += jaccardKwds(pools[i], pools[j]);
        pairs++;
      }
    }
    convergenceScore = pairs > 0 ? total2 / pairs : 0;
  }

  // normalized depths
  const maxPossible = Math.max(1, total);
  const normalizedConcede = Math.min(1, concedeCount / maxPossible);
  const normalizedRefine  = Math.min(1, refineCount  / maxPossible);
  const actorDiversity    = Math.min(1, raw.actors.size / 3);

  // repeated defense penalty
  const repeatedDefensePenalty = repeatedDefenseRatio * 0.25;

  // SURVIVAL SCORE
  const survivalScore = Math.max(0, Math.min(1,
    convergenceScore   * 0.28
    + normalizedConcede  * 0.20
    + normalizedRefine   * 0.18
    + innovationRetention * 0.18
    + actorDiversity      * 0.10
    + semanticPersistence * 0.06
    - repeatedDefensePenalty,
  ));

  // branchSummary
  const latestProp    = branchProposals.find(p => p.revisionId === latestRevisionId);
  const finalProposalValue = latestProp ? propValue(latestProp) : "";
  const actorStr      = [...raw.actors].join("+");
  const branchSummary = `[${actorStr}] ${concedeCount}양보 ${refineCount}발전 — 수렴도 ${(convergenceScore * 100).toFixed(0)}%`;

  return {
    id:                  `branch-${rootRevisionId}`,
    rootRevisionId,
    latestRevisionId,
    revisionIds:         sortedRevIds,
    actors:              [...raw.actors],
    sharedConcepts:      sharedConcepts.slice(0, 8),
    branchSummary,
    convergenceScore,
    survivalScore,
    concedeDepth:        concedeCount,
    refineDepth:         refineCount,
    semanticPersistence,
    innovationRetention,
    repeatedDefenseRatio,
    finalProposalValue,
    dominant:            false,
  };
}

// ─── 메인 함수 ───────────────────────────────────────────────────

export function analyzeBranchSurvival(
  topic:     Topic,
  graph?:    ArgumentGraph,
  _evolution?: ArgumentEvolution,
): BranchSurvivalAnalysis {
  const proposals = topic.proposals;

  if (proposals.length < 2) {
    return { branches: [], dominantBranch: undefined, branchEvolutionSummary: "제안이 부족하여 branch 분석 불가" };
  }

  const rawBranches = buildReasoningBranches(proposals, graph);
  const branches    = rawBranches
    .map(raw => scoreBranch(raw, proposals, proposals.length))
    .sort((a, b) => b.survivalScore - a.survivalScore);

  // 고유 actor가 2명 이상 + survivalScore >= 0.40 + repeatedDefenseRatio < 0.6
  const actors = [...new Set(proposals.map(p => p.author))].filter(
    a => a !== "system" && a !== "user",
  );
  const candidateDominant = branches.find(
    b => b.actors.filter(a => a !== "system" && a !== "user").length >= Math.min(2, actors.length)
      && b.survivalScore >= 0.40
      && b.repeatedDefenseRatio < 0.60,
  );

  if (candidateDominant) candidateDominant.dominant = true;

  // branchEvolutionSummary
  let summary: string;
  if (!candidateDominant) {
    if (branches.length === 1) {
      summary = `단일 논리 흐름 — 독립된 branch 없음 (생존 점수 ${(branches[0].survivalScore * 100).toFixed(0)}%)`;
    } else {
      summary = `${branches.length}개 branch 중 지배적 생존 lineage 없음 (최고 점수 ${(branches[0]?.survivalScore ?? 0 * 100).toFixed(0)}%)`;
    }
  } else {
    const d = candidateDominant;
    summary = `'${[...d.actors].join("+")}' 공동 lineage 생존 — `
      + `수렴도 ${(d.convergenceScore * 100).toFixed(0)}%, `
      + `양보 ${d.concedeDepth}회, 발전 ${d.refineDepth}회 (생존점수 ${(d.survivalScore * 100).toFixed(0)}%)`;
  }

  return {
    branches,
    dominantBranch:        candidateDominant,
    branchEvolutionSummary: summary,
  };
}
