const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Entity, Skill, BattleEngine } = require('../src');
const Formulas = require('../src/utils/Formulas');

const entity = (id, team, extra = {}) => new Entity({ id, name: id, team,
  stats: { hp: 100, maxHp: 100, atk: 10, def: 0, sp: 30, spd: 10 }, ...extra });
const damage = (id, extra = {}) => new Skill({ id, actions: [{ type: 'DAMAGE', ...extra }] });
const wait = new Skill({ id: 'wait', actions: [{ type: 'TEXT', targetType: 'SELF' }] });
function setup(t, skills = {}) {
  t.mock.method(Formulas, 'isHit', () => true);
  t.mock.method(Formulas, 'isCritical', () => false);
  t.mock.method(Formulas, 'calculateDamage', () => 10);
  t.mock.method(Formulas, 'getCombos', () => 1);
  const a = entity('a', 'A', { normalAttack: wait });
  const b = entity('b', 'B', { normalAttack: wait });
  const engine = new BattleEngine([a], [b], { skillResolver: id => skills[id] });
  return { a, b, engine };
}

test('registered calls charge only the caller and retain child skill metadata and own targeting', t => {
  const hit = damage('hit', { spCost: 100 });
  const call = new Skill({ id: 'call', actions: [
    { type: 'TEXT', targetType: 'SELF' },
    { type: 'CAST_SKILL', skillIds: ['hit'], spCost: 7 }
  ] });
  const { a, b, engine } = setup(t, { hit });
  assert.equal(call.canCast(a, engine), true);
  call.execute(a, [a], [b], engine.logger, engine);
  assert.equal(a.stats.sp, 23);
  assert.equal(a.stats.hp, 100);
  assert.equal(b.stats.hp, 90);
  assert.equal(engine.logger.logs.at(-1).skillId, 'hit');
  assert.equal(hit.actions[0].spCost, 100);
  assert.equal(hit.canCast(a, engine), false);
  assert.deepEqual(engine.skillCallStack, []);
});

test('random calls reach every candidate, exclude summon constraints, and reject bad IDs', t => {
  const x = damage('x'), y = damage('y');
  const summon = new Skill({ id: 'summon', actions: [{ type: 'SUMMON', monsterId: 'mob' }] });
  const { a, engine } = setup(t, { x, y, summon });
  t.mock.method(Math, 'random', () => 0);
  assert.equal(engine.castSkill(a, ['x', 'y', 'summon']).id, 'x');
  t.mock.method(Math, 'random', () => 0.99);
  assert.equal(engine.castSkill(a, ['x', 'y', 'summon']).id, 'y');
  assert.equal(engine.castSkill(a, ['summon']), undefined);
  assert.throws(() => engine.castSkill(a, ['missing']), /Unknown or invalid skill/);
  assert.throws(() => engine.castSkill(a, []), /non-empty/);
  assert.throws(() => new BattleEngine([a], []).castSkill(a, ['x']), /skillResolver/);
});

test('recursive skill pools terminate and still allow non-cyclic candidates', t => {
  const x = new Skill({ id: 'x', actions: [{ type: 'CAST_SKILL', skillIds: ['y'] }] });
  const y = new Skill({ id: 'y', actions: [{ type: 'CAST_SKILL', skillIds: ['x', 'hit'] }] });
  const hit = damage('hit');
  const { a, b, engine } = setup(t, { x, y, hit });
  engine.castSkill(a, ['x']);
  assert.equal(b.stats.hp, 90);
  assert.deepEqual(engine.skillCallStack, []);
  const cycle = new Skill({ id: 'cycle', actions: [{ type: 'CAST_SKILL', skillIds: ['cycle'] }] });
  engine.skillResolver = id => id === 'cycle' ? cycle : undefined;
  assert.equal(engine.castSkill(a, ['cycle']), undefined);
});

test('skill call stack unwinds after errors', t => {
  const bad = new Skill({ id: 'bad', actions: [{ type: 'CAST_SKILL', skillIds: ['missing'] }] });
  const { a, b, engine } = setup(t);
  assert.throws(() => bad.execute(a, [a], [b], engine.logger, engine), /Unknown/);
  assert.deepEqual(engine.skillCallStack, []);
});

