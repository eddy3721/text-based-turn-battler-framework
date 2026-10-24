const test = require('node:test');
const assert = require('node:assert/strict');
const { Entity, Skill } = require('../src');

test('maxHp defaults to the starting hp so healing stays a number', () => {
  const unit = new Entity({ id: 'a', name: 'a', team: 'A', stats: { hp: 100, atk: 10 },
    normalAttack: new Skill({ id: 'hit', name: '攻擊', actions: [{ type: 'DAMAGE' }] }) });
  assert.equal(unit.stats.maxHp, 100);
  unit.stats.hp = 40;
  assert.equal(unit.heal(100), 60);
  assert.equal(unit.stats.hp, 100);
});

test('an explicit maxHp is kept', () => {
  const unit = new Entity({ id: 'a', name: 'a', team: 'A', stats: { hp: 50, maxHp: 80 } });
  assert.equal(unit.stats.maxHp, 80);
});
