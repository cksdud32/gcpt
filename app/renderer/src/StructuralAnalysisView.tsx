import type {
  SemanticLoopAnalysis,
  ConceptGravityMap,
  StructuralConsensus,
  DiscussionAnalysis,
} from "../../../src/types";
import "./StructuralAnalysisView.css";

interface Props {
  analysis: DiscussionAnalysis;
}

export function StructuralAnalysisView({ analysis }: Props) {
  const { semanticLoop, conceptGravity, structuralConsensus } = analysis;

  const hasAny = semanticLoop || conceptGravity || structuralConsensus;
  if (!hasAny) return null;

  return (
    <div className="sav-root">

      {/* 1. 구조 수렴 맵 */}
      {structuralConsensus && semanticLoop?.isPseudoDebate && (
        <SavSection title="구조 수렴 맵" accent="structure">
          <StructuralMapView sc={structuralConsensus} />
        </SavSection>
      )}

      {/* 2. 반복 프레임 감지 / Semantic Loop */}
      {semanticLoop && (semanticLoop.isPseudoDebate || semanticLoop.repeatedFrames.length > 0) && (
        <SavSection title="반복 프레임 감지" accent={semanticLoop.isPseudoDebate ? "loop" : undefined}>
          <SemanticLoopView loop={semanticLoop} />
        </SavSection>
      )}

      {/* 3. Concept Gravity */}
      {conceptGravity && conceptGravity.topConcepts.length > 0 && (
        <SavSection title="Concept Gravity — 토론 지배 개념" accent="gravity">
          <ConceptGravityView cg={conceptGravity} />
        </SavSection>
      )}

    </div>
  );
}

// ─── StructuralMapView ────────────────────────────────────────────

