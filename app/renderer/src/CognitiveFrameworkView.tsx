import type {
  CognitiveFramework,
  FrameworkType,
  PrincipleRole,
  RelationType,
  ReasoningPatternType,
} from "../../../src/types";
import "./CognitiveFrameworkView.css";

const FRAMEWORK_TYPE_LABEL: Record<FrameworkType, string> = {
  governance_model:   "거버넌스 모델",
  ethical_model:      "윤리 프레임",
  systemic_model:     "시스템 모델",
  adaptive_model:     "적응형 모델",
  dialectical_model:  "변증법적 프레임",
  hybrid_framework:   "복합 프레임",
};

const ROLE_LABEL: Record<PrincipleRole, string> = {
  foundation: "기반",
  driver:     "추진",
  balancer:   "균형",
  emergent:   "창발",
  constraint: "제약",
};

const RELATION_LABEL: Record<RelationType, string> = {
  requires:   "requires",
  limits:     "limits",
  stabilizes: "stabilizes",
  amplifies:  "amplifies",
  balances:   "balances",
};

const PATTERN_LABEL: Record<ReasoningPatternType, string> = {
  conflict_resolution:    "대립 해소",
  system_balancing:       "시스템 균형",
  incremental_refinement: "점진적 정교화",
  dialectical_synthesis:  "변증법적 합성",
  recursive_adaptation:   "반복 적응",
};

interface Props {
  cf: CognitiveFramework;
}

export function CognitiveFrameworkView({ cf }: Props) {
  const {
    frameworkType,
    frameworkName,
    corePrinciples,
    structuralRelationships,
    reasoningPattern,
    dominantWorldview,
    generatedPerspective,
  } = cf;

  const hasRelations = structuralRelationships.length > 0;
  const hasPrinciples = corePrinciples.length > 0;

  return (
    <div className="cfv-root">

      {/* 헤더 */}
      <div className="cfv-header">
        <span className="cfv-title">생성된 사고 프레임</span>
        <span className="cfv-type-badge">{FRAMEWORK_TYPE_LABEL[frameworkType]}</span>
        <span className="cfv-framework-name">{frameworkName}</span>
      </div>

      {/* Generated Perspective — 가장 중요 */}
      <div className="cfv-perspective">{generatedPerspective}</div>

      <div className="cfv-blocks">

        {/* 핵심 원리 */}
        {hasPrinciples && (
          <div className="cfv-block cfv-block-principles">
            <div className="cfv-block-header">
              <span className="cfv-block-icon">🧱</span>
              <span className="cfv-block-title">핵심 원리</span>
            </div>
            <div className="cfv-block-body">
              <div className="cfv-principles">
                {corePrinciples.map(p => (
                  <div key={p.concept} className="cfv-principle-row">
                    <span className="cfv-principle-concept">{p.concept}</span>
                    <span className={`cfv-principle-role role-${p.role}`}>
                      {ROLE_LABEL[p.role]}
                    </span>
                    <div className="cfv-principle-influence">
                      <div
                        className="cfv-principle-influence-fill"
                        style={{ width: `${Math.round(p.influence * 100)}%` }}
                      />
                    </div>
                    {p.supportedByActors.length > 0 && (
                      <div className="cfv-principle-actors">
                        {p.supportedByActors.slice(0, 2).map(a => (
                          <span key={a} className={`cfv-actor-chip actor-${a}`}>{a}</span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* 개념 관계 */}
        {hasRelations && (
          <div className="cfv-block cfv-block-relations">
            <div className="cfv-block-header">
              <span className="cfv-block-icon">🔗</span>
              <span className="cfv-block-title">개념 관계</span>
            </div>
            <div className="cfv-block-body">
              <div className="cfv-relations">
                {structuralRelationships.map((r, i) => (
                  <div key={i} className="cfv-relation-row">
                    <span className="cfv-rel-from">{r.from}</span>
                    <div className="cfv-rel-arrow">
                      <span className="cfv-rel-arrow-icon">→</span>
                      <span className={`cfv-rel-type rel-${r.relation}`}>
                        {RELATION_LABEL[r.relation]}
                      </span>
                      <span className="cfv-rel-arrow-icon">→</span>
                    </div>
                    <span className="cfv-rel-to">{r.to}</span>
                    <span className="cfv-rel-conf">{Math.round(r.confidence * 100)}%</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Reasoning Pattern */}
        <div className="cfv-block cfv-block-pattern">
          <div className="cfv-block-header">
            <span className="cfv-block-icon">🧠</span>
            <span className="cfv-block-title">Reasoning Pattern</span>
          </div>
          <div className="cfv-block-body">
            <div className="cfv-pattern-row">
              <span className="cfv-pattern-badge">
                {PATTERN_LABEL[reasoningPattern.type]}
              </span>
              <span className="cfv-pattern-desc">{reasoningPattern.description}</span>
            </div>
          </div>
        </div>

      </div>

      {/* Dominant Worldview */}
      <div className="cfv-worldview">{dominantWorldview}</div>

    </div>
  );
}
