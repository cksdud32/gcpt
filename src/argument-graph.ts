import type {
  Topic, Proposal, Author,
  ArgumentNode, ArgumentEdge, ArgumentGraph, ArgumentEvolution,
  StanceAction,
} from "./types.js";

// ─── 유틸리티 ──────────────────────────────────────────────────────

const EN_STOPWORDS = new Set([
  "the","a","an","is","are","was","were","be","been","have","has","had",
  "do","does","did","will","would","could","should","may","to","of","in",
  "on","at","by","for","with","as","from","or","and","but","if","it",
  "its","this","that","these","those","not","no",
]);

function extractKws(text: string | undefined | null): string[] {
  if (!text) return [];
  return [...new Set(
    text.toLowerCase()
      .split(/[\s,.:;!?()\[\]{}"']+/)
      .filter(t => t.length >= 2 && !EN_STOPWORDS.has(t)),
  )];
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const k of setA) if (setB.has(k)) inter++;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : inter / union;
}

function propText(p: Proposal): string {
  const c = p.content as { value?: string; reason?: string };
  return `${c.value ?? ""} ${c.reason ?? ""} ${p.rationale ?? ""}`.trim();
}

// ─── 임계값 ─────────────────────────────────────────────────────────

const REPEAT_THRESHOLD  = 0.75;  // 같은 actor 자기 반복 감지
const SUPPORT_THRESHOLD = 0.40;  // cross-actor 키워드 겹침 → supports

// 아웃고잉 엣지당 영향력 가중치 (이 노드가 다음 노드를 얼마나 움직였는가)
const EDGE_WEIGHTS: Record<string, number> = {
  concedes:    3.0,   // 상대방이 양보함 → 강한 영향
  synthesizes: 2.5,
  refines:     2.0,
  criticizes:  1.5,
  supports:    1.0,
  repeats:     0.3,
};

// ─── buildArgumentGraph ──────────────────────────────────────────────

export function buildArgumentGraph(topic: Topic): ArgumentGraph {
  // chat_reply 제외, 토론 제안만 처리
  const proposals = topic.proposals.filter(p => {
    const t = (p.content as { type?: string }).type;
    return t === "propose_decision" || t === "propose_alternative";
  });

  if (proposals.length < 2) return { nodes: [], edges: [] };

  // ── 노드 생성 ──────────────────────────────────────────────────
  const nodes: ArgumentNode[] = proposals.map(p => {
    const c = p.content as { value?: string; stanceAction?: string };
    return {
      id:             `n-${p.revisionId}`,
      revisionId:     p.revisionId,
      actor:          p.author,
      text:           c.value ?? "",
      keywords:       extractKws(propText(p)),
      stanceAction:   c.stanceAction as StanceAction | undefined,
      influenceScore: 0,
    };
  });

  const nodeById = new Map(nodes.map(n => [n.id, n]));
  const edges: ArgumentEdge[] = [];

  // ── 엣지 생성 ──────────────────────────────────────────────────
  for (let i = 1; i < proposals.length; i++) {
    const p      = proposals[i];
    const nodeId = `n-${p.revisionId}`;
    const node   = nodes[i];
    const stance = (p.content as { stanceAction?: string }).stanceAction;

    // 같은 actor의 이전 발언 (바로 직전 것)
    const ownPrior = proposals.slice(0, i).filter(q => q.author === p.author);
    const ownPrevId   = ownPrior.length > 0 ? `n-${ownPrior[ownPrior.length - 1].revisionId}` : null;
    const ownPrevNode = ownPrevId ? nodeById.get(ownPrevId) : null;

    // 다른 actor의 최근 발언 (윈도우 5 이내)
    const foreignPrior = proposals.slice(Math.max(0, i - 5), i).filter(q => q.author !== p.author);
    const foreignPrevId   = foreignPrior.length > 0 ? `n-${foreignPrior[foreignPrior.length - 1].revisionId}` : null;
    const foreignPrevNode = foreignPrevId ? nodeById.get(foreignPrevId) : null;

    // stanceAction 기반 Primary 엣지
    if (stance === "refine" && ownPrevNode) {
      edges.push({ from: ownPrevId!, to: nodeId, relation: "refines" });
    } else if (stance === "concede" && foreignPrevNode) {
      edges.push({ from: foreignPrevId!, to: nodeId, relation: "concedes" });
    } else if (stance === "defend" && foreignPrevNode) {
      edges.push({ from: foreignPrevId!, to: nodeId, relation: "criticizes" });
    } else if (foreignPrevNode) {
      // propose 또는 미분류: 키워드 유사도로 판별
      const sim = jaccard(node.keywords, foreignPrevNode.keywords);
      edges.push({
        from:     foreignPrevId!,
        to:       nodeId,
        relation: sim >= SUPPORT_THRESHOLD ? "supports" : "criticizes",
      });
    }

    // 자기 반복 Secondary 엣지 (refine이 아닌데 높은 자기 유사도)
    if (ownPrevNode && stance !== "refine") {
      const selfSim = jaccard(node.keywords, ownPrevNode.keywords);
      if (selfSim >= REPEAT_THRESHOLD) {
        edges.push({ from: ownPrevId!, to: nodeId, relation: "repeats" });
      }
    }
  }

  // ── 영향력 점수 계산 ──────────────────────────────────────────
  // 아웃고잉 엣지 가중치 합산 → 이 노드가 다음 노드들에게 얼마나 영향을 줬는가
  const rawScores = new Map<string, number>();
  for (const e of edges) {
    const w = EDGE_WEIGHTS[e.relation] ?? 1;
    rawScores.set(e.from, (rawScores.get(e.from) ?? 0) + w);
  }
  const maxScore = Math.max(1, ...rawScores.values());
  for (const node of nodes) {
    node.influenceScore = Math.round(((rawScores.get(node.id) ?? 0) / maxScore) * 100) / 100;
  }

  return { nodes, edges };
}

// ─── analyzeArgumentEvolution ─────────────────────────────────────────

export function analyzeArgumentEvolution(graph: ArgumentGraph): ArgumentEvolution {
  const { nodes, edges } = graph;

  if (nodes.length === 0) {
    return {
      dominantChain:        [],
      mostAbsorbedConcept:  "",
      highestInfluenceNode: null,
      collapseLoops:        [],
      synthesisLineage:     [],
    };
  }

  // ── 최고 영향력 노드 ────────────────────────────────────────────
  const highestInfluenceNode = [...nodes].sort((a, b) => b.influenceScore - a.influenceScore)[0] ?? null;

  // ── 가장 많이 흡수된 개념 ──────────────────────────────────────
  // concedes/synthesizes 엣지의 source가 흡수된 논거
  const absorbedTexts = edges
    .filter(e => e.relation === "concedes" || e.relation === "synthesizes")
    .map(e => nodes.find(n => n.id === e.from)?.text ?? "")
    .filter(Boolean);
  const absorbedCount = new Map<string, number>();
  for (const t of absorbedTexts) absorbedCount.set(t, (absorbedCount.get(t) ?? 0) + 1);
  const mostAbsorbedConcept =
    [...absorbedCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";

  // ── 순환 비판 루프 감지 ─────────────────────────────────────────
  // A → criticizes → B, B → criticizes → A 패턴
  const collapseLoops: string[][] = [];
  const critEdges = edges.filter(e => e.relation === "criticizes");
  const loopSeen  = new Set<string>();
  for (const e1 of critEdges) {
    for (const e2 of critEdges) {
      if (e1.from === e2.to && e1.to === e2.from) {
        const key = [e1.from, e1.to].sort().join(":");
        if (!loopSeen.has(key)) {
          loopSeen.add(key);
          collapseLoops.push([e1.from, e1.to]);
        }
      }
    }
  }

  // ── Dominant Chain: 가장 긴 진화 경로 ──────────────────────────
  // refines / concedes / synthesizes 엣지만 따라가는 가장 긴 경로
  const EVOLUTIONARY = new Set(["refines", "concedes", "synthesizes"]);
  const evoEdges     = edges.filter(e => EVOLUTIONARY.has(e.relation));

  // 정방향 인접 목록
  const fwd = new Map<string, string[]>();
  for (const e of evoEdges) {
    if (!fwd.has(e.from)) fwd.set(e.from, []);
    fwd.get(e.from)!.push(e.to);
  }

  // 진입 엣지가 없는 노드 = 체인 루트
  const hasEvoIncoming = new Set(evoEdges.map(e => e.to));
  const roots = nodes.filter(n => !hasEvoIncoming.has(n.id));

  let bestChainIds: string[] = [];
  const dfs = (id: string, path: string[], visited: Set<string>) => {
    if (path.length > bestChainIds.length) bestChainIds = [...path];
    for (const next of (fwd.get(id) ?? [])) {
      if (!visited.has(next)) {
        visited.add(next);
        dfs(next, [...path, next], visited);
        visited.delete(next);
      }
    }
  };
  for (const root of roots) {
    dfs(root.id, [root.id], new Set([root.id]));
  }
  const dominantChain = bestChainIds
    .map(id => nodes.find(n => n.id === id))
    .filter((n): n is ArgumentNode => n !== undefined);

  // ── Synthesis Lineage: highestInfluenceNode까지의 조상 체인 ────
  const bwd = new Map<string, string[]>();
  for (const e of evoEdges) {
    if (!bwd.has(e.to)) bwd.set(e.to, []);
    bwd.get(e.to)!.push(e.from);
  }

  const lineageIds: string[]   = [];
  const lineageSeen = new Set<string>();
  const traceBack = (id: string) => {
    if (lineageSeen.has(id)) return;
    lineageSeen.add(id);
    for (const prev of (bwd.get(id) ?? [])) traceBack(prev);
    lineageIds.push(id);
  };
  if (highestInfluenceNode) traceBack(highestInfluenceNode.id);

  const synthesisLineage = lineageIds
    .map(id => nodes.find(n => n.id === id))
    .filter((n): n is ArgumentNode => n !== undefined);

  return {
    dominantChain,
    mostAbsorbedConcept,
    highestInfluenceNode,
    collapseLoops,
    synthesisLineage,
  };
}
