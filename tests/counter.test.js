const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Entity, Skill, BattleEngine, Formulas } = require('../src');

const strike = (actions = [{ type: 'DAMAGE', hits: 3 }]) => new Skill({ id: 'strike', name: '斬擊', actions });
function setup(t, attack = strike()) {
  t.mock.method(Formulas, 'isHit', () => true);
  t.mock.method(Formulas, 'isCritical', () => false);
  t.mock.method(Formulas, 'calculateDamage', () => 10);
  const make = (id, team) => new Entity({ id, name: id, team,
    stats: { hp: 100, maxHp: 100, sp: 30, atk: 10, spd: 1000, counter: 1 }, normalAttack: strike() });
  const a = make('a', 'A'); const b = make('b', 'B');
  const engine = new BattleEngine([a], [b]);
  const run = () => attack.execute(a, [a], [b], engine.logger, engine);
  return { a, b, engine, run };
}

test('one full parry per move, immediate single reply, remaining hits continue without recursion or buff ticks', t => {
  const { a, b, engine, run } = setup(t);
  b.addBuff({ id: 'test', type: 'STAT', duration: 2 });
  run();
  assert.equal(a.stats.hp, 90);
  assert.equal(b.stats.hp, 80);
  assert.equal(b.stats.sp, 30);
  assert.equal(b.buffs[0].duration, 2);
  assert.equal(b.hasActed, false);
  assert.deepEqual(engine.logger.logs.map(l => l.type), ['COUNTER', 'DAMAGE', 'DAMAGE']);
  assert.equal(engine.logger.logs[0].value, 10);
  assert.equal(engine.logger.logs[0].isNormalAttack, true);
  assert.equal(engine.logger.logs[0].message, 'a使出了 斬擊，但是遭b反擊，受到 10 點傷害！');
});

test('failed roll is not retried in later actions of the same move; misses defer the first roll', t => {
  const attack = strike([{ type: 'DAMAGE' }, { type: 'DAMAGE', hits: 3 }]);
  const { b, engine, run } = setup(t, attack);
  let hit = 0; let rolls = 0;
  t.mock.method(Formulas, 'isHit', () => ++hit !== 1);
  t.mock.method(Formulas, 'isCounter', () => { rolls++; return false; });
  run();
  assert.equal(rolls, 1);
  assert.equal(b.stats.hp, 70);
  assert.equal(engine.logger.logs[0].type, 'MISS');
});

test('lethal reply cancels remaining attack and settles death once', t => {
  const { a, b, engine, run } = setup(t);
  a.stats.hp = 5;
  run();
  assert.equal(b.stats.hp, 100);
  assert.equal(engine.result, 'TEAM_B');
  assert.equal(engine.logger.logs.filter(l => l.type === 'DEATH').length, 1);
});

test('stun prevents counter; absent stat defaults to zero; direct/DOT damage never rolls', t => {
  const { a, b, engine, run } = setup(t);
  b.addBuff({ id: 'stun', type: 'STUN', duration: 2 });
  run();
  assert.equal(b.stats.hp, 70);
  b.buffs = []; delete b.stats.counter;
  run();
  b.stats.counter = 1;
  b.takeDamage(10, engine.logger, { engine });
  assert.equal(a.stats.hp, 100);
  assert.equal(b.stats.hp, 30);
});

