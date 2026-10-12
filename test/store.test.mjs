import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../lib/store.mjs';

// 内存库，不读写真实 data/ 目录。
function setup() {
  const store = createStore(':memory:');
  const profile = store.saveProfile({ accountType: '素人账号', audience: '三年级孩子的家长' });
  const topic = store.createTopic({ profileId: profile.id, title: '3年级数学基础差怎么办', idea: '自然介绍数理思维课程' });
  return { store, profile, topic };
}

test('主链路状态流转：建账号→建选题→加稿→选稿→检查通过→登记发布', () => {
  const { store, topic } = setup();
  const draft = store.addDraft({ topicId: topic.id, origin: 'ai', author: 'test-model', title: '标题', body: '正文内容', tags: ['数学'] });
  assert.equal(draft.status, 'draft');
  assert.equal(draft.version, 1);
  store.selectDraft(draft.id);
  // 未通过检查前不能登记发布
  assert.throws(() => store.recordPublication(draft.id), /请先通过/);
  const review = store.addReview({ draftId: draft.id, version: 1, verdict: 'pass', findings: [] });
  assert.equal(review.verdict, 'pass');
  assert.equal(store.getDraft(draft.id).status, 'approved');
  const pub = store.recordPublication(draft.id, { channel: '小红书' });
  assert.equal(pub.channel, '小红书');
  assert.equal(store.getDraft(draft.id).status, 'published');
  assert.equal(store.getTopic(topic.id).status, 'published');
  store.close();
});

test('输入变化使已通过稿件失效', () => {
  const { store, topic } = setup();
  const draft = store.addDraft({ topicId: topic.id, origin: 'ai', author: 'test-model', title: '标题', body: '正文', tags: [] });
  store.selectDraft(draft.id);
  store.addReview({ draftId: draft.id, version: 1, verdict: 'pass', findings: [] });
  assert.equal(store.getDraft(draft.id).status, 'approved');
  store.updateTopic(topic.id, { idea: '换一个完全不同的想法' });
  assert.equal(store.getDraft(draft.id).status, 'draft', '选题输入变化后稿件应回到未检查状态');
  store.close();
});

test('warn 可人工放行，block 不可放行，重复放行被拒', () => {
  const { store, topic } = setup();
  const draft = store.addDraft({ topicId: topic.id, origin: 'ai', author: 'test-model', title: '标题', body: '正文', tags: [] });
  store.selectDraft(draft.id);
  store.addReview({ draftId: draft.id, version: 1, verdict: 'revise', findings: [{ type: 'cta', severity: 'warn', quote: '留言', reason: '可能引导过强', suggestion: '删除' }] });
  assert.equal(store.getDraft(draft.id).status, 'changes_requested');
  store.overrideReview(draft.id);
  assert.equal(store.getDraft(draft.id).status, 'approved');
  assert.throws(() => store.overrideReview(draft.id), /只有检查后未通过/);

  const { store: s2, topic: t2 } = setup();
  const d2 = s2.addDraft({ topicId: t2.id, origin: 'ai', author: 'test-model', title: '标题', body: '保证提分', tags: [] });
  s2.selectDraft(d2.id);
  s2.addReview({ draftId: d2.id, version: 1, verdict: 'revise', findings: [{ type: 'unsupported_claim', severity: 'block', quote: '保证提分', reason: '绝对化承诺', suggestion: '删除' }] });
  assert.throws(() => s2.overrideReview(d2.id), /阻断问题/);
  store.close(); s2.close();
});

test('settings：保存读回、非法名称拒绝、有运行中拒绝修改', () => {
  const { store, topic } = setup();
  assert.deepEqual(store.getSettings(), {});
  store.saveSettings({ writingModel: 'gemini-3.8-flash-high', checkingModel: 'qwen3.8-max-0902' });
  assert.equal(store.getSettings().writingModel, 'gemini-3.8-flash-high');
  assert.throws(() => store.saveSettings({ writingModel: 'bad name!' }), /写作模型名称格式不正确/);
  store.createRun({ topicId: topic.id, action: 'generate' });
  assert.throws(() => store.saveSettings({ writingModel: 'gpt-6-sol' }), /正在生成或检查/);
  store.close();
});

test('人工修改生成新版本且必须通过重新检查', () => {
  const { store, topic } = setup();
  const draft = store.addDraft({ topicId: topic.id, origin: 'ai', author: 'test-model', title: '标题', body: '正文', tags: [] });
  store.selectDraft(draft.id);
  const edited = store.editDraft(draft.id, { body: '改后的正文' });
  assert.equal(edited.version, 2);
  assert.equal(edited.parentId, draft.id);
  assert.equal(edited.origin, 'human');
  assert.equal(edited.status, 'draft');
  assert.equal(store.getTopic(topic.id).selectedDraftId, edited.id);
  store.close();
});
