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
test('untouchable misses without rolling and lets the defender describe it', t => {
  const { a, b, engine, attack } = setup(t);
  const isHit = t.mock.method(Formulas, 'isHit', () => true);
  const reacted = [];
  b.passives.push({ trigger: 'ON_EVADE', enabled: (self, evasion) => !!evasion.untouchable,
    action: (self, evasion) => { evasion.evadeMessage = `${evasion.untouchable.name}裡的 ${self.name} 沒被碰到`; } });
  b.passives.push({ trigger: 'AFTER_EVADE', action: (self, evasion) => reacted.push(evasion.untouchable.id) });
  b.addBuff({ id: 'deep', name: '深海', untouchable: true, duration: 2 });
  attack({ hits: 3 });
  assert.equal(b.stats.hp, 10000);
  assert.equal(isHit.mock.callCount(), 0);
  const misses = engine.logger.logs.filter(log => log.type === 'MISS');
  assert.equal(misses.length, 3);
  assert.equal(misses[0].message, '深海裡的 b 沒被碰到');
  assert.deepEqual(reacted, ['deep', 'deep', 'deep']);
  assert.equal(a.stats.sp, 100);
});
test('untouchable yields to piercing and counters, and leaves DOT alone', t => {
  const { b, engine, attack } = setup(t);
  t.mock.method(Formulas, 'calculateDamage', () => 100);
  b.addBuff({ id: 'deep', name: '深海', untouchable: true, duration: 2 });
  attack({ ignoreInvincible: true }); assert.equal(b.stats.hp, 9900);
  b.takeDamage(30, null, { source: 'DOT' }); assert.equal(b.stats.hp, 9870);
  engine.withCounterSource({ id: 'x' }, () => attack({})); assert.equal(b.stats.hp, 9770);
  assert.throws(() => new Buff({ untouchable: 'yes' }));
});
