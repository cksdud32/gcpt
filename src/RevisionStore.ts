import { Author, Patch, Revision, State, ProposeDecisionPayload, ProposeAlternativePayload, DiscussionSegment, InitialConsensusNotedPayload } from "./types.js";

type Subscriber = (revision: Revision) => void | Promise<void>;

export class RevisionStore {
  private revisions: Revision[] = [];
  private nextId = 1;
  private subscribers: Subscriber[] = [];

  // --- 핵심 메서드 ---

  append(author: Author, patch: Patch): Revision {
    const last = this.revisions[this.revisions.length - 1];
    const revision: Revision = Object.freeze({
      id: this.nextId++,
      parent: last?.id ?? null,
      author,
      timestamp: new Date().toISOString(),
      patch: Object.freeze({
        ...patch,
        references: patch.references ? Object.freeze([...patch.references]) : undefined,
      }),
    });

    this.revisions.push(revision);

    // 구독자 비동기 알림 (await 없이 fire-and-forget)
    for (const sub of this.subscribers) {
      Promise.resolve(sub(revision)).catch((err) => {
        console.error(`[RevisionStore] subscriber error:`, err);
      });
    }

    return revision;
  }

  getHistory(): Revision[] {
    return [...this.revisions];
  }

  getRevision(id: number): Revision | undefined {
    return this.revisions.find((r) => r.id === id);
  }

  // --- subscribe ---

  subscribe(fn: Subscriber): () => void {
    this.subscribers.push(fn);
    // unsubscribe 함수 반환
    return () => {
      this.subscribers = this.subscribers.filter((s) => s !== fn);
    };
  }

  // topic이 worker append를 차단해야 하는 상태인지 확인
  // consensus_reached: 결론 확정 → 차단
  // discussion_paused: 중지/timeout → 차단 (late worker append 방지)
  // user_interjection: 재개 → 허용 (뒤에서부터 탐색 시 paused/decided보다 최신이면 우선)
  isTopicDecided(goalRevId: number): boolean {
    const goalIdx = this.revisions.findIndex(r => r.id === goalRevId);
    if (goalIdx === -1) return false;
    const nextGoalIdx = this.revisions.findIndex((r, i) =>
      i > goalIdx && r.patch.payload.type === "set_goal",
    );
    const end = nextGoalIdx === -1 ? this.revisions.length : nextGoalIdx;
    // 뒤에서부터 탐색 — 가장 최근의 "결정/재개 이벤트"로 판단
    for (let i = end - 1; i >= goalIdx; i--) {
      const t = this.revisions[i].patch.payload.type;
      if (t === "consensus_reached") return true;  // 결론 확정 → 차단
      if (t === "discussion_paused") return true;  // 중지/timeout → 차단
      if (t === "user_interjection") return false; // 재개 → 허용
    }
    return false;
  }

  // --- 직렬화 ---

  toJSON(): string {
    return JSON.stringify(this.revisions, null, 2);
  }

  static fromJSON(json: string): RevisionStore {
    const store = new RevisionStore();
    const parsed = JSON.parse(json) as Revision[];

    for (const rev of parsed) {
      store.revisions.push(Object.freeze(rev));
    }

    // nextId를 이어받음
    store.nextId = parsed.length > 0
      ? Math.max(...parsed.map((r) => r.id)) + 1
      : 1;

    return store;
  }

  // --- rebuildState ---