function StructuralMapView({ sc }: { sc: StructuralConsensus }) {
  return (
    <div className="sav-structural-map">
      {/* 표면 충돌 */}
      {sc.surfaceConflicts.length > 0 && (
        <div className="sav-surface-conflicts">
          {sc.surfaceConflicts.map((c, i) => (
            <div key={c.actor} className="sav-surface-actor">
              <span className={`sav-actor-chip actor-${c.actor}`}>{c.actor}</span>
              <div className="sav-surface-position">
                {c.surfacePosition.length > 80
                  ? c.surfacePosition.slice(0, 77) + "…"
                  : c.surfacePosition}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 구조 수렴 화살표 */}
      <div className="sav-structure-arrow">↓ 공통 구조</div>

      {/* 공유 구조 코어 */}
      <div className="sav-shared-structure">
        {sc.sharedStructure.map(k => (
          <span key={k} className="sav-structure-chip">{k}</span>
        ))}
      </div>

      {/* 구조적 설명 */}
      <div className="sav-structural-note">{sc.structuralNote}</div>

      {/* actor별 구조 기여 */}
      {sc.surfaceConflicts.some(c => c.sharedStructureContribution.length > 0) && (
        <div className="sav-contributions">
          {sc.surfaceConflicts.map(c => (
            c.sharedStructureContribution.length > 0 && (
              <div key={c.actor} className="sav-contribution-row">
                <span className={`sav-actor-chip actor-${c.actor}`}>{c.actor}</span>
                <div className="sav-contribution-chips">
                  {c.sharedStructureContribution.map(k => (
                    <span key={k} className="sav-contribution-chip">{k}</span>
                  ))}
                </div>
              </div>
            )
          ))}
        </div>
      )}
    </div>
  );
}

// ─── SemanticLoopView ─────────────────────────────────────────────

function SemanticLoopView({ loop }: { loop: SemanticLoopAnalysis }) {
  const driftPct = Math.round(loop.semanticDriftScore * 100);
  const driftClass = driftPct < 20 ? "sav-drift-low"
                   : driftPct < 40 ? "sav-drift-mid"
                                   : "sav-drift-high";

  return (
    <div className="sav-loop-root">
      {/* Pseudo-debate 배지 + drift 게이지 */}
      <div className="sav-loop-header">
        <span className={`sav-pseudo-badge ${loop.isPseudoDebate ? "sav-pseudo-active" : "sav-pseudo-inactive"}`}>
          {loop.isPseudoDebate ? "Semantic Loop 감지" : "부분 반복"}
        </span>
        <div className="sav-drift-row">
          <span className="sav-drift-label">의미 이동률</span>
          <div className="sav-drift-track">
            <div className={`sav-drift-fill ${driftClass}`} style={{ width: `${driftPct}%` }} />
          </div>
          <span className={`sav-drift-val ${driftClass}`}>{driftPct}%</span>
        </div>
      </div>

      {/* collapseReason */}
      {loop.collapseReason && (
        <div className="sav-collapse-reason">{loop.collapseReason}</div>
      )}

      {/* 루프 revision 범위 */}
      {loop.loopRevisionRange && (
        <div className="sav-loop-range">
          Semantic Loop 범위: revision #{loop.loopRevisionRange.from} → #{loop.loopRevisionRange.to}
        </div>
      )}

      {/* 공유 핵심 개념 */}
      {loop.sharedCoreConcepts.length > 0 && (
        <div className="sav-shared-core">
          <span className="sav-core-label">공유 핵심 개념</span>
          <div className="sav-core-chips">
            {loop.sharedCoreConcepts.map(k => (
              <span key={k} className="sav-core-chip">{k}</span>
            ))}
          </div>
        </div>
      )}

      {/* 반복 프레임 top 4 */}
      {loop.repeatedFrames.length > 0 && (
        <div className="sav-frames">
          <div className="sav-frames-label">반복된 의미 프레임</div>
          {loop.repeatedFrames.slice(0, 4).map(f => (
            <div key={f.concept} className="sav-frame-row">
              <span className="sav-frame-concept">{f.concept}</span>
              <div className="sav-frame-actors">
                {f.actors.filter(a => a !== "system" && a !== "user").map(a => (
                  <span key={a} className={`sav-actor-chip actor-${a}`}>{a}</span>
                ))}
              </div>
              <span className="sav-frame-count">{f.repeatCount}회</span>
              <span className="sav-frame-range">R{f.firstRound + 1}–R{f.lastRound + 1}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── ConceptGravityView ───────────────────────────────────────────

function ConceptGravityView({ cg }: { cg: ConceptGravityMap }) {
  const maxScore = cg.topConcepts[0]?.gravityScore ?? 1;

  return (
    <div className="sav-gravity-root">
      <div className="sav-gravity-note">{cg.gravityNote}</div>

      <div className="sav-gravity-list">
        {cg.topConcepts.map((entry, i) => {
          const barWidth = Math.round((entry.gravityScore / maxScore) * 100);
          return (
            <div key={entry.concept} className="sav-gravity-row">
              <span className="sav-gravity-rank">#{i + 1}</span>
              <div className="sav-gravity-concept-col">
                <div className="sav-gravity-concept-header">
                  <span className="sav-gravity-concept">{entry.concept}</span>
                  {entry.synthesisParticipation && (
                    <span className="sav-gravity-synth-badge">합성 포함</span>
                  )}
                </div>
                <div className="sav-gravity-bar-track">
                  <div className="sav-gravity-bar-fill" style={{ width: `${barWidth}%` }} />
                </div>
                <div className="sav-gravity-meta">
                  <span className={`sav-actor-chip actor-${entry.firstActor}`}>{entry.firstActor} 도입</span>
                  <span className="sav-gravity-stat">{entry.adoptersCount}명 사용</span>
                  <span className="sav-gravity-stat">{entry.survivedRounds}라운드</span>
                  {entry.concedeInfluence > 0 && (
                    <span className="sav-gravity-stat sav-gravity-concede">양보 {entry.concedeInfluence}회</span>
                  )}
                </div>
              </div>
              <span className="sav-gravity-score">{entry.gravityScore}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Section wrapper ──────────────────────────────────────────────

function SavSection({ title, accent, children }: {
  title:    string;
  accent?:  "structure" | "loop" | "gravity";
  children: React.ReactNode;
}) {
  return (
    <div className={`sav-section${accent ? ` sav-section-${accent}` : ""}`}>
      <div className="sav-section-title">{title}</div>
      <div className="sav-section-body">{children}</div>
    </div>
  );
}
