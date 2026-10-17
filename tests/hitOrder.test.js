const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Entity, Skill, BattleEngine } = require('../src');
const Formulas = require('../src/utils/Formulas');

const unit = (id, team) => new Entity({ id, name: id, team,
  stats: { hp: 100000, maxHp: 100000, atk: 100, sp: 100, spd: 10 },
  normalAttack: new Skill({ id: 'attack', name: '攻擊', actions: [{ type: 'DAMAGE', power: 1 }] }) });

function cast(t, action, { counter = () => false } = {}) {
  t.mock.method(Formulas, 'isHit', () => true);
  t.mock.method(Formulas, 'isCritical', () => false);
  t.mock.method(Formulas, 'isCounter', counter);
  const caster = unit('boss', 'B');
  const party = ['a', 'b', 'c'].map(id => unit(id, 'A'));
  const engine = new BattleEngine(party, [caster], { luckEvents: { enabled: false } });
  const skill = new Skill({ id: 'storm', name: '風暴', actions: [{ type: 'DAMAGE', targetType: 'ENEMY_ALL', hits: 2, power: 1, ...action }] });
  skill.execute(caster, [caster], party, engine.logger, engine);
  return engine.logger.logs;
}
const hitsOf = logs => logs.filter(log => ['DAMAGE', 'COUNTER'].includes(log.type))
  .map(log => log.type === 'COUNTER' ? `counter:${log.actorId}` : log.targetId);

test('default order finishes every hit on one target before the next', t => {
  assert.deepEqual(hitsOf(cast(t, {})), ['a', 'a', 'b', 'b', 'c', 'c']);
});

test("hitOrder 'wave' sweeps every target once per hit, with the wave line between hits", t => {
  const logs = cast(t, { hitOrder: 'wave', text: { action: '', wave: '風勢又折了回來——' } });
  assert.deepEqual(hitsOf(logs), ['a', 'b', 'c', 'a', 'b', 'c']);
  const lines = logs.map(log => log.message);
  assert.equal(lines.filter(line => line === '風勢又折了回來——').length, 1, '只在第 2 波起印');
  assert.equal(lines.indexOf('風勢又折了回來——'), 3);
  // 每一波的結果行都用 action 片段開頭，不是「第 2 擊，」。
  assert.ok(logs.filter(log => log.type === 'DAMAGE').every(log => log.message.startsWith('對 ')));
  const hit = logs.find(log => log.type === 'DAMAGE');
  assert.equal(hit.isNormalAttack, false);
});

test('a countered wave hit uses the same bare lead, and the attack still aggregates per target', t => {
  let first = true;
  const logs = cast(t, { hitOrder: 'wave', text: { action: '' } },
    { counter: () => { const hit = first; first = false; return hit; } });
  const counter = logs.find(log => log.type === 'COUNTER');
  assert.ok(counter.message.startsWith('但是遭a反擊'));
  assert.deepEqual(hitsOf(logs), ['counter:a', 'b', 'c', 'a', 'b', 'c']);
});

test('without text.wave no wave line is logged', t => {
  const logs = cast(t, { hitOrder: 'wave' });
  assert.equal(logs.filter(log => log.type === 'SKILL_TEXT').length, 0);
});

test('hitOrder is validated', () => {
  const make = action => new Skill({ id: 'x', name: 'x', actions: [action] });
  assert.throws(() => make({ type: 'DAMAGE', hitOrder: 'sideways' }));
  assert.throws(() => make({ type: 'HEAL', hitOrder: 'wave' }));
  assert.throws(() => make({ type: 'DAMAGE', hitOrder: 'wave', combo: true }));
  assert.doesNotThrow(() => make({ type: 'DAMAGE', hitOrder: 'target' }));
});
