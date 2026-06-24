import type {
  CognitiveFramework,
  FrameworkType,
  PrincipleRole,
  RelationType,
  ReasoningPatternType,
} from "../../../src/types";
import { DISPLAY } from "../../../src/display-terms";
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
  foundation: DISPLAY.principle_role.foundation,
  driver:     DISPLAY.principle_role.driver,
  balancer:   DISPLAY.principle_role.balancer,
  emergent:   DISPLAY.principle_role.emergent,
  constraint: DISPLAY.principle_role.constraint,
};

const RELATION_LABEL: Record<RelationType, string> = {
  requires:   "필요로 함",
  limits:     "제약함",
  stabilizes: "안정시킴",
  amplifies:  "강화함",
  balances:   "균형 잡음",
};

const PATTERN_LABEL: Record<ReasoningPatternType, string> = {
  conflict_resolution:    DISPLAY.reasoning_pattern.conflict_resolution,
  system_balancing:       DISPLAY.reasoning_pattern.system_balancing,
  incremental_refinement: DISPLAY.reasoning_pattern.incremental_refinement,
  dialectical_synthesis:  DISPLAY.reasoning_pattern.dialectical_synthesis,
  recursive_adaptation:   DISPLAY.reasoning_pattern.recursive_adaptation,
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
        <span className="cfv-title">{DISPLAY.section.cognitive_framework}</span>
        <span className="cfv-type-badge">{FRAMEWORK_TYPE_LABEL[frameworkType]}</span>
        <span className="cfv-framework-name">{frameworkName}</span>
      </div>

      {/* 섹션 설명 */}
      <div className="cfv-section-desc">{DISPLAY.desc.cognitive_framework}</div>

      {/* Generated Perspective — 가장 중요 */}
      <div className="cfv-perspective">{generatedPerspective}</div>

      <div className="cfv-blocks">

        {/* 핵심 개념 */}
        {hasPrinciples && (
          <div className="cfv-block cfv-block-principles">
            <div className="cfv-block-header">
              <span className="cfv-block-icon">🧱</span>
              <span className="cfv-block-title">{DISPLAY.block.core_principles}</span>
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

        {/* 개념 간 연결 */}
        {hasRelations && (
          <div className="cfv-block cfv-block-relations">
            <div className="cfv-block-header">
              <span className="cfv-block-icon">🔗</span>
              <span className="cfv-block-title">{DISPLAY.block.structural_relations}</span>
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

        {/* 토론이 진행된 방식 */}
        <div className="cfv-block cfv-block-pattern">
          <div className="cfv-block-header">
            <span className="cfv-block-icon">🧠</span>
            <span className="cfv-block-title">{DISPLAY.block.reasoning_pattern}</span>
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
