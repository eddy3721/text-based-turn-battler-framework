const test = require('node:test');
const assert = require('node:assert/strict');
const { BattleEngine, Entity, Skill, Formulas } = require('../src');

const stats = { hp: 10000, maxHp: 10000, atk: 100, def: 20, sta: 100, agi: 10, spd: 10,
  tec: 10, int: 10, luk: 0 };
const entity = (id, team, extra = {}) => new Entity({ id, name: id, team, stats: { ...stats, ...extra },
  normalAttack: null, skills: [], passives: [] });

function setup(t, { hit = () => true, counter = () => false } = {}) {
  const caster = entity('caster', 'A');
  const ally = entity('ally', 'A');
  const enemy = entity('enemy', 'B');
  const other = entity('other', 'B');
  t.mock.method(Formulas, 'isHit', hit);
  t.mock.method(Formulas, 'isCounter', counter);
  t.mock.method(Formulas, 'isCritical', () => false);
  const engine = new BattleEngine([caster, ally], [enemy, other], { luckEvents: { enabled: false } });
  const cast = (skill, options = {}) => skill.execute(caster, engine.teamA, engine.teamB, engine.logger, engine, options);
  return { caster, ally, enemy, other, engine, cast };
}

test('execute reports, per target, how many hits landed and how much HP was lost', t => {
  const { enemy, cast } = setup(t);
  const skill = new Skill({ id: 'triple', name: 'triple', actions: [{ type: 'DAMAGE', power: 1, hits: 3 }] });
  const report = cast(skill, { targets: [enemy] });
  assert.equal(report.skill, skill);
  assert.deepEqual(report.landed, [enemy]);
  const [entry] = report.targets;
  assert.equal(entry.target, enemy);
  assert.equal(entry.attempts, 3);
  assert.equal(entry.landed, 3);
  assert.equal(entry.missed, 0);
  assert.equal(entry.actualDamage, enemy.stats.maxHp - enemy.stats.hp);
  assert.equal(entry.defeated, false);
});

test('a missed target is reported but is not in landed', t => {
  const { enemy, other, cast } = setup(t, { hit: (caster, target) => target.id !== 'other' });
  const skill = new Skill({ id: 'sweep', name: 'sweep', actions: [{ type: 'DAMAGE', targetType: 'ENEMY_ALL', power: 1 }] });
  const report = cast(skill);
  assert.deepEqual(report.landed, [enemy]);
  const missed = report.targets.find(entry => entry.target === other);
  assert.equal(missed.attempts, 1);
  assert.equal(missed.missed, 1);
  assert.equal(missed.landed, 0);
});

test('a hit intercepted by a counter counts as countered, not landed', t => {
  const { enemy, cast } = setup(t, { counter: () => true });
  enemy.counterSkill = new Skill({ id: 'reply', name: 'reply', actions: [{ type: 'DAMAGE', power: 1 }] });
  const skill = new Skill({ id: 'poke', name: 'poke', actions: [{ type: 'DAMAGE', power: 1 }] });
  const report = cast(skill, { targets: [enemy] });
  const [entry] = report.targets;
  assert.equal(entry.countered, 1);
  assert.equal(entry.landed, 0);
  assert.deepEqual(report.landed, []);
});

test('damage swallowed by a shield still lands', t => {
  const { enemy, engine, cast } = setup(t);
  enemy.addBuff({ id: 'barrier', name: 'barrier', type: 'STAT', duration: 3, shield: 100000 }, engine);
  const skill = new Skill({ id: 'poke', name: 'poke', actions: [{ type: 'DAMAGE', power: 1 }] });
  const report = cast(skill, { targets: [enemy] });
  const [entry] = report.targets;
  assert.equal(entry.landed, 1);
  assert.equal(entry.actualDamage, 0);
  assert.ok(entry.shieldAbsorbed > 0);
  assert.deepEqual(report.landed, [enemy]);
});

test('a target that falls during the cast is marked defeated', t => {
  const { enemy, cast } = setup(t);
  enemy.stats.hp = 1;
  const report = cast(new Skill({ id: 'poke', name: 'poke', actions: [{ type: 'DAMAGE', power: 1 }] }), { targets: [enemy] });
  assert.equal(report.targets[0].defeated, true);
});

test('a disabled caster gets an empty report', t => {
  const { caster, enemy, cast } = setup(t);
  caster.actionDisabled = true;
  const report = cast(new Skill({ id: 'poke', name: 'poke', actions: [{ type: 'DAMAGE', power: 1 }] }), { targets: [enemy] });
  assert.deepEqual(report.targets, []);
  assert.deepEqual(report.landed, []);
});

test('under a side swap the report names who was actually struck', t => {
  const { caster, ally, enemy, engine } = setup(t);
  const skill = new Skill({ id: 'poke', name: 'poke', actions: [{ type: 'DAMAGE', power: 1 }] });
  let report;
  engine.withActionTargetOverride(caster, { swapSides: true, excludeSelf: true },
    () => { report = skill.execute(caster, engine.teamA, engine.teamB, engine.logger, engine, { targets: [enemy] }); });
  assert.deepEqual(report.landed, [ally]);
});
