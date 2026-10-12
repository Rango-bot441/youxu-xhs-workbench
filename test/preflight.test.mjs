import test from 'node:test';
import assert from 'node:assert/strict';
import { preflight } from '../lib/workflow.mjs';

// preflight 是纯函数，不调用模型。
const baseProfile = {
  accountType: '素人账号', audience: '家长', persona: '', tone: '',
  forbiddenTerms: [], handoffChannels: [], experience: '',
  defaultProductExposure: 'none', defaultCta: 'none',
  product: { name: '', features: [], bookingMethod: '' },
};

test('选题和想法都为空时不就绪', () => {
  const r = preflight({ title: '', idea: '' }, baseProfile);
  assert.equal(r.ready, false);
  assert.ok(r.questions.some(q => q.field === 'idea'));
});

test('不提课程、不写引导时就绪', () => {
  const r = preflight({ title: '3年级数学', idea: '分享方法' }, baseProfile);
  assert.equal(r.ready, true);
  assert.deepEqual(r.questions, []);
});

test('提及课程但缺课程名称/特点时拦截', () => {
  const profile = { ...baseProfile, defaultProductExposure: 'natural' };
  const r = preflight({ title: 't', idea: 'i' }, profile);
  assert.equal(r.ready, false);
  const fields = r.questions.map(q => q.field);
  assert.ok(fields.includes('product.name'));
  assert.ok(fields.includes('product.features'));
});

test('课程资料齐全后就绪', () => {
  const profile = { ...baseProfile, defaultProductExposure: 'natural', product: { name: '试听课', features: ['直播'], bookingMethod: '' } };
  const r = preflight({ title: 't', idea: 'i' }, profile);
  assert.equal(r.ready, true);
});

test('要求行动引导但没有承接方式时拦截', () => {
  const profile = { ...baseProfile, defaultCta: 'soft' };
  const r = preflight({ title: 't', idea: 'i' }, profile);
  assert.equal(r.ready, false);
  assert.ok(r.questions.some(q => q.field === 'bookingMethod'));
});

test('要求亲测经历但未提供时拦截', () => {
  const r = preflight({ title: 't', idea: '我家孩子上过的亲测体验' }, baseProfile);
  assert.equal(r.ready, false);
  assert.ok(r.questions.some(q => q.field === 'experience'));
});
