import type { ArgumentGraph, ArgumentEvolution, ArgumentNode, ArgumentRelation } from "../../../src/types";

// ─── 상수 ─────────────────────────────────────────────────────────

const ACTOR_COLOR: Record<string, string> = {
  gpt:    "#10a37f",
  claude: "#d97706",
  gemini: "#4f46e5",
  user:   "#6b7280",
  system: "#9ca3af",
};

const RELATION_LABEL: Record<ArgumentRelation, string> = {
  supports:    "지지",
  criticizes:  "비판",
  refines:     "발전",
  concedes:    "수용",
  synthesizes: "합성",
  repeats:     "반복",
};

const RELATION_CLASS: Record<ArgumentRelation, string> = {
  supports:    "ag-rel-supports",
  criticizes:  "ag-rel-criticizes",
  refines:     "ag-rel-refines",
  concedes:    "ag-rel-concedes",
  synthesizes: "ag-rel-synthesizes",
  repeats:     "ag-rel-repeats",
};

// ─── 서브 컴포넌트 ─────────────────────────────────────────────────

function InfluenceDots({ score }: { score: number }) {
  const filled = Math.round(score * 4);
  return (
    <span className="ag-influence-dots" title={`영향력 ${Math.round(score * 100)}%`}>
      {[0, 1, 2, 3].map(i => (
        <span key={i} className={`ag-dot ${i < filled ? "ag-dot-filled" : ""}`} />
      ))}
    </span>
  );
}

function NodeCard({ node, isHighlight }: { node: ArgumentNode; isHighlight?: boolean }) {
  const color = ACTOR_COLOR[node.actor] ?? "#6b7280";
  const short = node.text.length > 50 ? node.text.slice(0, 47) + "…" : node.text;
  return (
    <div className={`ag-node${isHighlight ? " ag-node-highlight" : ""}`}>
      <div className="ag-node-header">
        <span className="ag-actor-chip" style={{ background: color + "22", color }}>
          {node.actor.toUpperCase()}
        </span>
        {node.stanceAction && node.stanceAction !== "propose" && (
          <span className={`ag-stance-tag ag-stance-${node.stanceAction}`}>
            {node.stanceAction === "refine" ? "발전" :
             node.stanceAction === "concede" ? "수용" :
             node.stanceAction === "defend" ? "방어" : node.stanceAction}
          </span>
        )}
        <InfluenceDots score={node.influenceScore} />
      </div>
      <div className="ag-node-text">{short}</div>
    </div>
  );
}

