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
  // 固定成「施放者剛好行動一次」。預設的速度權重抽籤會讓他拿到 1~4 個行動槽，
  // 日誌筆數跟著浮動，斷言就會時好時壞。
  t.mock.method(Formulas, 'determineActionOrder', () => [caster]);
  const engine = new BattleEngine([caster, ally], [enemyA, enemyB], {
    luckEvents: { enabled: false }, actionTargetResolver: ({ caster: actor }) =>
      actor === caster ? [ally] : null
  });
  engine.executeTurn();
  const damageLogs = engine.logger.logs.filter(log => log.type === 'DAMAGE');
  // 兩段 DAMAGE 各至少產生一筆。第二段的 hits: 2 不會生效——這個技能掛在
  // normalAttack 上，普攻的段數一律由速度差的連擊公式決定（雙方同速即 1 段）。
  assert.ok(damageLogs.length >= 2);
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
  t.mock.method(Formulas, 'determineActionOrder', () => [caster]);
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
    // duration 給大一點：這裡驗的是「標記掛到了哪一邊」，不是它撐幾個行動槽。
    // duration: 2 會在同一個回合內被接收方自己的行動槽扣完，斷言就變成擲骰。
    { type: 'BUFF', targetType: 'ALLY_ALL', inheritTarget: false,
      buffs: [{ id: 'reversed_mark', name: 'mark', type: 'MARK', duration: 99 }] },
    { type: 'HEAL', targetType: 'SELF', inheritTarget: false, power: 1 }
  ] });
  caster.normalAttack = skill;
  t.mock.method(Formulas, 'isHit', () => true);
  t.mock.method(Formulas, 'isCounter', () => false);
  t.mock.method(Formulas, 'determineActionOrder', () => [caster]);
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
  t.mock.method(Formulas, 'determineActionOrder', () => [caster]);
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

test('swapSides with excludeSelf never turns a controlled caster on itself', t => {
  const caster = entity('caster', 'A');
  const ally = entity('ally', 'A');
  const enemy = entity('enemy', 'B');
  ally.actionDisabled = true;
  enemy.actionDisabled = true;
  caster.normalAttack = new Skill({ id: 'controlled', name: 'controlled', actions: [
    { type: 'DAMAGE', targetType: 'ENEMY_SINGLE', power: 1 },
    { type: 'DAMAGE', targetType: 'ENEMY_ALL', inheritTarget: false, power: 1 },
    { type: 'HEAL', targetType: 'ALLY_SINGLE', inheritTarget: false, power: 1 }
  ] });
  enemy.stats.hp = 5000;
  t.mock.method(Formulas, 'isHit', () => true);
  t.mock.method(Formulas, 'isCounter', () => false);
  t.mock.method(Formulas, 'determineActionOrder', () => [caster]);
  // 0 會讓均勻抽籤挑第一個，也就是施放者自己；excludeSelf 之下應該只剩隊友可選。
  t.mock.method(Math, 'random', () => 0);
  const engine = new BattleEngine([caster, ally], [enemy], {
    luckEvents: { enabled: false },
    actionTargetResolver: ({ caster: actor }) => actor === caster ? { swapSides: true, excludeSelf: true } : null
  });
  engine.withActionTargetOverride(caster, { swapSides: true, excludeSelf: true }, () => {
    assert.equal(engine.swapExcludesSelf(caster), true);
    assert.equal(engine.swapExcludesSelf(ally), false);
  });
  engine.withActionTargetOverride(caster, { swapSides: true }, () => assert.equal(engine.swapExcludesSelf(caster), false));
  engine.executeTurn();
  assert.equal(caster.stats.hp, caster.stats.maxHp, 'neither the single nor the all-target swap hits the caster');
  assert.ok(ally.stats.hp < ally.stats.maxHp);
  assert.ok(enemy.stats.hp > 5000, 'the mirrored heal still goes to the other side');
});

test('swapSides with excludeSelf skips the segment when the caster is the only ally left', t => {
  const caster = entity('caster', 'A');
  const ally = entity('ally', 'A');
  const enemy = entity('enemy', 'B');
  ally.isAlive = false;
  ally.stats.hp = 0;
  enemy.actionDisabled = true;
  caster.normalAttack = new Skill({ id: 'controlled', name: 'controlled', actions: [{ type: 'DAMAGE', power: 1 }] });
  t.mock.method(Formulas, 'isHit', () => true);
  t.mock.method(Formulas, 'determineActionOrder', () => [caster]);
  const engine = new BattleEngine([caster, ally], [enemy], {
    luckEvents: { enabled: false }, actionTargetResolver: () => ({ swapSides: true, excludeSelf: true })
  });
  engine.executeTurn();
  assert.equal(caster.stats.hp, caster.stats.maxHp);
  assert.equal(enemy.stats.hp, enemy.stats.maxHp);
});

test('{ targets, uncounterable } redirects like an array and the recipient never counters (1.0.37)', t => {
  const caster = entity('caster', 'A');
  const ally = entity('ally', 'A');
  const enemy = entity('enemy', 'B');
  enemy.actionDisabled = true;
  const skill = new Skill({ id: 'shifted', name: 'shifted', actions: [{ type: 'DAMAGE', power: 0.01 }] });
  caster.normalAttack = skill;
  ally.normalAttack = new Skill({ id: 'idle', name: 'idle', actions: [{ type: 'TEXT' }] });
  t.mock.method(Formulas, 'isHit', () => true);
  const isCounter = t.mock.method(Formulas, 'isCounter', () => true);
  t.mock.method(Formulas, 'determineActionOrder', () => [caster]);
  const engine = new BattleEngine([caster, ally], [enemy], {
    luckEvents: { enabled: false }, actionTargetResolver: ({ caster: actor }) =>
      actor === caster ? { targets: [ally], uncounterable: true } : null
  });
  engine.executeTurn();
  assert.ok(ally.stats.hp < ally.stats.maxHp);
  assert.equal(enemy.stats.hp, enemy.stats.maxHp);
  assert.equal(caster.stats.hp, caster.stats.maxHp);
  // 不可反擊在擲骰前就排除，不消耗反擊判定。
  assert.equal(isCounter.mock.callCount(), 0);
  assert.ok(engine.logger.logs.every(log => log.type !== 'COUNTER' && !log.isCounter));
});

test('{ targets } without uncounterable still lets the recipient counter', t => {
  const caster = entity('caster', 'A');
  const ally = entity('ally', 'A');
  const enemy = entity('enemy', 'B');
  enemy.actionDisabled = true;
  caster.normalAttack = new Skill({ id: 'shifted', name: 'shifted', actions: [{ type: 'DAMAGE', power: 0.01 }] });
  t.mock.method(Formulas, 'isHit', () => true);
  t.mock.method(Formulas, 'isCounter', () => true);
  t.mock.method(Formulas, 'determineActionOrder', () => [caster]);
  const engine = new BattleEngine([caster, ally], [enemy], {
    luckEvents: { enabled: false }, actionTargetResolver: ({ caster: actor }) =>
      actor === caster ? { targets: [ally] } : null
  });
  engine.executeTurn();
  assert.ok(engine.logger.logs.some(log => log.type === 'COUNTER'));
  assert.ok(caster.stats.hp < caster.stats.maxHp);
});
