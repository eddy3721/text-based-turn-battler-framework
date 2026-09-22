const test = require('node:test');
const assert = require('node:assert/strict');
const { BattleEngine, Entity, Skill, Formulas } = require('../src');

const stats = { hp: 10000, maxHp: 10000, atk: 100, def: 20, sta: 100, agi: 10, spd: 10,
  tec: 10, int: 10, luk: 0 };
const entity = (id, team) => new Entity({ id, name: id, team, stats: { ...stats },
  normalAttack: null, skills: [], passives: [] });

test('action target resolver redirects every hostile damage segment to one ally only', t => {
  const caster = entity('caster', 'A');
  const ally = entity('ally', 'A');
  const enemyA = entity('enemy_a', 'B');
  const enemyB = entity('enemy_b', 'B');
  ally.actionDisabled = true;
  enemyA.actionDisabled = true;
  enemyB.actionDisabled = true;
  const skill = new Skill({ id: 'confused_blast', name: 'confused blast', actions: [
    { type: 'DAMAGE', targetType: 'ENEMY_ALL', power: 0.01 },
    { type: 'DAMAGE', targetType: 'ENEMY_SINGLE', hits: 2, power: 0.01 }
  ] });
  caster.normalAttack = skill;
  t.mock.method(Formulas, 'isHit', () => true);
  t.mock.method(Formulas, 'isCounter', () => false);
  const engine = new BattleEngine([caster, ally], [enemyA, enemyB], {
    luckEvents: { enabled: false }, actionTargetResolver: ({ caster: actor }) =>
      actor === caster ? [ally] : null
  });
  engine.executeTurn();
  const damageLogs = engine.logger.logs.filter(log => log.type === 'DAMAGE');
  assert.ok(damageLogs.length >= 3);
  assert.ok(damageLogs.every(log => log.targetId === ally.id));
  assert.equal(enemyA.stats.hp, enemyA.stats.maxHp);
  assert.equal(enemyB.stats.hp, enemyB.stats.maxHp);
});

test('action target resolver does not redirect healing in a mixed skill', t => {
  const caster = entity('caster', 'A');
  const ally = entity('ally', 'A');
  const enemy = entity('enemy', 'B');
  ally.actionDisabled = true;
  enemy.actionDisabled = true;
  caster.stats.hp = 500;
  const skill = new Skill({ id: 'mixed', name: 'mixed', actions: [
    { type: 'HEAL', targetType: 'SELF', power: 1 },
    { type: 'DAMAGE', targetType: 'ENEMY_SINGLE', power: 1 }
  ] });
  caster.normalAttack = skill;
  t.mock.method(Formulas, 'isHit', () => true);
  t.mock.method(Formulas, 'isCounter', () => false);
  const engine = new BattleEngine([caster, ally], [enemy], {
    luckEvents: { enabled: false }, actionTargetResolver: () => [ally]
  });
  engine.executeTurn();
  assert.ok(caster.stats.hp > 500);
  assert.ok(ally.stats.hp < ally.stats.maxHp);
  assert.equal(enemy.stats.hp, enemy.stats.maxHp);
});

test('side swap mirrors single/all targets for damage, healing and buffs while SELF stays SELF', t => {
  const caster = entity('caster', 'A');
  const ally = entity('ally', 'A');
  const enemyA = entity('enemy_a', 'B');
  const enemyB = entity('enemy_b', 'B');
  caster.stats.hp = 9000;
  ally.stats.hp = 9000;
  enemyA.stats.hp = 5000;
  enemyB.stats.hp = 5000;
  ally.actionDisabled = true;
  enemyA.actionDisabled = true;
  enemyB.actionDisabled = true;
  const skill = new Skill({ id: 'reversed', name: 'reversed', actions: [
    { type: 'HEAL', targetType: 'ALLY_ALL', power: 1 },
    { type: 'DAMAGE', targetType: 'ENEMY_ALL', inheritTarget: false, power: 0.1 },
    { type: 'BUFF', targetType: 'ALLY_ALL', inheritTarget: false,
      buffs: [{ id: 'reversed_mark', name: 'mark', type: 'MARK', duration: 2 }] },
    { type: 'HEAL', targetType: 'SELF', inheritTarget: false, power: 1 }
  ] });
  caster.normalAttack = skill;
  t.mock.method(Formulas, 'isHit', () => true);
  t.mock.method(Formulas, 'isCounter', () => false);
  const engine = new BattleEngine([caster, ally], [enemyA, enemyB], {
    luckEvents: { enabled: false }, actionTargetResolver: () => ({ swapSides: true })
  });
  engine.withActionTargetOverride(caster, { swapSides: true }, () => {
    assert.equal(engine.resolveActionTargetType(caster, 'ENEMY_SINGLE'), 'ALLY_SINGLE');
    assert.equal(engine.resolveActionTargetType(caster, 'ENEMY_ALL'), 'ALLY_ALL');
    assert.equal(engine.resolveActionTargetType(caster, 'ALLY_SINGLE'), 'ENEMY_SINGLE');
    assert.equal(engine.resolveActionTargetType(caster, 'ALLY_ALL'), 'ENEMY_ALL');
    assert.equal(engine.resolveActionTargetType(caster, 'SELF'), 'SELF');
  });
  engine.executeTurn();
  assert.ok(caster.stats.hp > 9000, 'SELF healing stays on the caster');
  assert.ok(ally.stats.hp < 9000, 'ENEMY_ALL damage becomes ALLY_ALL damage');
  assert.ok(enemyA.stats.hp > 5000 && enemyB.stats.hp > 5000,
    'ALLY_ALL healing becomes ENEMY_ALL healing');
  assert.ok(enemyA.buffs.some(buff => buff.id === 'reversed_mark'));
  assert.ok(enemyB.buffs.some(buff => buff.id === 'reversed_mark'));
  assert.ok(!ally.buffs.some(buff => buff.id === 'reversed_mark'));
});

test('skill selection resolver can replace a support skill without changing team membership', t => {
  const caster = entity('caster', 'A');
  const ally = entity('ally', 'A');
  const enemy = entity('enemy', 'B');
  ally.stats.hp = 5000;
  ally.actionDisabled = true;
  enemy.actionDisabled = true;
  const heal = new Skill({ id: 'heal', actions: [{ type: 'HEAL', targetType: 'ALLY_ALL' }] });
  const attack = new Skill({ id: 'attack', actions: [{ type: 'DAMAGE', power: 1 }] });
  caster.openingSkill = heal;
  caster.normalAttack = attack;
  t.mock.method(Formulas, 'isHit', () => true);
  t.mock.method(Formulas, 'isCounter', () => false);
  const engine = new BattleEngine([caster, ally], [enemy], {
    luckEvents: { enabled: false },
    skillSelectionResolver: ({ skill }) => skill === heal ? attack : undefined
  });
  engine.executeTurn();
  assert.equal(ally.stats.hp, 5000);
  assert.ok(enemy.stats.hp < enemy.stats.maxHp);
  assert.equal(caster.team, 'A');
  assert.ok(engine.teamA.includes(caster));
});
