# gcpt

**여러 AI가 서로 토론하며 결론을 도출하는 실험적 AI 협업 엔진**

> gcpt is an experimental multi-AI collaboration engine where AI agents (GPT, Gemini, Claude) debate, revise, and converge on decisions through a live revision timeline.

---

> ⚠️ **Alpha Demo / Experimental Build**
> 이 프로젝트는 개인 실험 목적으로 개발 중입니다. API 없이도 Mock mode로 전체 기능을 체험할 수 있습니다.

---

## 개요

gcpt는 Electron 기반 데스크탑 앱입니다.  
사용자가 결정해야 할 주제(Goal)를 입력하면, GPT와 Gemini가 서로 제안·반박하고, 자동으로 합의(consensus)에 도달하는 과정을 실시간으로 시각화합니다.

**핵심 개념:**
- **Revision** — 모든 AI 발언이 개정(revision) 단위로 기록됩니다
- **Topic** — 하나의 결정 주제를 의미합니다
- **Consensus** — AI들이 합의에 도달한 상태를 나타냅니다
- **Interjection** — 토론 중간에 사용자가 의견을 삽입하면 토론이 재개됩니다

---

## 주요 기능

### Revision Engine (Mock Mode)
- 다양한 시나리오(normal / parsefail / apierror / delay / mixed / stress)로 AI 토론을 시뮬레이션
- API 키 없이 즉시 실행 가능
- Topic 별 합의 결과, Revision Timeline, Metrics 확인

### Live Discussion (API Mode)
- GPT와 Gemini가 실제 API를 통해 실시간 토론
- 사용자가 토론 도중 interjection(의견 삽입) 가능
- 합의 후에도 추가 토론 재개 가능 (continuation session)
- 토론 모드: 일반 / 개발 / 아이디어

### Workspace Editor
- 로컬 파일을 불러와 Mock AI 수정 제안 확인
- Diff 뷰어로 원본/제안 비교
- 편집 이력(Edit Log) 관리

### Session 저장/불러오기
- 토론 결과를 JSON으로 저장하고 나중에 불러올 수 있습니다

---

## 기술 스택

| 분류 | 기술 |
|------|------|
| 런타임 | Electron 28 + Node.js |
| 프레임워크 | electron-vite 5 |
| UI | React 19 + TypeScript |
| AI | OpenAI GPT-4o-mini, Google Gemini 2.5-flash |
| 상태 관리 | React useState (no external lib) |
| 빌드 | Vite 7, TypeScript 6 |

---

## 실행 방법

### 요구 사항
- Node.js 18+
- npm 9+

### 설치

```bash
git clone https://github.com/cksdud32/gcpt.git
cd gcpt
npm install
```

### API 키 설정

```bash
cp .env.example .env
# .env 파일을 열어 API 키를 입력하세요
```

API 키 없이도 Mock mode로 모든 기능을 체험할 수 있습니다.

### 개발 모드 실행

```bash
npm run app
```

### 프로덕션 빌드

```bash
npm run app:build
```

---

## API 키 설정 방법

`.env` 파일을 생성하고 아래와 같이 설정합니다:

```env
OPENAI_API_KEY=sk-...         # GPT 실제 응답에 필요
GEMINI_API_KEY=               # Gemini 실제 응답에 필요 (없으면 Mock 사용)
ANTHROPIC_API_KEY=            # 현재 미사용 (향후 확장용)
```

**API 키가 없는 경우**: Mock worker가 자동으로 사용되며, 실제 API 호출 없이 시뮬레이션 응답이 생성됩니다.

---

## 사용 가이드

### Mock Mode (API 키 불필요)

1. 앱 실행 후 좌측 사이드바에서 모드 선택 (normal, delay, stress 등)
2. `▶ 실행` 클릭
3. Topic View에서 합의 결과, Timeline에서 Revision 흐름 확인

### Live Discussion Mode (API 키 필요)

1. `⚡ Live OFF` 버튼을 클릭해 `⚡ Live ON` 으로 전환
2. 토론 모드 선택 (일반 / 개발 / 아이디어)
3. `▶ 실행` 또는 직접 입력란에 주제 입력 후 실행
4. AI Discussion 패널에서 실시간 토론 확인
5. 합의 후 추가 의견 입력 → 토론 재개 가능

### Workspace Editor

1. 상단 `Workspace Editor` 탭 클릭
2. `Open Workspace`로 폴더 선택
3. 파일 선택 → `Mock Edit Proposal`로 수정 제안 생성
4. Diff 확인 후 `Apply`로 실제 파일에 적용

---

## 프로젝트 구조

```
gcpt/
├── app/
│   ├── main/       # Electron main process (IPC 핸들러)
│   ├── preload/    # contextBridge API 노출
│   └── renderer/   # React UI
├── src/
│   ├── orchestrator.ts       # Mock 워커 (GPT/Claude/User)
│   ├── live-orchestrator.ts  # Live 토론 엔진
│   ├── RevisionStore.ts      # Revision 저장소
│   ├── policy.ts             # 합의 정책
│   ├── metrics.ts            # 성능 메트릭
│   └── workers/
│       ├── gpt.ts            # Real GPT 워커
│       ├── gemini.ts         # Real Gemini 워커
│       └── mode-instruction.ts
└── .env.example
```

---

## 현재 상태 (Alpha Demo)

- [x] Mock mode 다중 시나리오
- [x] Live Discussion (GPT + Gemini 실시간 토론)
- [x] Interjection (토론 중 사용자 개입)
- [x] Continuation session (합의 후 재토론)
- [x] Revision Timeline 시각화
- [x] Workspace Editor (Diff 뷰어)
- [x] Session 저장/불러오기

---

## Known Issues

- **한글 콘솔 출력 깨짐**: Windows 기본 터미널(cmd/PowerShell)에서 한글 로그가 깨질 수 있습니다. Windows Terminal 또는 `chcp 65001` 사용을 권장합니다.
- **Gemini parseFail**: 응답이 길어질 경우 드물게 파싱 실패가 발생할 수 있습니다. 토론 흐름에 영향은 없습니다.
- **API Rate Limit**: Gemini 무료 티어 사용 시 RPM 제한으로 일부 응답이 스킵될 수 있습니다.

---

## Roadmap

- [ ] Claude API 실제 연동 (현재 Mock 사용)
- [ ] 다중 Goal 병렬 토론
- [ ] 토론 결과 마크다운 내보내기
- [ ] 토론 히스토리 검색
- [ ] 모바일/웹 빌드

---

## 라이선스

MIT License — 자세한 내용은 [LICENSE](LICENSE) 파일을 참조하세요.

---

## 주의사항

- `.env` 파일에 실제 API 키를 입력한 경우, **절대로 Git에 커밋하지 마세요**
- `.gitignore`에 `.env`가 포함되어 있지만, 실수로 노출되지 않도록 주의하세요
- 이 프로젝트는 Alpha 단계이며, API 사용에 따른 과금이 발생할 수 있습니다
