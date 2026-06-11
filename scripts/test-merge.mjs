// Minimal smoke test for mergeResult / deleteTopicFromResult logic
// Run: node scripts/test-merge.mjs

function addCallMetrics(a, b) {
  return { total: a.total + b.total, parseOk: a.parseOk + b.parseOk,
           parseFail: a.parseFail + b.parseFail, apiError: a.apiError + b.apiError };
}

function mergeResult(existing, incoming) {
  const maxId = existing.history.length > 0 ? Math.max(...existing.history.map(r => r.id)) : 0;
  const reId = id => id + maxId;
  const reIdOpt = id => id !== null ? id + maxId : null;

  const offsetRevisions = incoming.history.map(rev => ({
    ...rev, id: reId(rev.id), parent: reIdOpt(rev.parent),
    patch: { ...rev.patch, references: rev.patch.references ? [...rev.patch.references].map(reId) : undefined },
  }));
  const offsetTopics = incoming.topics.map(topic => ({
    ...topic,
    startRevId: reId(topic.startRevId),
    proposals: topic.proposals.map(p => ({ ...p, revisionId: reId(p.revisionId) })),
    selectedOption: topic.selectedOption
      ? { ...topic.selectedOption, revisionId: reId(topic.selectedOption.revisionId) }
      : null,
  }));
  const m1 = existing.metrics, m2 = incoming.metrics;
  const noCall = { total: 0, parseOk: 0, parseFail: 0, apiError: 0 };
  return {
    mode: 'accumulated', revisionCount: existing.revisionCount + incoming.revisionCount,
    metrics: {
      calls: { gpt: addCallMetrics(m1.calls.gpt, m2.calls.gpt),
               claude: addCallMetrics(m1.calls.claude, m2.calls.claude),
               gemini: addCallMetrics(m1.calls.gemini ?? noCall, m2.calls.gemini ?? noCall) },
      latencyMs: [...m1.latencyMs, ...m2.latencyMs],
      tokens: { prompt: m1.tokens.prompt + m2.tokens.prompt, completion: m1.tokens.completion + m2.tokens.completion },
      topics: { decided: m1.topics.decided + m2.topics.decided, undecided: m1.topics.undecided + m2.topics.undecided },
    },
    history: [...existing.history, ...offsetRevisions],
    topics: [...existing.topics, ...offsetTopics],
  };
}

function deleteTopicFromResult(result, localIdx) {
  const topics = result.topics;
  const ranges = topics.map((t, i) => ({
    startId: t.startRevId,
    endId: i + 1 < topics.length ? topics[i + 1].startRevId : Infinity,
  }));
  const { startId, endId } = ranges[localIdx];
  const newHistory = result.history.filter(r => r.id < startId || r.id >= endId);
  const newTopics = topics.filter((_, i) => i !== localIdx);
  const decided = newTopics.filter(t => t.status === 'decided').length;
  const undecided = newTopics.filter(t => t.status !== 'decided').length;
  return { ...result, revisionCount: newHistory.length, history: newHistory, topics: newTopics,
           metrics: { ...result.metrics, topics: { decided, undecided } } };
}

function findSessionForTopic(sessions, globalIdx) {
  let cumulative = 0;
  for (let si = 0; si < sessions.length; si++) {
    const count = sessions[si].topics.length;
    if (globalIdx < cumulative + count) return { sessionIdx: si, localIdx: globalIdx - cumulative };
    cumulative += count;
  }
  return null;
}

// ─── Test helpers ────────────────────────────────────────────────

const noMetrics = () => ({
  calls: { gpt: { total:0, parseOk:0, parseFail:0, apiError:0 },
           claude: { total:0, parseOk:0, parseFail:0, apiError:0 },
           gemini: { total:0, parseOk:0, parseFail:0, apiError:0 } },
  latencyMs: [], tokens: { prompt:0, completion:0 }, topics: { decided:0, undecided:0 }
});

function makeResult(goalRevId, extraRevs, topicStatus) {
  return {
    mode: 'normal', revisionCount: 1 + extraRevs,
    metrics: noMetrics(),
    history: [
      { id: goalRevId, parent: null, author: 'system', timestamp: '', patch: { type: 'set_goal', payload: { type: 'set_goal', goal: `Topic ${goalRevId}` } } },
      ...Array.from({ length: extraRevs }, (_, i) => ({
        id: goalRevId + i + 1, parent: goalRevId + i, author: 'gpt', timestamp: '',
        patch: { type: 'propose_decision', payload: { type: 'propose_decision', value: 'X', reason: 'r' } },
      })),
    ],
    topics: [{
      goal: `Topic ${goalRevId}`, startRevId: goalRevId, status: topicStatus ?? 'decided',
      proposals: [{ revisionId: goalRevId + 1, author: 'gpt', content: { type: 'propose_decision', value: 'X', reason: 'r' } }],
      selectedOption: { revisionId: goalRevId + 1, selectedBy: 'gpt', content: { type: 'propose_decision', value: 'X', reason: 'r' } },
    }],
  };
}