  rebuildState(): State {
    const state: State = { topics: [] };

    const currentTopic = () => state.topics[state.topics.length - 1];

    for (const rev of this.revisions) {
      const { payload, rationale, references } = rev.patch;

      switch (payload.type) {
        case "set_goal": {
          // 이전 topic이 선택 없이 닫히면 "closed"
          const prev = currentTopic();
          if (prev && prev.status === "active") prev.status = "closed";

          const firstSeg: DiscussionSegment = {
            segmentId:           1,
            startRevisionId:     rev.id,
            proposalRevisionIds: [],
          };
          state.topics.push({
            goal: payload.goal,
            mode: payload.mode,
            interactionStyle: payload.interactionStyle,
            startRevId: rev.id,
            status: "active",
            proposals: [],
            selectedOption: null,
            segments:                 [firstSeg],
            currentSegmentStartRevId: rev.id,
          });
          break;
        }

        case "propose_decision":
        case "propose_alternative":
        case "chat_reply": {
          const t = currentTopic();
          if (t) {
            t.proposals.push({
              revisionId: rev.id,
              author: rev.author,
              content: payload,
              rationale,
            });
            // 현재 세그먼트에도 revId 기록
            const curSeg = t.segments[t.segments.length - 1];
            if (curSeg) curSeg.proposalRevisionIds.push(rev.id);
          }
          break;
        }

        // initial_consensus_noted: selectedOption 설정, status는 "active" 유지
        case "initial_consensus_noted": {
          const targetId2 = references?.[0];
          const target2   = targetId2 !== undefined ? this.revisions.find(r => r.id === targetId2) : undefined;
          const tp2       = target2?.patch.payload;
          if (!tp2 || (tp2.type !== "propose_decision" && tp2.type !== "propose_alternative") || !target2) break;

          const tidx2 = this.revisions.indexOf(target2);
          let ownerSRId2: number | null = null;
          for (let i = tidx2; i >= 0; i--) {
            if (this.revisions[i].patch.payload.type === "set_goal") { ownerSRId2 = this.revisions[i].id; break; }
          }
          const ownerTopic2 = state.topics.find(t => t.startRevId === ownerSRId2);
          if (!ownerTopic2 || ownerTopic2.selectedOption !== null) break;

          ownerTopic2.selectedOption = {
            revisionId:        rev.id,
            selectedBy:        rev.author,
            content:           tp2 as ProposeDecisionPayload | ProposeAlternativePayload,
            convergenceSource: (payload as InitialConsensusNotedPayload).convergenceSource,
          };
          // status는 "active" 유지 — 토론 계속
          break;
        }

        // consensus_reached (system 자동 수렴) 와 select_option (user 명시적 선택) 은
        // 동일하게 topic을 "decided"로 표시하지만 author가 다르다.
        case "consensus_reached":
        case "select_option": {
          // async 환경에서 늦게 도착할 수 있으므로
          // 참조된 winner proposal의 소속 topic으로 귀속시킨다.
          const targetId = references?.[0];
          const target = targetId !== undefined
            ? this.revisions.find((r) => r.id === targetId)
            : undefined;

          const targetPayload = target?.patch.payload;
          const isProposal =
            targetPayload?.type === "propose_decision" ||
            targetPayload?.type === "propose_alternative";

          if (!isProposal || !target) break;

          // winner proposal의 직전 set_goal을 찾아 소속 topic 결정
          const targetIdx = this.revisions.indexOf(target);
          let ownerStartRevId: number | null = null;
          for (let i = targetIdx; i >= 0; i--) {
            if (this.revisions[i].patch.payload.type === "set_goal") {
              ownerStartRevId = this.revisions[i].id;
              break;
            }
          }

          const ownerTopic = state.topics.find((t) => t.startRevId === ownerStartRevId);
          if (!ownerTopic) break;

          // 이미 선택된 topic이면 중복 방지
          if (ownerTopic.selectedOption !== null) break;

          ownerTopic.selectedOption = {
            revisionId: rev.id,
            selectedBy: rev.author,
            content: targetPayload as ProposeDecisionPayload | ProposeAlternativePayload,
            convergenceSource: payload.type === "consensus_reached" ? payload.convergenceSource : undefined,
            confidenceKind: payload.type === "consensus_reached" ? payload.confidenceKind : undefined,
            isMockAffected: payload.type === "consensus_reached" ? payload.isMockAffected : undefined,
          };
          ownerTopic.status = "decided";
          break;
        }

        case "user_interjection": {
          // 이미 decided/paused된 topic에 대한 interjection → "reopened" + 새 세그먼트
          const topic = currentTopic();
          if (topic && (topic.status === "decided" || topic.status === "paused")) {
            topic.status = "reopened";

            // 현재 세그먼트 종료 표시
            const prevSeg = topic.segments[topic.segments.length - 1];
            if (prevSeg && prevSeg.endRevisionId === undefined) {
              prevSeg.endRevisionId = rev.id - 1;
            }

            // 새 세그먼트 시작
            const newSeg: DiscussionSegment = {
              segmentId:           topic.segments.length + 1,
              startRevisionId:     rev.id,
              proposalRevisionIds: [],
            };
            topic.segments.push(newSeg);
            topic.currentSegmentStartRevId = rev.id;
          }
          break;
        }

        case "user_override": {
          const topic = currentTopic();
          if (topic) {
            topic.status = "overridden";
            if (payload.goal !== undefined) {
              const overrideSeg: DiscussionSegment = {
                segmentId:           1,
                startRevisionId:     rev.id,
                proposalRevisionIds: [],
              };
              state.topics.push({
                goal: payload.goal,
                startRevId: rev.id,
                status: "active",
                proposals: [],
                selectedOption: null,
                segments:                 [overrideSeg],
                currentSegmentStartRevId: rev.id,
              });
            }
          }
          break;
        }

        case "discussion_paused": {
          const topic = currentTopic();
          if (topic && (topic.status === "active" || topic.status === "reopened")) {
            topic.status = "paused";
          }
          break;
        }

        case "discussion_deadlock":
          // 교착 경고 — topic 상태는 "active" 유지 (토론 계속), UI에서 배너로 표시
          break;
      }
    }

    return state;
  }
}
