import test from 'node:test';
import assert from 'node:assert/strict';
import { locateQuote } from '../lib/workflow.mjs';

// locateQuote 是纯函数：判断检查意见的引用是否真实存在于稿件中，不调用模型。
const draft = {
  title: '三年级数学基础差，先别急着刷题',
  body: '先把错题按原因分成几类，再决定怎么练。\n\n自然提及课程即可。',
  tags: ['小学数学', '学习方法'],
};

test('引用存在于正文时定位成功', () => {
  assert.equal(locateQuote(draft, '先把错题按原因分成几类'), true);
});

test('引用存在于标题时定位成功', () => {
  assert.equal(locateQuote(draft, '先别急着刷题'), true);
});

test('引用存在于话题时定位成功', () => {
  assert.equal(locateQuote(draft, '小学数学'), true);
});

test('忽略大小写与空白差异', () => {
  const d = { title: '', body: 'ABC def 你好', tags: [] };
  assert.equal(locateQuote(d, 'abc  DEF'), true, '大小写与空白应被归一');
  assert.equal(locateQuote(d, '你  好'), true, '空白差异不影响定位');
});

test('引用不存在时定位失败（模型可能编造）', () => {
  assert.equal(locateQuote(draft, '保证提分，包过'), false);
  assert.equal(locateQuote(draft, '稿件里根本没有这句话'), false);
});

test('空引用定位失败', () => {
  assert.equal(locateQuote(draft, ''), false);
  assert.equal(locateQuote(draft, '   '), false);
});