function ChainView({
  chain,
  edges,
  graph,
  highlightId,
  title,
}: {
  chain:       ArgumentNode[];
  edges:       ArgumentGraph["edges"];
  graph:       ArgumentGraph;
  highlightId: string | null;
  title:       string;
}) {
  if (chain.length === 0) return null;

  return (
    <div className="ag-chain-section">
      <div className="ag-chain-title">{title}</div>
      <div className="ag-chain">
        {chain.map((node, i) => {
          // 이 노드에서 다음 노드로 가는 엣지 찾기
          const nextId  = chain[i + 1]?.id;
          const edgeToNext = nextId
            ? edges.find(e => e.from === node.id && e.to === nextId)
            : null;
          return (
            <div key={node.id} className="ag-chain-item">
              <NodeCard node={node} isHighlight={node.id === highlightId} />
              {edgeToNext && (
                <div className={`ag-edge-connector ${RELATION_CLASS[edgeToNext.relation]}`}>
                  <span className="ag-edge-arrow">↓</span>
                  <span className="ag-edge-label">{RELATION_LABEL[edgeToNext.relation]}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── ArgumentGraphView (main export) ──────────────────────────────

export function ArgumentGraphView({
  graph,
  evolution,
}: {
  graph:     ArgumentGraph;
  evolution: ArgumentEvolution;
}) {
  const { nodes, edges } = graph;
  const {
    dominantChain,
    synthesisLineage,
    highestInfluenceNode,
    mostAbsorbedConcept,
    collapseLoops,
  } = evolution;

  if (nodes.length === 0) return null;

  // 표시할 메인 체인 선택: dominantChain vs synthesisLineage 중 더 긴 것
  const useLineage  = synthesisLineage.length > dominantChain.length && synthesisLineage.length >= 2;
  const mainChain   = useLineage ? synthesisLineage : dominantChain;
  const chainTitle  = useLineage ? "영향력 조상 체인" : "논리 진화 체인";

  // 체인에 없는 노드 → 보조 영향력 목록
  const chainIds    = new Set(mainChain.map(n => n.id));
  const sideNodes   = [...nodes]
    .filter(n => !chainIds.has(n.id))
    .sort((a, b) => b.influenceScore - a.influenceScore)
    .slice(0, 4);

  // 영향력 순위 (전체, 상위 5개)
  const topByInfluence = [...nodes]
    .sort((a, b) => b.influenceScore - a.influenceScore)
    .slice(0, 5);

  return (
    <div className="ag-root">

      {/* 메타 요약 행 */}
      <div className="ag-meta-row">
        {highestInfluenceNode && (
          <div className="ag-meta-item">
            <span className="ag-meta-label">최고 영향력 논거</span>
            <span className="ag-meta-value">
              <span
                className="ag-actor-chip"
                style={{
                  background: (ACTOR_COLOR[highestInfluenceNode.actor] ?? "#6b7280") + "22",
                  color:       ACTOR_COLOR[highestInfluenceNode.actor] ?? "#6b7280",
                }}
              >
                {highestInfluenceNode.actor.toUpperCase()}
              </span>
              {highestInfluenceNode.text.length > 40
                ? highestInfluenceNode.text.slice(0, 37) + "…"
                : highestInfluenceNode.text}
            </span>
          </div>
        )}
        {mostAbsorbedConcept && (
          <div className="ag-meta-item">
            <span className="ag-meta-label">가장 많이 흡수된 논거</span>
            <span className="ag-meta-value ag-absorbed">
              {mostAbsorbedConcept.length > 40
                ? mostAbsorbedConcept.slice(0, 37) + "…"
                : mostAbsorbedConcept}
            </span>
          </div>
        )}
        {collapseLoops.length > 0 && (
          <div className="ag-meta-item ag-loop-warning">
            <span className="ag-meta-label">⚠ 순환 논쟁 감지</span>
            <span className="ag-meta-value">{collapseLoops.length}개 루프</span>
          </div>
        )}
      </div>

      {/* 메인 체인 + 영향력 순위 */}
      <div className="ag-body">
        {/* 논리 진화 체인 */}
        {mainChain.length >= 2 && (
          <ChainView
            chain={mainChain}
            edges={edges}
            graph={graph}
            highlightId={highestInfluenceNode?.id ?? null}
            title={chainTitle}
          />
        )}

        {/* 우측: 영향력 순위 */}
        <div className="ag-influence-panel">
          <div className="ag-chain-title">영향력 순위</div>
          {topByInfluence.map((n, i) => {
            const color = ACTOR_COLOR[n.actor] ?? "#6b7280";
            const short = n.text.length > 36 ? n.text.slice(0, 33) + "…" : n.text;
            return (
              <div key={n.id} className={`ag-rank-row${n.id === highestInfluenceNode?.id ? " ag-rank-top" : ""}`}>
                <span className="ag-rank-num">#{i + 1}</span>
                <span className="ag-actor-chip" style={{ background: color + "22", color }}>
                  {n.actor.toUpperCase()}
                </span>
                <span className="ag-rank-text">{short}</span>
                <InfluenceDots score={n.influenceScore} />
              </div>
            );
          })}
        </div>
      </div>

      {/* 체인 외 추가 노드 */}
      {sideNodes.length > 0 && (
        <div className="ag-side-nodes">
          <div className="ag-side-title">기타 논거</div>
          <div className="ag-side-grid">
            {sideNodes.map(n => (
              <NodeCard key={n.id} node={n} />
            ))}
          </div>
        </div>
      )}

      {/* 엣지 타입 범례 */}
      <div className="ag-legend">
        {(["refines","concedes","criticizes","supports","repeats"] as ArgumentRelation[]).map(r => (
          <span key={r} className={`ag-legend-item ${RELATION_CLASS[r]}`}>
            {RELATION_LABEL[r]}
          </span>
        ))}
      </div>
    </div>
  );
}
