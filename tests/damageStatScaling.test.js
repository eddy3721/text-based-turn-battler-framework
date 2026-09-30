const test = require('node:test');
const assert = require('node:assert/strict');
const { Entity, Skill } = require('../src');

const logger = () => ({ logs: [], addLog(log) { this.logs.push(log); } });
const entity = (id, stats = {}) => new Entity({
  id, name: id,
  stats: {
    hp: 1000, maxHp: 1000, sp: 100, maxSp: 100,
    atk: 10, int: 100, def: 0, hit: 100, eva: 0, spd: 1,
    cri: 0, criDmg: 1.5, counter: 0,
    ...stats
  }
});

test('DAMAGE action.stat uses the requested effective caster stat', t => {
  t.mock.method(Math, 'random', () => 0.5);
  const caster = entity('mage');
  const target = entity('target');
  const magic = new Skill({ id: 'magic', actions: [{ type: 'DAMAGE', stat: 'int', power: 1 }] });
  const log = logger();

  magic.execute(caster, [caster], [target], log);

  assert.equal(log.logs[0].value, 100);
  assert.equal(target.stats.hp, 900);
});

test('DAMAGE keeps atk as its default and rejects unknown stat names', t => {
  t.mock.method(Math, 'random', () => 0.5);
  const caster = entity('fighter');
  const target = entity('target');
  const physical = new Skill({ id: 'physical', actions: [{ type: 'DAMAGE', power: 1 }] });
  physical.execute(caster, [caster], [target], logger());
  assert.equal(target.stats.hp, 990);

  const broken = new Skill({ id: 'broken', actions: [{ type: 'DAMAGE', stat: 'magic' }] });
  assert.throws(() => broken.execute(caster, [caster], [target], logger()), /unknown attacker stat "magic"/);
});

test('HEAL action.stat accepts a weight table that sums several caster stats', () => {
  const caster = entity('medic', { atk: 40, int: 100 });
  const target = entity('patient', { hp: 100 });
  const blended = new Skill({ id: 'blended', actions: [
    { type: 'HEAL', targetType: 'ALLY_SINGLE', stat: { atk: 1, int: 0.5 }, power: 2 }
  ] });
  const log = logger();

  blended.execute(caster, [target], [], log);

  assert.equal(log.logs[0].value, (40 * 1 + 100 * 0.5) * 2);
  assert.equal(target.stats.hp, 280);

  const broken = new Skill({ id: 'broken', actions: [
    { type: 'HEAL', targetType: 'ALLY_SINGLE', stat: { atk: 1, magic: 1 } }
  ] });
  assert.throws(() => broken.execute(caster, [target], [], logger()), /unknown caster stat "magic"/);
  const nan = new Skill({ id: 'nan', actions: [
    { type: 'HEAL', targetType: 'ALLY_SINGLE', stat: { atk: 'much' } }
  ] });
  assert.throws(() => nan.execute(caster, [target], [], logger()), /non-numeric weight/);
});