test('charge fires on next available slot in same round, free, then normal action continues', t => {
  const hit = damage('hit', { spCost: 999 });
  const charge = new Skill({ id: 'charge', actions: [{ type: 'BUFF', targetType: 'SELF', spCost: 4,
    buffs: [{ id: 'charge', trigger: 'BEFORE_ACTION', remainingTriggers: 1, skillIds: ['hit'] }] }] });
  const { a, b, engine } = setup(t, { hit });
  a.openingSkill = charge;
  t.mock.method(Formulas, 'determineActionOrder', () => [a, a]);
  engine.executeTurn();
  assert.equal(b.stats.hp, 90);
  assert.equal(a.stats.sp, 26);
  assert.equal(a.buffs.length, 0);
  assert.deepEqual(engine.logger.logs.filter(l => l.skillId).map(l => l.skillId), ['charge', 'hit', 'wait']);
});

test('charge waits through stun; triggered buff lifetime does not use action duration', t => {
  const { a, b, engine } = setup(t, { hit: damage('hit') });
  a.addBuff({ id: 'charge', trigger: 'BEFORE_ACTION', remainingTriggers: 1, skillIds: ['hit'] });
  a.addBuff({ id: 'stun', type: 'STUN', duration: 1 });
  t.mock.method(Formulas, 'determineActionOrder', () => [a]);
  engine.executeTurn();
  assert.equal(b.stats.hp, 100);
  assert.equal(a.buffs.length, 1);
  engine.executeTurn();
  assert.equal(b.stats.hp, 90);
  assert.equal(a.buffs.length, 0);
});

test('rain runs on next two global rounds even without owner slots, once per round, refreshes', t => {
  const { a, b, engine } = setup(t, { rain: damage('rain', { targetType: 'ENEMY_ALL' }) });
  const buff = { id: 'rain', trigger: 'ROUND_START', remainingTriggers: 2, skillIds: ['rain'], stackPolicy: 'refresh' };
  a.addBuff(buff, engine);
  t.mock.method(Formulas, 'determineActionOrder', () => [b, b]);
  engine.executeTurn();
  assert.equal(b.stats.hp, 100);
  engine.currentTurn++;
  engine.executeTurn(); engine.executeTurn();
  assert.equal(b.stats.hp, 90);
  a.addBuff(buff, engine);
  assert.equal(a.buffs.length, 1);
  engine.executeTurn();
  assert.equal(b.stats.hp, 90);
  engine.currentTurn++; engine.executeTurn();
  engine.currentTurn++; engine.executeTurn();
  engine.currentTurn++; engine.executeTurn();
  assert.equal(b.stats.hp, 70);
  assert.equal(a.buffs.length, 0);
});

test('half-HP reaction is logged after hit and immediately stops a slain attacker mid-skill', t => {
  const burst = damage('burst', { targetType: 'ENEMY_ALL' });
  const { a, b, engine } = setup(t, { burst });
  a.stats.hp = 5;
  b.stats.hp = 60;
  b.dialogues.death = 'death'; b.dialogues.victory = 'victory';
  b.passives = [{ condition: 'HP_BELOW', threshold: 0.5, action(self, logger, ctx) {
    logger.addLog({ type: 'BOSS_DIALOGUE', message: 'phase' });
    ctx.castSkill(self, ['burst']);
  } }];
  const combo = new Skill({ id: 'combo', actions: [
    { type: 'DAMAGE', hits: 3 }, { type: 'TEXT', targetType: 'SELF' }
  ] });
  combo.execute(a, [a], [b], engine.logger, engine);
  assert.equal(b.stats.hp, 50);
  assert.equal(a.isAlive, false);
  assert.equal(engine.result, 'TEAM_B');
  assert.deepEqual(engine.logger.logs.map(l => l.type), ['DAMAGE', 'BOSS_DIALOGUE', 'DAMAGE', 'DEATH', 'BOSS_DIALOGUE']);
  assert.equal(engine.logger.logs.filter(l => l.skillId === 'combo').length, 1);
});

test('lethal damage skips phase, removes scheduled effects, and death/victory dialogue is once', t => {
  const { a, b, engine } = setup(t);
  b.stats.hp = 5;
  b.dialogues.death = 'farewell'; a.dialogues.victory = 'won';
  b.passives = [{ condition: 'HP_BELOW', threshold: 0.5, action() { assert.fail('dead unit transitioned'); } }];
  b.addBuff({ id: 'rain', trigger: 'ROUND_START', remainingTriggers: 2, skillIds: ['none'] });
  damage('hit').execute(a, [a], [b], engine.logger, engine);
  engine.settleDeaths(); engine.checkWinCondition(); engine.executeTurn();
  assert.equal(b.buffs.length, 0);
  assert.equal(engine.logger.logs.filter(l => l.type === 'DEATH').length, 1);
  assert.equal(engine.logger.logs.filter(l => l.type === 'BOSS_DIALOGUE').length, 2);
});

