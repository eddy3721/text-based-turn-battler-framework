const test = require('node:test');
const assert = require('node:assert/strict');
const { Entity, Buff, Skill } = require('../src');

const logger = () => ({ logs: [], addLog(entry) { this.logs.push(entry); } });
const make = () => new Entity({ id: 'a', name: '甲', team: 'A', stats: { hp: 1000, maxHp: 1000, sp: 100, atk: 100, def: 0, spd: 100, int: 100 } });

test('healTaken scales entity.heal and stacks multiplicatively', () => {
  const a = make();
  a.stats.hp = 100;
  a.addBuff({ id: 'old', name: '老化', type: 'STAT', duration: Infinity, healTaken: { multiplier: 0.5 }, effect: () => {} });
  a.addBuff({ id: 'older', name: '更老', type: 'STAT', duration: Infinity, healTaken: { multiplier: 0.5 }, effect: () => {} });
  assert.equal(a.heal(401, logger()), 100);
  assert.equal(a.stats.hp, 200);
});

test('without healTaken the amount is untouched', () => {
  const a = make();
  a.stats.hp = 100;
  assert.equal(a.scaleHealing(10.5), 10.5);
  assert.equal(a.heal(300, logger()), 300);
});

test('HOT logs and applies the scaled amount', () => {
  const a = make();
  a.stats.hp = 100;
  a.addBuff({ id: 'old', name: '老化', type: 'STAT', duration: Infinity, healTaken: { multiplier: 0.25 }, effect: () => {} });
  const hot = new Buff({ id: 'regen', name: '再生', type: 'HOT', duration: 2, value: 400 });
  const log = logger();
  hot.onPreTurn(a, log, null);
  assert.equal(a.stats.hp, 200);
  assert.equal(log.logs.at(-1).value, 100);
});

test('HEAL actions go through healTaken', () => {
  const a = make();
  a.stats.hp = 100;
  a.addBuff({ id: 'old', name: '老化', type: 'STAT', duration: Infinity, healTaken: { multiplier: 0.5 }, effect: () => {} });
  const heal = new Skill({ id: 'cure', name: '治療', actions: [{ type: 'HEAL', power: 2, stat: 'int', targetType: 'SELF' }] });
  heal.execute(a, [a], [], logger(), null);
  assert.equal(a.stats.hp, 200);
});

test('invalid healTaken throws', () => {
  assert.throws(() => new Buff({ id: 'x', name: 'x', type: 'STAT', duration: 1, healTaken: { multiplier: -1 } }));
  assert.throws(() => new Buff({ id: 'x', name: 'x', type: 'STAT', duration: 1, healTaken: {} }));
});
