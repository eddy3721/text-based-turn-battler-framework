const test = require('node:test');
const assert = require('node:assert/strict');
const { Entity } = require('../src');

const make = () => new Entity({ id: 'a', name: '甲', team: 'B', stats: { hp: 1000, sp: 100, atk: 100, def: 0, spd: 100 } });
const FROST = { threshold: 100, growth: 25 };

test('a new entity has no buildup', () => {
  const a = make();
  assert.equal(a.getBuildup('frost'), null);
});

test('buildup from any source fills the same gauge and triggers at the threshold', () => {
  const a = make();
  assert.equal(a.addBuildup('frost', 60, FROST).triggered, false);
  const second = a.addBuildup('frost', 50, FROST);
  assert.equal(second.triggered, true);
  // 溢出不留，門檻加上抗性。
  assert.deepEqual(a.getBuildup('frost'), { key: 'frost', value: 0, threshold: 125, count: 1 });
});

test('different keys are separate gauges', () => {
  const a = make();
  a.addBuildup('frost', 90, FROST);
  a.addBuildup('bleed', 90, FROST);
  assert.equal(a.getBuildup('frost').value, 90);
  assert.equal(a.getBuildup('bleed').value, 90);
});

test('clearBuildup keeps the raised threshold', () => {
  const a = make();
  a.addBuildup('frost', 100, FROST);
  a.addBuildup('frost', 70, FROST);
  a.clearBuildup('frost');
  assert.deepEqual(a.getBuildup('frost'), { key: 'frost', value: 0, threshold: 125, count: 1 });
});

test('dead entities do not build up', () => {
  const a = make();
  a.stats.hp = 0;
  a.isAlive = false;
  const result = a.addBuildup('frost', 500, FROST);
  assert.equal(result.triggered, false);
  assert.equal(result.amount, 0);
  assert.equal(a.getBuildup('frost').value, 0);
});

test('invalid buildup configuration throws', () => {
  const a = make();
  assert.throws(() => a.addBuildup('', 10, FROST));
  assert.throws(() => a.addBuildup('frost', -1, FROST));
  assert.throws(() => a.addBuildup('frost', 10, {}));
  assert.throws(() => a.addBuildup('frost', 10, { threshold: 100, growth: -1 }));
  a.addBuildup('frost', 10, FROST);
  // 同一種異常的設定必須一致。
  assert.throws(() => a.addBuildup('frost', 10, { threshold: 80, growth: 25 }), /threshold 100/);
});
