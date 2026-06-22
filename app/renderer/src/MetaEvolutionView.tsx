import type { MetaEvolutionAnalysis } from "../../../src/types";
import "./MetaEvolutionView.css";

const SHIFT_TYPE_LABEL: Record<MetaEvolutionAnalysis["topicShiftType"], string> = {
  refinement:   "정교화",
  pivot:        "논점 전환",
  expansion:    "범위 확장",
  contradiction:"방향 역전",
  synthesis:    "관점 통합",
};

const SHIFT_TYPE_CLASS: Record<MetaEvolutionAnalysis["topicShiftType"], string> = {
  refinement:   "mev-shift-refinement",
  pivot:        "mev-shift-pivot",
  expansion:    "mev-shift-expansion",
  contradiction:"mev-shift-contradiction",
  synthesis:    "mev-shift-synthesis",
};

const IMPACT_LABEL: Record<string, string> = {
  topic_redirect:      "논점 전환",
  constraint_addition: "제약 추가",
  scope_expansion:     "범위 확장",
  perspective_shift:   "관점 이동",
};

const IMPACT_CLASS: Record<string, string> = {
  topic_redirect:      "mev-impact-redirect",
  constraint_addition: "mev-impact-constraint",
  scope_expansion:     "mev-impact-expansion",
  perspective_shift:   "mev-impact-shift",
};

interface Props {
  meta: MetaEvolutionAnalysis;
}

