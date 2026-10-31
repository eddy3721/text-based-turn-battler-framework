const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Entity, Skill, BattleEngine, Buff } = require('../src');

const weaken = new Skill({ id: 'weaken', name: '弱化', actions: [{
  type: 'BUFF', targetType: 'ENEMY_SINGLE', message: ({ target }) => `${target.name} 被弱化了。`,
  buffs: [{ id: 'weak', name: '弱化', type: 'STAT', duration: 2, polarity: 'negative', effect: stats => { stats.atk *= 0.5; } }]
}] });

const unit = (id, team) => new Entity({ id, name: id, team, stats: { hp: 100, maxHp: 100, atk: 10, spd: 10 } });

function cast(refuse) {
  const a = unit('a', 'A');
  const b = unit('b', 'B');
  if (refuse) b.addBuff = () => false;
  const engine = new BattleEngine([a], [b], { luckEvents: { enabled: false } });
  weaken.execute(a, [a], [b], engine.logger, engine);
  return { b, logs: engine.logger.logs.filter(log => log.type === 'BUFF_APPLY') };
}

test('addBuff returns the attached Buff', () => {
  const entity = unit('a', 'A');
  const buff = entity.addBuff({ id: 'x', name: 'x', type: 'STAT', duration: 1 });
  assert.ok(buff instanceof Buff);
  assert.equal(entity.buffs.at(-1), buff);
});

test('BUFF action still logs when addBuff is not overridden', () => {
  const { b, logs } = cast(false);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].message, 'b 被弱化了。');
  assert.ok(b.buffs.some(buff => buff.id === 'weak'));
});

test('BUFF action skips the apply log when addBuff refuses with false', () => {
  const { b, logs } = cast(true);
  assert.equal(logs.length, 0);
  assert.equal(b.buffs.length, 0);
});
