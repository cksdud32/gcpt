# GCPT 코드 리뷰: 수정 필요 사항

작성일: 2026-06-25

최근 수정 반영일: 2026-06-25

## 요약

현재 GCPT에서 가장 큰 남은 혼동 지점은 provider/API fallback 경계입니다. 데모 표시, 안전 한도 resume 동작, 자동/수동 수렴 라벨 구분은 보강했지만, API 키가 빠진 provider의 mock worker fallback 등은 아직 별도 수정이 필요합니다.

빌드와 테스트는 통과했지만, 아래 항목들은 제품 동작상 혼동 또는 디버깅 위험을 만들 수 있어 수정이 필요합니다.

검증 결과:

- `npm run build` 통과
- `npm run app:build` 통과
- `npm test` 통과

## 완료된 수정

### 완료: 데모/목업 결과 UI 표시 개선

범위:

- core discussion engine 변경 없음
- provider/API 로직 변경 없음
- 저장 포맷 변경 없음
- UI/UX 표시 로직만 보강

반영 내용:

- [x] 데모/목업 결과 판정에서 `accumulated` 결과를 무조건 데모로 취급하던 오탐 가능성을 줄였습니다.
- [x] 데모 판정을 명시적인 mock/custom mode 또는 테스트용 placeholder 값 감지 기준으로 변경했습니다.
- [x] `Option-A`, `Option-B`, `Option-C`, `Alt-X`, `Alt-Y`, `Alt-Z`가 감지되면 데모/테스트용 선택지 경고가 유지됩니다.
- [x] `DiscussionPanel`의 memo dependency에 `isLiveSession`을 추가해 live/mock 상태 전환 표시가 stale하게 남을 가능성을 줄였습니다.

관련 커밋:

- `a6c4d80 fix: clarify demo result UI state`

### 완료: 안전 한도 토글 resume/interjection 반영

문제:

안전 한도 체크를 해제해도, 이미 멈춘 live 토론을 추가 의견으로 재개하면 기존 budget이 재사용되어 `safetyLimitEnabled=true`가 계속 남을 수 있었습니다. 이 때문에 체크박스가 꺼져 있어도 “안전 한도에 도달했습니다”가 다시 표시될 수 있었습니다.

반영 내용:

- [x] renderer의 추가 의견 전송 payload에 현재 `safetyLimitEnabled` 값을 포함했습니다.
- [x] `discussion:interject` IPC가 `{ message, safetyLimitEnabled }` payload를 받도록 변경했습니다.
- [x] `LiveOrchestrator.interject()` / resume 경로에서 현재 safety limit 값을 받아 base/effective budget을 갱신하도록 수정했습니다.
- [x] safety limit OFF 시 resumed segment에서도 `maxRoundsPerWorker`가 `unlimited`로 적용되도록 evaluator와 worker budget을 갱신했습니다.
- [x] fresh live run, interjection, resume effective budget 로그를 추가했습니다.

변경 파일:

- `app/renderer/src/App.tsx`
- `app/preload/index.ts`
- `app/main/index.ts`
- `src/live-orchestrator.ts`
- `src/orchestrator.ts`
- `src/workers/gpt.ts`
- `src/workers/claude.ts`
- `src/workers/gemini.ts`

검증:

- `npm run build` 통과
- `npm test` 통과

관련 커밋:

- `8bf6026 fix: apply safety limit toggle to resumed discussions`

### 완료: 자동 수렴/수동 채택/분석 신뢰도 라벨 분리

문제:

자동 수렴, 수동 채택, 직접 선택이 모두 `consensus_reached`로 표시되어 UI에서 구분하기 어려웠습니다. 또한 `안정 수렴 87%`처럼 보이는 값은 실제 evaluator confidence가 아니라 `analyzeDiscussion` / `finalResolution`에서 계산된 분석 신뢰도였기 때문에, 사용자가 실제 자동 수렴 confidence로 오해할 수 있었습니다.

반영 내용:

- [x] `ConsensusReachedPayload`에 optional metadata를 추가했습니다.
  - `convergenceSource?: "auto_evaluator" | "manual_policy" | "manual_select"`
  - `confidenceKind?: "analysis" | "evaluator"`
  - `isMockAffected?: boolean`