export function MetaEvolutionView({ meta }: Props) {
  const {
    evolutionStages,
    topicShiftType,
    dominantEvolutionPath,
    conceptTransitions,
    interjectionImpacts,
    metaSummary,
    finalMetaConclusion,
  } = meta;

  if (evolutionStages.length === 0) return null;

  return (
    <div className="mev-root">

      {/* 메타 결론 헤더 */}
      <div className="mev-meta-conclusion">
        <div className="mev-meta-conclusion-header">
          <span className={`mev-shift-badge ${SHIFT_TYPE_CLASS[topicShiftType]}`}>
            {SHIFT_TYPE_LABEL[topicShiftType]}
          </span>
          <span className="mev-meta-summary">{metaSummary}</span>
        </div>
        <div className="mev-meta-conclusion-text">{finalMetaConclusion}</div>
      </div>

      {/* 1. 논점 진화 타임라인 */}
      <MevSection title="논점 진화 타임라인">
        <div className="mev-timeline">
          {evolutionStages.map((stage, idx) => (
            <div key={stage.segmentId} className="mev-timeline-item">
              <div className="mev-timeline-node">
                <div className="mev-timeline-node-label">Segment {stage.segmentId}</div>
                {stage.convergenceType && (
                  <div className="mev-timeline-node-type">{stage.convergenceType}</div>
                )}
                <div className="mev-timeline-node-conclusion">
                  {stage.dominantConclusion
                    ? (stage.dominantConclusion.length > 90
                        ? stage.dominantConclusion.slice(0, 87) + "…"
                        : stage.dominantConclusion)
                    : "(결론 없음)"}
                </div>
                {stage.dominantKeywords.length > 0 && (
                  <div className="mev-timeline-node-kwds">
                    {stage.dominantKeywords.slice(0, 5).map(k => (
                      <span key={k} className="mev-kwd-chip">{k}</span>
                    ))}
                  </div>
                )}
                {stage.entropy !== undefined && (
                  <div className="mev-timeline-node-entropy">
                    <span className="mev-entropy-label">Entropy</span>
                    <div className="mev-entropy-bar-track">
                      <div
                        className={`mev-entropy-bar-fill ${stage.entropy < 0.35 ? "mev-ent-low" : stage.entropy < 0.65 ? "mev-ent-mid" : "mev-ent-high"}`}
                        style={{ width: `${Math.min(100, Math.round(stage.entropy * 100))}%` }}
                      />
                    </div>
                    <span className="mev-entropy-val">{Math.round(stage.entropy * 100)}%</span>
                  </div>
                )}
              </div>

              {/* 전환 화살표 + shift score */}
              {idx < evolutionStages.length - 1 && (() => {
                const trans = conceptTransitions.find(
                  t => t.fromSegment === stage.segmentId,
                );
                if (!trans) return <div className="mev-timeline-arrow">↓</div>;
                const score = trans.semanticShiftScore;
                const cls = score < 0.25 ? "mev-arrow-low"
                          : score < 0.5  ? "mev-arrow-mid"
                                         : "mev-arrow-high";
                return (
                  <div className={`mev-timeline-arrow ${cls}`}>
                    ↓
                    <span className="mev-timeline-shift-score">
                      의미 이동 {Math.round(score * 100)}%
                    </span>
                  </div>
                );
              })()}
            </div>
          ))}
        </div>
      </MevSection>

      {/* 2. 개념 이동 분석 */}
      {conceptTransitions.length > 0 && (
        <MevSection title="개념 이동 분석">
          {conceptTransitions.map(t => (
            <div key={`${t.fromSegment}-${t.toSegment}`} className="mev-concept-transition">
              <div className="mev-concept-transition-header">
                <span className="mev-seg-label">Seg {t.fromSegment}</span>
                <span className="mev-transition-arrow">→</span>
                <span className="mev-seg-label">Seg {t.toSegment}</span>
                <span className={`mev-shift-score ${t.semanticShiftScore > 0.5 ? "mev-shift-high" : t.semanticShiftScore > 0.25 ? "mev-shift-mid" : "mev-shift-low"}`}>
                  이동 {Math.round(t.semanticShiftScore * 100)}%
                </span>
              </div>
              <div className="mev-concept-groups">
                {t.persistedConcepts.length > 0 && (
                  <div className="mev-concept-group">
                    <span className="mev-concept-group-label mev-persisted-label">유지</span>
                    <div className="mev-concept-chips">
                      {t.persistedConcepts.map(k => (
                        <span key={k} className="mev-kwd-chip mev-kwd-persisted">{k}</span>
                      ))}
                    </div>
                  </div>
                )}
                {t.introducedConcepts.length > 0 && (
                  <div className="mev-concept-group">
                    <span className="mev-concept-group-label mev-introduced-label">신규</span>
                    <div className="mev-concept-chips">
                      {t.introducedConcepts.map(k => (
                        <span key={k} className="mev-kwd-chip mev-kwd-introduced">{k}</span>
                      ))}
                    </div>
                  </div>
                )}
                {t.abandonedConcepts.length > 0 && (
                  <div className="mev-concept-group">
                    <span className="mev-concept-group-label mev-abandoned-label">소멸</span>
                    <div className="mev-concept-chips">
                      {t.abandonedConcepts.map(k => (
                        <span key={k} className="mev-kwd-chip mev-kwd-abandoned">{k}</span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
        </MevSection>
      )}

      {/* 3. 사용자 개입 영향 */}
      {interjectionImpacts.length > 0 && (
        <MevSection title="사용자 개입 영향">
          {interjectionImpacts.map(imp => (
            <div key={imp.segmentId} className="mev-interjection-impact">
              <div className="mev-interjection-impact-header">
                <span className="mev-seg-label">Seg {imp.segmentId}</span>
                <span className={`mev-impact-badge ${IMPACT_CLASS[imp.impactType]}`}>
                  {IMPACT_LABEL[imp.impactType]}
                </span>
              </div>
              <div className="mev-interjection-text">"{imp.interjection}"</div>
              <div className="mev-interjection-summary">{imp.reasoningImpactSummary}</div>
              {imp.changedConcepts.length > 0 && (
                <div className="mev-interjection-kwds">
                  {imp.changedConcepts.map(k => (
                    <span key={k} className="mev-kwd-chip mev-kwd-introduced">{k}</span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </MevSection>
      )}

      {/* 4. 논점 변화 경로 (2개 이상 세그먼트) */}
      {dominantEvolutionPath.length >= 2 && (
        <MevSection title="논점 변화 경로">
          <div className="mev-evolution-path">
            {dominantEvolutionPath.map((text, i) => (
              <div key={i} className="mev-path-item">
                {i > 0 && <div className="mev-path-arrow">↓</div>}
                <div className="mev-path-node">
                  <span className="mev-path-seg">Seg {i + 1}</span>
                  <span className="mev-path-text">
                    {text.length > 100 ? text.slice(0, 97) + "…" : text}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </MevSection>
      )}

    </div>
  );
}

function MevSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mev-section">
      <div className="mev-section-title">{title}</div>
      <div className="mev-section-body">{children}</div>
    </div>
  );
}
