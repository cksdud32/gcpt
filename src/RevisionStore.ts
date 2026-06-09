import { Author, Patch, Revision, State, ProposeDecisionPayload, ProposeAlternativePayload } from "./types.js";

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

  // topic이 이미 결론 확정됐는지 확인 — late worker append 차단용
  isTopicDecided(goalRevId: number): boolean {
    const goalIdx = this.revisions.findIndex(r => r.id === goalRevId);
    if (goalIdx === -1) return false;
    const nextGoalIdx = this.revisions.findIndex((r, i) =>
      i > goalIdx && r.patch.payload.type === "set_goal",
    );
    const end = nextGoalIdx === -1 ? this.revisions.length : nextGoalIdx;
    return this.revisions.slice(goalIdx, end).some(r => r.patch.payload.type === "consensus_reached");
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

          state.topics.push({
            goal: payload.goal,
            mode: payload.mode,
            startRevId: rev.id,
            status: "active",
            proposals: [],
            selectedOption: null,
          });
          break;
        }

        case "propose_decision":
        case "propose_alternative": {
          // proposal은 항상 현재 topic에 속함
          // (동기 흐름에서 append되므로 위치 기반 귀속이 정확)
          currentTopic()?.proposals.push({
            revisionId: rev.id,
            author: rev.author,
            content: payload,
            rationale,
          });
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
          };
          ownerTopic.status = "decided";
          break;
        }

        case "user_interjection": {
          // 이미 decided된 topic에 대한 interjection → "reopened" 상태로 전환
          const topic = currentTopic();
          if (topic && topic.status === "decided") {
            topic.status = "reopened";
          }
          break;
        }

        case "user_override": {
          const topic = currentTopic();
          if (topic) {
            topic.status = "overridden";
            if (payload.goal !== undefined) {
              state.topics.push({
                goal: payload.goal,
                startRevId: rev.id,
                status: "active",
                proposals: [],
                selectedOption: null,
              });
            }
          }
          break;
        }
      }
    }

    return state;
  }
}
