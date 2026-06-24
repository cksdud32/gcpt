import type { FinalResolution, ResolutionType } from "../../../src/types";
import { DISPLAY } from "../../../src/display-terms";
import "./FinalResolutionView.css";

const TYPE_BADGE_CLASS: Record<ResolutionType, string> = {
  stable_answer:              "frv-type-stable",
  synthesized_resolution:     "frv-type-synthesized",
  transformed_resolution:     "frv-type-transformed",
  unresolved_dynamic_tension: "frv-type-tension",
};

const TYPE_LABEL: Record<ResolutionType, string> = {
  stable_answer:              "처음 질문 그대로 합의",
  synthesized_resolution:     "여러 의견이 하나로 합쳐짐",
  transformed_resolution:     "질문 자체가 진화해 결론 도달",
  unresolved_dynamic_tension: "끝까지 의견 차이가 남음",
};

interface Props {
  fr: FinalResolution;
}

export function FinalResolutionView({ fr }: Props) {
  const {
    resolutionType,
    primaryConclusion,
    emergentQuestion,
    structuralConsensusCore,
    evolutionaryTrajectory,
    unresolvedTensions,
    confidence,
  } = fr;

  const hasEmergent   = !!emergentQuestion && emergentQuestion.length > 5;
  const hasStructural = structuralConsensusCore && structuralConsensusCore.length > 0;
  const hasTraj       = evolutionaryTrajectory.length >= 2;
  const hasTensions   = unresolvedTensions.length > 0;

  return (
    <div className="frv-root">

      {/* 헤더 */}
      <div className="frv-header">
        <span className="frv-title">{DISPLAY.section.final_resolution}</span>
        <span className={`frv-type-badge ${TYPE_BADGE_CLASS[resolutionType]}`}>
          {TYPE_LABEL[resolutionType]}
        </span>
        <span className="frv-conf">
          신뢰도 <span className="frv-conf-val">{Math.round(confidence * 100)}%</span>
        </span>
      </div>

      {/* 섹션 설명 */}
      <div className="frv-section-desc">{DISPLAY.desc.final_resolution}</div>

      {/* Primary Conclusion */}
      <div className="frv-primary">{primaryConclusion}</div>

      {/* 4 Blocks */}
      {(hasEmergent || hasStructural || hasTraj || hasTensions) && (
        <div className="frv-blocks">

          {/* 1. 토론 중 새롭게 떠오른 질문 */}
          {hasEmergent && (
            <div className="frv-block frv-block-emergent">
              <div className="frv-block-header">
                <span className="frv-block-icon">❓</span>
                <span className="frv-block-title">{DISPLAY.block.emergent_question}</span>
              </div>
              <div className="frv-block-body">
                <div className="frv-block-desc">{DISPLAY.desc.emergent_question}</div>
                <div className="frv-emergent-q">{emergentQuestion}</div>
              </div>
            </div>
          )}

          {/* 2. AI들이 공통으로 공유한 생각 */}
          {hasStructural && (
            <div className="frv-block frv-block-structural">
              <div className="frv-block-header">
                <span className="frv-block-icon">🔗</span>
                <span className="frv-block-title">{DISPLAY.block.shared_structure}</span>
              </div>
              <div className="frv-block-body">
                <div className="frv-struct-chips">
                  {structuralConsensusCore!.map(k => (
                    <span key={k} className="frv-struct-chip">{k}</span>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* 3. 생각이 변해온 흐름 */}
          {hasTraj && (
            <div className="frv-block frv-block-traj">
              <div className="frv-block-header">
                <span className="frv-block-icon">📈</span>
                <span className="frv-block-title">{DISPLAY.block.evolution_trajectory}</span>
              </div>
              <div className="frv-block-body">
                <div className="frv-traj">
                  {evolutionaryTrajectory.map((s, idx) => {
                    const isFinal = idx === evolutionaryTrajectory.length - 1;
                    return (
                      <div key={s.stage} className={`frv-traj-stage${isFinal ? " frv-traj-final" : ""}`}>
                        <div className="frv-traj-row">
                          <span className="frv-traj-num">{s.stage}</span>
                          <div className="frv-traj-content">
                            <div className="frv-traj-axis">{s.axis}</div>
                            {s.dominant && s.dominant !== "수렴 완료" && (
                              <div className="frv-traj-dominant">{s.dominant}</div>
                            )}
                          </div>
                        </div>
                        {s.keyShift && !isFinal && (
                          <div className="frv-traj-shift-row">
                            <span className="frv-traj-arrow">↓</span>
                            <span className="frv-traj-shift">{s.keyShift}</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* 4. 끝까지 남은 의견 차이 */}
          {hasTensions && (
            <div className="frv-block frv-block-tension">
              <div className="frv-block-header">
                <span className="frv-block-icon">⚡</span>
                <span className="frv-block-title">{DISPLAY.block.unresolved_tensions}</span>
              </div>
              <div className="frv-block-body">
                <div className="frv-block-desc">{DISPLAY.desc.unresolved_tensions}</div>
                <div className="frv-tensions">
                  {unresolvedTensions.map((t, i) => (
                    <div key={i} className="frv-tension-row">
                      <div className="frv-tension-axis">{t.axis}</div>
                      <div className="frv-tension-sides">
                        <span className="frv-tension-side">{t.sideA}</span>
                        <span className="frv-tension-vs">vs</span>
                        <span className="frv-tension-side">{t.sideB}</span>
                      </div>
                      <div className="frv-tension-why">{t.whyUnresolved}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

        </div>
      )}
    </div>
  );
}