let passed = 0, failed = 0;
function expect(desc, cond) {
  if (cond) { console.log(`  ✓ ${desc}`); passed++; }
  else       { console.error(`  ✗ ${desc}`); failed++; }
}

// ─── Tests ────────────────────────────────────────────────────────

console.log('\n[mergeResult — ID offsetting]');
{
  const A = makeResult(1, 2); // revisions 1,2,3; topic startRevId=1
  const B = makeResult(1, 1); // revisions 1,2; topic startRevId=1 (same — conflict before offset)
  const merged = mergeResult(A, B);

  expect('no duplicate IDs', new Set(merged.history.map(r => r.id)).size === merged.history.length);
  expect('total revision count', merged.history.length === A.history.length + B.history.length);
  expect('topics count', merged.topics.length === 2);
  expect('B topic startRevId offset', merged.topics[1].startRevId === 1 + Math.max(...A.history.map(r => r.id)));
  expect('B proposal revisionId offset', merged.topics[1].proposals[0].revisionId > Math.max(...A.history.map(r => r.id)));
  expect('mode is accumulated', merged.mode === 'accumulated');
  expect('revisionCount summed', merged.revisionCount === A.revisionCount + B.revisionCount);
}

console.log('\n[mergeResult — parent chain]');
{
  const A = makeResult(1, 1); // revs 1,2
  const B = makeResult(1, 1); // revs 1,2
  const merged = mergeResult(A, B);
  // B's first rev (id=1) → parent=null  → should remain null after offset? No — offset is +maxId of A
  // B's second rev (id=2) → parent=1 → should be 1+maxId
  const maxA = Math.max(...A.history.map(r => r.id));
  const BRevs = merged.history.slice(A.history.length);
  expect('B rev[0] id = 1 + maxA', BRevs[0].id === 1 + maxA);
  expect('B rev[0] parent = null + maxA (null → null)', BRevs[0].parent === null + maxA || BRevs[0].parent === null);
  expect('B rev[1] parent offset', BRevs[1].parent === 1 + maxA);
}

console.log('\n[deleteTopicFromResult]');
{
  const A = makeResult(1, 1); // 2 revs
  const B = makeResult(1, 1);
  const merged = mergeResult(A, B);
  expect('merged has 2 topics', merged.topics.length === 2);

  const after = deleteTopicFromResult(merged, 0); // delete first topic
  expect('1 topic remains', after.topics.length === 1);
  expect('remaining topic is B topic', after.topics[0].goal === merged.topics[1].goal);
  expect('B revisions preserved', after.history.every(r => r.id > Math.max(...A.history.map(r => r.id))));
  expect('A revisions removed', !after.history.some(r => r.id <= Math.max(...A.history.map(r => r.id))));
}

console.log('\n[deleteTopicFromResult — last topic]');
{
  const A = makeResult(1, 1);
  const B = makeResult(1, 1);
  const merged = mergeResult(A, B);
  const after = deleteTopicFromResult(merged, 1); // delete second topic
  expect('1 topic remains', after.topics.length === 1);
  expect('A revisions preserved', after.history.every(r => r.id <= Math.max(...A.history.map(r => r.id))));
}

console.log('\n[findSessionForTopic]');
{
  const sessions = [
    { topics: [{ goal: 'T1' }, { goal: 'T2' }] },
    { topics: [{ goal: 'T3' }] },
    { topics: [{ goal: 'T4' }, { goal: 'T5' }] },
  ];
  expect('T1 → session 0, local 0', JSON.stringify(findSessionForTopic(sessions, 0)) === JSON.stringify({ sessionIdx: 0, localIdx: 0 }));
  expect('T2 → session 0, local 1', JSON.stringify(findSessionForTopic(sessions, 1)) === JSON.stringify({ sessionIdx: 0, localIdx: 1 }));
  expect('T3 → session 1, local 0', JSON.stringify(findSessionForTopic(sessions, 2)) === JSON.stringify({ sessionIdx: 1, localIdx: 0 }));
  expect('T4 → session 2, local 0', JSON.stringify(findSessionForTopic(sessions, 3)) === JSON.stringify({ sessionIdx: 2, localIdx: 0 }));
  expect('T5 → session 2, local 1', JSON.stringify(findSessionForTopic(sessions, 4)) === JSON.stringify({ sessionIdx: 2, localIdx: 1 }));
  expect('out of bounds → null', findSessionForTopic(sessions, 5) === null);
}

console.log('\n[reduce accumulation — 3 sessions]');
{
  const S1 = makeResult(1, 0);
  const S2 = makeResult(1, 0);
  const S3 = makeResult(1, 0);
  const merged = [S1, S2, S3].reduce(mergeResult);
  expect('3 topics total', merged.topics.length === 3);
  expect('all IDs unique', new Set(merged.history.map(r => r.id)).size === merged.history.length);
  expect('revisionCount == history.length', merged.revisionCount === merged.history.length);
}

console.log(`\n${'─'.repeat(40)}`);
console.log(`Total: ${passed + failed}  ✓ ${passed}  ✗ ${failed}`);
if (failed > 0) process.exit(1);