- [x] `LiveOrchestrator`가 자동 수렴, 수동 최고점 채택, 직접 선택마다 `convergenceSource`를 기록하도록 했습니다.
- [x] `RevisionStore`가 optional convergence metadata를 `selectedOption`에 보존하도록 했습니다.
- [x] 기존 저장 세션은 metadata가 없어도 `rationale` 문자열을 fallback으로 사용해 자동/수동/직접 선택을 구분합니다.
- [x] UI에서 `자동 수렴`, `수동 채택`, `직접 선택` 라벨을 분리했습니다.
- [x] 결과 카드의 퍼센트 표기를 `분석 신뢰도 XX%`로 바꿔 실제 auto-convergence confidence와 구분했습니다.
- [x] AI 토론 패널에도 데모 배지를 표시해 mock/demo consensus가 live real consensus처럼 보이지 않도록 했습니다.

변경 파일:

- `src/types.ts`
- `src/live-orchestrator.ts`
- `src/RevisionStore.ts`
- `app/renderer/src/App.tsx`

검증:

- `npm run build` 통과
- `npm test` 통과

관련 커밋:

- `167bfb0 fix: clarify convergence result sources`

## 남은 수정 필요 항목

## 1. API 키가 없어도 live 실행이 mock worker로 진행될 수 있음

위험도: 높음

분류:

- mock/fallback leakage
- logic bug
- UI confusion

근거:

- `app/main/index.ts:341` 근처에서 enabled provider 수만 확인합니다.
- `src/live-orchestrator.ts:491` 근처에서 GPT API 키가 없으면 mock worker를 생성합니다.
- `src/live-orchestrator.ts:504` 근처에서 Claude API 키가 없으면 mock worker를 생성합니다.

문제:

사용자는 실시간 실행이라고 생각하지만, 실제로는 API 키가 없는 provider가 mock 응답을 생성할 수 있습니다. 이 경우 결과 화면에 테스트용 선택지나 테스트용 이유가 섞여도 정상적인 live 결과처럼 보일 수 있습니다.

권장 수정 방향:

- live 실행 전 enabled provider의 API 키 유효성을 명시적으로 검증합니다.
- API 키가 없는 provider는 실행에서 제외하거나, 실행 전에 사용자에게 경고합니다.
- mock worker가 섞인 live 결과에는 명확한 배지를 표시합니다.

## 2. 누적 세션 결과가 데모로 오탐지될 수 있음

상태: 완료

위험도: 중간

분류:

- UI confusion
- logic bug

근거:

- `app/renderer/src/App.tsx:358` 근처에서 여러 결과를 병합할 때 `mode: "accumulated"`가 설정됩니다.
- `app/renderer/src/App.tsx:601` 근처에서 `result.mode !== "live"` 조건으로 데모 여부를 판단합니다.

문제:

실제 live 결과들이 누적되어 `accumulated` 모드가 된 경우에도 데모처럼 표시될 수 있습니다. 이 문제는 실제 AI 응답에 “데모 모드” 배지가 붙는 잘못된 사용자 경험을 만들 수 있습니다.

완료된 수정:

- [x] 데모 여부 판단을 `mode !== "live"`가 아니라 명시적인 mock/custom mode 또는 placeholder 감지 기준으로 분리했습니다.
- [x] `accumulated` 결과는 그 자체만으로 데모로 취급하지 않도록 변경했습니다.

## 3. live mode off 실행은 여전히 mock/demo 토론 엔진을 사용함

위험도: 중간

분류:

- harmless UI confusion
- mock/fallback leakage

근거:

- `app/renderer/src/App.tsx:896` 근처에서 live mode가 꺼져 있으면 `window.gcpt.runCustom` 경로를 사용합니다.
- `app/renderer/src/App.tsx:914` 근처에서 non-live 결과를 `setResults`로 표시합니다.
- `app/main/index.ts:174` 근처에서 `runCustomDiscussion`이 호출됩니다.
- `src/test-modes.ts:123` 근처에서 custom 토론 실행이 mock/demo 기반 pipeline으로 연결됩니다.

문제:

이 동작 자체는 의도된 데모 모드일 수 있지만, 사용자에게 충분히 명확하게 표시되지 않으면 실제 AI 판단으로 오해될 수 있습니다.

완료된 수정:

- [x] live mode off 상태에서 “실시간 모드가 꺼져 있어 데모 응답으로 실행됩니다.” 안내를 표시합니다.
- [x] 결과 영역, 분석 보기, 변경 기록에 데모 배지를 표시합니다.
- [x] placeholder-only 결과가 감지되면 별도 경고를 표시합니다.

## 4. Claude parse fail 로그가 원문 응답을 그대로 출력함

위험도: 중간

분류:

- debugging risk
- privacy/logging risk

근거:

- `src/workers/claude.ts:203` 근처에서 parse fail 시 raw response를 로그로 출력합니다.

문제:

모델 응답에 사용자 입력, 민감한 내용, 긴 텍스트가 포함될 수 있는데 parse 실패 시 로그에 그대로 남을 수 있습니다. 개발 중에는 유용하지만, 일반 실행 로그로는 과합니다.

권장 수정 방향:

- raw response 전체 출력 대신 길이 제한, 일부 마스킹, debug flag 조건부 출력으로 바꿉니다.
- GPT/Gemini worker의 parse fail 로그 정책과 일관되게 맞춥니다.

## 5. `DiscussionPanel`의 `useMemo` dependency가 누락됨

상태: 완료

위험도: 낮음~중간

분류:

- UI stale state risk

근거:

- `app/renderer/src/App.tsx:2671` 근처 `useMemo` 내부에서 `isLiveSession`을 사용합니다.
- 같은 `useMemo` dependency 배열에 `isLiveSession`이 빠져 있습니다.

문제:

React memoized value가 최신 live/mock 상태를 반영하지 못할 가능성이 있습니다. 즉시 치명적인 오류가 아닐 수 있지만 상태 전환 UI에서 stale display가 생길 수 있습니다.

완료된 수정:

- [x] dependency 배열에 `isLiveSession`을 추가했습니다.

## 6. 워크스페이스 chat/plan 기능도 mock fallback을 사용함

위험도: 중간

분류:

- UI confusion
- mock/fallback leakage

근거:

- `app/main/index.ts:489` 근처 workspace chat fallback
- `app/main/index.ts:517` 근처 workspace plan fallback

문제:

워크스페이스 기능에서도 provider/API 상태가 충분하지 않으면 mock fallback이 사용될 수 있습니다. 사용자는 워크스페이스 응답을 실제 AI 응답으로 오해할 수 있습니다.

권장 수정 방향:

- 워크스페이스 응답에도 mock/demo 여부를 표시합니다.
- provider/API 키가 없을 때 fallback 대신 명확한 설정 안내를 보여주는 방식을 검토합니다.

## 7. 한국어 open-ended prompt 처리 구분이 약함

위험도: 중간

분류:

- logic bug
- UX issue

문제:

현재 pipeline은 사용자의 입력이 명시적인 A/B 선택인지, 열린 추천 질문인지, 가벼운 한국어 잡담인지 강하게 구분하지 않는 것으로 보입니다. 그 결과 “무엇을 할지 골라줘” 같은 질문도 구조화된 선택지 토론처럼 처리될 수 있습니다.

관련 증상:

- `Option-A`
- `Option-B`
- `Alt-X`
- `Alt-Y`
- `stable convergence 87%`

권장 수정 방향:

- 입력 전처리 단계에서 explicit choice prompt와 open-ended recommendation prompt를 구분합니다.
- 선택지가 없는 경우에는 먼저 선택지 생성 단계임을 UI에 표시하거나, 사용자에게 후보를 입력하도록 요청합니다.
- mock/demo 결과는 실제 판단 결과와 별도 시각 언어로 분리합니다.

## 우선순위 제안

1. live 실행에서 API 키 없는 provider가 mock worker로 섞이는 문제를 먼저 수정합니다.
2. workspace chat/plan fallback에도 demo 표시를 추가합니다.
3. parse fail raw logging을 줄입니다.
4. open-ended Korean prompt 처리를 별도 UX 흐름으로 분리합니다.

## 수정 시 주의사항

- discussion engine을 한 번에 재작성하지 않는 것이 안전합니다.
- 먼저 사용자 혼동을 줄이는 UI 라벨링과 provider 검증을 적용합니다.
- 그다음 prompt classification과 option generation 흐름을 단계적으로 개선합니다.
- 저장 포맷 변경은 피하고, 필요한 경우 migration 계획을 먼저 세워야 합니다.