test('normal attacks trigger one follow-up per positive hit on same target, never recursively', t => {
  const extra = damage('extra');
  const { a, b, engine } = setup(t, { extra });
  const other = entity('other', 'B'); engine.teamB.push(other);
  a.normalAttack = damage('normal');
  t.mock.method(Formulas, 'getCombos', () => 3);
  t.mock.method(Math, 'random', () => 0);
  a.passives = [{ trigger: 'AFTER_DAMAGE_DEALT', enabled: (_, hit) => hit.isNormalAttack,
    action(self, hit, logger, ctx) { ctx.castSkill(self, ['extra'], { targets: [hit.target] }); } }];
  a.normalAttack.execute(a, [a], [b, other], engine.logger, engine);
  const logs = engine.logger.logs.filter(l => l.type === 'DAMAGE');
  assert.deepEqual(logs.map(l => l.skillId), ['normal', 'extra', 'normal', 'extra', 'normal', 'extra']);
  assert.ok(logs.every(l => l.targetId === b.id));
  assert.equal(other.stats.hp, 100);
  b.passives = [{ trigger: 'BEFORE_DAMAGE', action: (_, hit) => { hit.damage = 0; hit.blocked = true; } }];
  engine.logger.logs.length = 0;
  a.normalAttack.execute(a, [a], [b, other], engine.logger, engine);
  assert.ok(engine.logger.logs.every(l => l.type === 'BLOCK'));
  t.mock.method(Formulas, 'isHit', () => false);
  engine.logger.logs.length = 0;
  a.normalAttack.execute(a, [a], [b, other], engine.logger, engine);
  assert.equal(engine.logger.logs.filter(l => l.type === 'MISS').length, 3);
  assert.ok(engine.logger.logs.every(l => ['MISS', 'FATIGUE'].includes(l.type)));
});

test('DOT death uses shared death processing and cancels charge before action', t => {
  const { a, engine } = setup(t);
  a.stats.hp = 5; a.dialogues.death = 'dead';
  a.addBuff({ id: 'charge', trigger: 'BEFORE_ACTION', remainingTriggers: 1, skillIds: ['missing'] });
  a.addBuff({ id: 'poison', name: 'poison', type: 'DOT', value: 10, duration: 2 });
  t.mock.method(Formulas, 'determineActionOrder', () => [a, a]);
  engine.executeTurn();
  assert.equal(engine.result, 'TEAM_B');
  assert.equal(engine.logger.logs.filter(l => l.type === 'DEATH').length, 1);
  assert.equal(engine.logger.logs.filter(l => l.type === 'BOSS_DIALOGUE').length, 1);
});

test('opening appears before actions and draw has no victory dialogue', t => {
  const { a, b, engine } = setup(t);
  a.dialogues = { opening: 'hello', victory: 'won' };
  b.dialogues = { opening: 'there', victory: 'won' };
  engine.maxTurns = 1;
  t.mock.method(Formulas, 'determineActionOrder', () => [a, b]);
  const result = engine.start();
  assert.equal(result.winner, 'DRAW');
  assert.deepEqual(result.logs.slice(0, 4).map(l => l.type), ['BATTLE_START', 'BOSS_DIALOGUE', 'BOSS_DIALOGUE', 'TURN_START']);
  assert.equal(result.logs.filter(l => l.type === 'BOSS_DIALOGUE').length, 2);
});

test('HEAL and HOT forward engine to HP reactions after their recovery log', t => {
  const burst = damage('burst');
  const { a, b, engine } = setup(t, { burst });
  const reaction = () => ({ condition: 'HP_BELOW', threshold: 0.5,
    action(self, logger, ctx) { ctx.castSkill(self, ['burst']); } });
  a.stats.hp = 30; a.passives = [reaction()];
  const heal = new Skill({ id: 'heal', actions: [{ type: 'HEAL', targetType: 'SELF' }] });
  heal.execute(a, [a], [b], engine.logger, engine);
  assert.equal(a.stats.hp, 40); assert.equal(b.stats.hp, 90);
  assert.deepEqual(engine.logger.logs.map(l => l.type), ['HEAL', 'DAMAGE']);
  a.stats.hp = 30; a.passives = [reaction()];
  a.addBuff({ id: 'hot', name: 'hot', type: 'HOT', value: 5, duration: 2 });
  a.buffs[0].onPreTurn(a, engine.logger, engine);
  assert.equal(a.stats.hp, 35); assert.equal(b.stats.hp, 80);
  assert.deepEqual(engine.logger.logs.slice(-2).map(l => l.type), ['BUFF_EFFECT', 'DAMAGE']);
});

