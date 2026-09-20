const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Entity, Skill, BattleEngine, Formulas, Buff } = require('../src');
function setup(t) {
  t.mock.method(Formulas, 'isCritical', () => false);
  t.mock.method(Formulas, 'isHit', () => true);
  t.mock.method(Formulas, 'isCounter', () => false);
  const unit = (id, team) => new Entity({ id, name: id, team,
    stats: { hp: 10000, maxHp: 10000, sp: 100, atk: 100, def: 20, spd: 100, cri: 0, counter: 100 } });
  const a = unit('a', 'A'), b = unit('b', 'B');
  const engine = new BattleEngine([a], [b], { luckEvents: { enabled: false } });
  const attack = options => new Skill({ id: 's', name: 's', actions: [{ type: 'DAMAGE', ...options }] })
    .execute(a, [a], [b], engine.logger, engine);
  return { a, b, engine, attack };
}
test('invincibility blocks direct skills, not DOT; piercing preserves reduction', t => {
  const { b, attack } = setup(t);
  b.addBuff({ id: 'void', name: '無空', invincible: true, duration: 2 });
  attack({}); assert.equal(b.stats.hp, 10000);
  b.takeDamage(30, null, { source: 'DOT' }); assert.equal(b.stats.hp, 9970);
  t.mock.method(Formulas, 'calculateDamage', () => 100);
  b.passives.push({ trigger: 'BEFORE_DAMAGE', action: (self, hit) => { hit.damage *= 0.5; } });
  t.mock.method(Formulas, 'isHit', () => false);
  attack({ ignoreInvincible: true }); assert.equal(b.stats.hp, 9920);
});
test('piercing still permits counters', t => {
  const { b, engine, attack } = setup(t);
  t.mock.method(Formulas, 'isHit', () => false);
  t.mock.method(engine, 'tryCounter', () => true);
  attack({ ignoreInvincible: true }); assert.equal(b.stats.hp, 10000);
});
test('post-formula damage scaling does not subtract defense twice', t => {
  const { b, attack } = setup(t);
  t.mock.method(Formulas, 'calculateDamage', () => 80);
  attack({ hits: 2, damageMultiplier: 0.5 }); assert.equal(b.stats.hp, 9920);
});
test('removal is explicit and preserves unknown, permanent and opposite effects', t => {
  const { b } = setup(t);
  b.addBuff({ id: 'old', type: 'STAT', duration: 2 });
  b.addBuff({ id: 'good', polarity: 'positive', dispellable: true, duration: 2 });
  b.addBuff({ id: 'bad', polarity: 'negative', dispellable: true, duration: 2 });
  b.addBuff({ id: 'protected', polarity: 'positive', duration: Infinity });
  assert.deepEqual(b.removeBuffs('positive').map(x => x.id), ['good']);
  assert.deepEqual(b.buffs.map(x => x.id), ['old', 'bad', 'protected']);
  assert.throws(() => b.removeBuffs('neutral'));
});
test('new optional fields reject malformed configs', () => {
  assert.throws(() => new Buff({ polarity: 'good' }));
  assert.throws(() => new Buff({ invincible: 1 }));
  for (const action of [{ type: 'HEAL', ignoreInvincible: true }, { type: 'DAMAGE', damageMultiplier: -1 }])
    assert.throws(() => new Skill({ actions: [action] }));
});