test('skill reply pays SP, applies damage-gated effects, and falls back without SP', t => {
  const { a, b, engine, run } = setup(t, strike([{ type: 'DAMAGE' }]));
  b.counterSkill = new Skill({ id: 'disarm', name: '劍神流・剝奪劍', actions: [
    { type: 'DAMAGE', spCost: 12 },
    { type: 'BUFF', requiresDamage: true, buffs: [{ id: 'disarm', type: 'STAT', duration: 2 }] }
  ] });
  run();
  assert.equal(b.stats.sp, 18);
  assert.equal(a.buffs[0].id, 'disarm');
  assert.match(engine.logger.logs[0].message, /以劍神流・剝奪劍反擊/);
  assert.doesNotMatch(engine.logger.logs[0].message, /[「」"']/);
  b.stats.sp = 0; run();
  assert.equal(engine.logger.logs.filter(l => l.type === 'COUNTER').at(-1).skillId, 'basic_counter');
});

test('counter reply cannot miss, but can be blocked or crit; parried damage does not apply gated buff', t => {
  const { a, b, engine, run } = setup(t, strike([
    { type: 'DAMAGE' }, { type: 'BUFF', requiresDamage: true, buffs: [{ id: 'bad', type: 'STAT', duration: 2 }] }
  ]));
  t.mock.method(Formulas, 'isHit', caster => caster === a);
  run(); assert.equal(b.buffs.length, 0); assert.equal(a.stats.hp, 90);
  assert.equal(engine.logger.logs.at(-1).type, 'COUNTER');
  assert.match(engine.logger.logs.at(-1).message, /受到 10 點傷害/);
  assert.doesNotMatch(engine.logger.logs.at(-1).message, /落空/);
  t.mock.method(Formulas, 'isHit', () => true);
  a.passives = [{ trigger: 'BEFORE_DAMAGE', action: (self, hit) => { hit.damage = 0; hit.blocked = true; } }];
  run(); assert.equal(a.stats.hp, 90); assert.equal(engine.logger.logs.at(-1).type, 'COUNTER');
  assert.match(engine.logger.logs.at(-1).message, /反擊被a擋下了/);
  a.passives = []; t.mock.method(Formulas, 'isCritical', () => true);
  run(); assert.equal(a.stats.hp, 75); assert.equal(engine.logger.logs.at(-1).isCrit, true);
  assert.match(engine.logger.logs.at(-1).message, /會心一擊！受到 15 點傷害/);
});

test('AoE independently permits one counter from each living target', t => {
  const attack = strike([{ type: 'DAMAGE', targetType: 'ENEMY_ALL', hits: 2 }]);
  const { a, b, engine } = setup(t, attack);
  const c = new Entity({ id: 'c', name: 'c', team: 'B', stats: { ...b.stats } });
  engine.teamB.push(c);
  attack.execute(a, [a], [b, c], engine.logger, engine);
  assert.equal(a.stats.hp, 80); assert.equal(b.stats.hp, 90); assert.equal(c.stats.hp, 90);
  assert.equal(engine.logger.logs.filter(l => l.type === 'COUNTER').length, 2);
});

test('nested skills share attempts and counter-derived skills cannot counter recursively', t => {
  const child = strike([{ type: 'DAMAGE' }]);
  const wrapper = new Skill({ id: 'wrapper', actions: [{ type: 'CAST_SKILL', skillIds: ['strike'] },
    { type: 'CAST_SKILL', skillIds: ['strike'] }] });
  const { a, b, engine } = setup(t);
  engine.skillResolver = () => child;
  b.passives = [{ trigger: 'AFTER_DAMAGE_DEALT', enabled: (self, hit) => hit.skill.id === 'basic_counter',
    action: (self, hit, logger, ctx) => ctx.castSkill(self, ['strike'], { targets: [hit.target] }) }];
  wrapper.execute(a, [a], [b], engine.logger, engine);
  assert.equal(a.stats.hp, 80); assert.equal(b.stats.hp, 90);
  assert.equal(engine.logger.logs.filter(l => l.type === 'COUNTER').length, 1);
  assert.equal(engine.logger.logs.find(l => l.type === 'COUNTER').value, 20);
  assert.equal(engine.logger.logs.filter(l => l.isCounter && l.type === 'DAMAGE').length, 0);
  assert.equal(engine.counterSource, null);
});

test('a delayed skill created by a counter retains its origin and cannot trigger counter', t => {
  const { a, b, engine, run } = setup(t, strike([{ type: 'DAMAGE' }]));
  b.counterSkill = new Skill({ id: 'delayed', actions: [{ type: 'BUFF', targetType: 'SELF', buffs: [{
    id: 'charge', trigger: 'BEFORE_ACTION', remainingTriggers: 1, skillIds: ['strike']
  }] }] });
  engine.skillResolver = () => strike([{ type: 'DAMAGE' }]);
  run();
  assert.equal(b.buffs[0].counterSource.actorId, 'b');
  engine.triggerBuffs(b, 'BEFORE_ACTION');
  assert.equal(a.stats.hp, 90);
  assert.equal(engine.logger.logs.filter(l => l.type === 'COUNTER').length, 1);
  assert.equal(engine.logger.logs.at(-1).isCounter, true);
  assert.equal(engine.counterSource, null);
});

test('counter context and call stack unwind if a reply throws', t => {
  const { b, engine, run } = setup(t);
  b.counterSkill = new Skill({ id: 'broken', actions: [{ type: 'HEAL', stat: 'unknown' }] });
  assert.throws(run, /unknown/);
  assert.equal(engine.counterSource, null); assert.equal(engine.skillCallStack.length, 0);
});