test('another caster can react using the same registered skill without defeating cycle protection', t => {
  const burst = damage('burst');
  const { a, b, engine } = setup(t, { burst });
  a.stats.hp = 60; b.stats.hp = 60;
  for (const unit of [a, b]) unit.passives = [{ condition: 'HP_BELOW', threshold: 0.5,
    action(self, logger, ctx) { ctx.castSkill(self, ['burst']); } }];
  engine.castSkill(a, ['burst']);
  assert.equal(b.stats.hp, 50);
  assert.equal(a.stats.hp, 50);
  assert.deepEqual(engine.logger.logs.filter(l => l.type === 'DAMAGE').map(l => l.actorId), ['a', 'b']);
  assert.deepEqual(engine.skillCallStack, []);
});

test('reactive death stops AoE and subsequent actions even when both teams still have survivors', t => {
  const burst = damage('burst');
  const { a, b, engine } = setup(t, { burst });
  const ally = entity('ally', 'A'), enemy = entity('enemy', 'B');
  engine.teamA.push(ally); engine.teamB.push(enemy);
  a.stats.hp = 5; b.stats.hp = 60;
  t.mock.method(Math, 'random', () => 0);
  b.passives = [{ condition: 'HP_BELOW', threshold: 0.5,
    action(self, logger, ctx) { ctx.castSkill(self, ['burst']); } }];
  const aoe = new Skill({ id: 'aoe', actions: [
    { type: 'DAMAGE', targetType: 'ENEMY_ALL' }, { type: 'TEXT', targetType: 'SELF' }
  ] });
  aoe.execute(a, engine.teamA, engine.teamB, engine.logger, engine);
  assert.equal(engine.result, null);
  assert.equal(a.isAlive, false);
  assert.equal(enemy.stats.hp, 100);
  assert.equal(engine.logger.logs.filter(l => l.skillId === 'aoe').length, 1);
});

test('partially blocked normal hit triggers once; lethal follow-up stops combos without retargeting', t => {
  const extra = damage('extra');
  const { a, b, engine } = setup(t, { extra });
  const enemy = entity('enemy', 'B'); engine.teamB.push(enemy);
  b.stats.hp = 12;
  b.passives = [{ trigger: 'BEFORE_DAMAGE', enabled: (_, hit) => hit.isNormalAttack,
    action: (_, hit) => { hit.damage = 5; hit.blocked = true; } }];
  a.normalAttack = damage('normal');
  a.passives = [{ trigger: 'AFTER_DAMAGE_DEALT', enabled: (_, hit) => hit.isNormalAttack,
    action(self, hit, logger, ctx) { ctx.castSkill(self, ['extra'], { targets: [hit.target] }); } }];
  t.mock.method(Formulas, 'getCombos', () => 3);
  t.mock.method(Math, 'random', () => 0);
  a.normalAttack.execute(a, [a], engine.teamB, engine.logger, engine);
  assert.deepEqual(engine.logger.logs.map(l => l.type), ['BLOCK', 'DAMAGE', 'DEATH']);
  assert.equal(enemy.stats.hp, 100);
});

test('a pending charge survives into the next round; dead rain owner cannot act after retaliation', t => {
  const hit = damage('hit'), burst = damage('burst');
  const { a, b, engine } = setup(t, { hit, burst });
  a.addBuff({ id: 'charge', trigger: 'BEFORE_ACTION', remainingTriggers: 1, skillIds: ['hit'] }, engine);
  t.mock.method(Formulas, 'determineActionOrder', () => [b]);
  engine.executeTurn(); engine.currentTurn++;
  t.mock.method(Formulas, 'determineActionOrder', () => [a]);
  engine.executeTurn();
  assert.equal(b.stats.hp, 90);
  const ally = entity('ally', 'A'); engine.teamA.push(ally);
  a.stats.hp = 5; b.stats.hp = 60;
  a.addBuff({ id: 'rain', trigger: 'ROUND_START', remainingTriggers: 2, skillIds: ['hit'] }, engine);
  b.passives = [{ condition: 'HP_BELOW', threshold: 0.5,
    action(self, logger, ctx) { ctx.castSkill(self, ['burst'], { targets: [a] }); } }];
  engine.currentTurn++;
  const before = engine.logger.logs.length;
  engine.executeTurn();
  assert.equal(a.isAlive, false);
  assert.equal(a.buffs.length, 0);
  assert.equal(engine.result, null);
  assert.equal(engine.logger.logs.slice(before).filter(l => l.skillId === 'wait').length, 0);
});
