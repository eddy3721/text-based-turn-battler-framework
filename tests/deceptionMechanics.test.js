const test = require('node:test');
const assert = require('node:assert/strict');
const { Entity, Skill, BattleEngine, Formulas } = require('../src');

const make = (id, team, passives = []) => new Entity({
  id, name: id, team, passives,
  stats: { hp: 1000, maxHp: 1000, sp: 100, atk: 20, int: 100, def: 300,
    hit: 0, eva: 0, cri: 0, spd: 20, counter: 0 }
});
const aura = (id = 'pressure', multiplier = 0.75) => ({ id, enemySkillCastMultiplier: multiplier });

test('enemy auras preserve the default, deduplicate, and stop at death', () => {
  const a = make('a', 'A', [aura()]);
  const ally = make('ally', 'A', [aura()]);
  const b = make('b', 'B');
  const engine = new BattleEngine([a, ally], [b]);
  assert.equal(engine.getSkillCastChance(a), 0.35);
  assert.equal(engine.getSkillCastChance(b), 0.35 * 0.75);
  a.takeDamage(2000);
  assert.equal(engine.getSkillCastChance(b), 0.35 * 0.75);
  ally.takeDamage(2000);
  assert.equal(engine.getSkillCastChance(b), 0.35);
  // Revivals are external to heal(), which deliberately cannot heal the dead.
  ally.stats.hp = 1000;
  ally.isAlive = true;
  assert.equal(engine.getSkillCastChance(b), 0.35 * 0.75);
});

test('distinct aura ids multiply and malformed modifiers fail explicitly', () => {
  const a = make('a', 'A', [aura(), aura('other', 0.5)]);
  const b = make('b', 'B');
  const engine = new BattleEngine([a], [b]);
  assert.equal(engine.getSkillCastChance(b), 0.35 * 0.75 * 0.5);
  a.passives.push(aura('bad', NaN));
  assert.throws(() => engine.getSkillCastChance(b), /enemySkillCastMultiplier/);
});

test('ordinary lottery falls back to normal attack; opening and called skills bypass suppression', t => {
  t.mock.method(Math, 'random', () => 0.3);
  const a = make('a', 'A', [aura()]);
  const b = make('b', 'B');
  const attack = new Skill({ id: 'normal', name: 'normal', actions: [{ type: 'TEXT' }] });
  const active = new Skill({ id: 'active', name: 'active', actions: [{ type: 'TEXT' }] });
  b.normalAttack = attack;
  b.skills = [active];
  const engine = new BattleEngine([a], [b], { luckEvents: { enabled: false }, skillResolver: () => active });
  t.mock.method(Formulas, 'determineActionOrder', () => [b]);
  engine.executeTurn();
  assert.equal(engine.logger.logs.at(-1).skillId, 'normal');
  a.passives = [];
  engine.executeTurn();
  assert.equal(engine.logger.logs.findLast(log => log.skillId)?.skillId, 'active');

  a.isAlive = true;
  engine.result = null;
  b.hasActed = false;
  b.openingSkill = active;
  a.passives = [aura('pressure', 0)];
  engine.executeTurn();
  assert.equal(engine.logger.logs.at(-1).skillId, 'active');
  engine.castSkill(b, ['active']);
  assert.equal(engine.logger.logs.at(-1).skillId, 'active');
});

test('ignoreDefense bypasses effective defense without mutating it or removing other damage steps', t => {
  t.mock.method(Math, 'random', () => 0.5);
  const a = make('a', 'A');
  const b = make('b', 'B');
  b.addBuff({ id: 'armor', type: 'STAT', duration: 2, effect: stats => { stats.def *= 2; } });
  assert.equal(Formulas.calculateDamage(a, b, 1, 'int'), 33);
  assert.equal(Formulas.calculateDamage(a, b, 1, 'int', { ignoreDefense: true }), 100);
  assert.equal(b.getEffectiveStats().def, 600);
  assert.equal(b.stats.def, 300);
  assert.throws(() => new Skill({ actions: [{ type: 'HEAL', ignoreDefense: true }] }), /ignoreDefense/);

  const skill = new Skill({ id: 'ambush', actions: [{ type: 'DAMAGE', stat: 'int', power: 1, ignoreDefense: true }] });
  const engine = new BattleEngine([a], [b]);
  t.mock.method(Formulas, 'isHit', () => false);
  skill.execute(a, [a], [b], engine.logger, engine);
  assert.equal(b.stats.hp, 1000);
  assert.equal(engine.logger.logs.at(-1).type, 'MISS');

  Formulas.isHit.mock.mockImplementation(() => true);
  t.mock.method(Formulas, 'isCounter', () => true);
  skill.execute(a, [a], [b], engine.logger, engine);
  assert.equal(b.stats.hp, 1000);
  assert.ok(a.stats.hp < 1000);
  assert.equal(engine.logger.logs.at(-1).type, 'COUNTER');

  Formulas.isCounter.mock.mockImplementation(() => false);
  b.passives.push({ trigger: 'BEFORE_DAMAGE', action: (_self, hit) => {
    hit.damage *= 0.5; hit.blocked = true; hit.blockMethod = '盾牌';
  } });
  skill.execute(a, [a], [b], engine.logger, engine);
  assert.equal(b.stats.hp, 950);
  assert.equal(engine.logger.logs.at(-1).value, 50);
  assert.equal(engine.logger.logs.at(-1).type, 'BLOCK');
});
