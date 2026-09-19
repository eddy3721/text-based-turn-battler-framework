const test = require('node:test');
const assert = require('node:assert/strict');
const { Entity, Skill, BattleEngine, Formulas } = require('../src');

const entity = (id, team, stats = {}) => new Entity({ id, name: id, team,
  stats: { hp: 100, maxHp: 100, sp: 10, ...stats } });
const buffSkill = (id, effect, targetType = 'SELF') => new Skill({ id, actions: [{
  type: 'BUFF', targetType, buffs: [{ id, type: 'STAT', duration: 3, stackPolicy: 'refresh', effect }]
}] });

test('skillCastRate defaults to 35%, accepts zero and rejects invalid base probabilities', () => {
  assert.equal(entity('a', 'A').stats.skillCastRate, 0.35);
  for (const rate of [0, 0.8, 1]) {
    const a = entity('a', 'A', { skillCastRate: rate });
    assert.equal(a.getEffectiveStats().skillCastRate, rate);
    assert.equal(new BattleEngine([a], []).getSkillCastChance(a), rate);
  }
  for (const rate of [-0.1, 1.1, NaN, Infinity, '35%']) {
    assert.throws(() => entity('a', 'A', { skillCastRate: rate }), /skillCastRate/);
  }
});

test('real skills increase and reduce the rate; refresh and expiry leave base stats intact', () => {
  const a = entity('a', 'A'), b = entity('b', 'B');
  const engine = new BattleEngine([a], [b]);
  const focus = buffSkill('focus', stats => { stats.skillCastRate += 0.15; });
  const doubt = buffSkill('doubt', stats => { stats.skillCastRate -= 0.1; }, 'ENEMY_SINGLE');
  focus.execute(a, [a], [b], engine.logger, engine);
  assert.equal(engine.getSkillCastChance(a), 0.5);
  a.tickBuffs();
  focus.execute(a, [a], [b], engine.logger, engine);
  assert.equal(a.buffs.length, 1);
  assert.equal(a.buffs[0].duration, 3);
  doubt.execute(b, [b], [a], engine.logger, engine);
  assert.equal(engine.getSkillCastChance(a), 0.4);
  assert.equal(a.stats.skillCastRate, 0.35);
  for (let i = 0; i < 3; i++) a.tickBuffs();
  assert.equal(engine.getSkillCastChance(a), 0.35);
});

test('rate clamps after all STAT effects, then enemy auras apply; invalid effects fail explicitly', () => {
  const a = entity('a', 'A'), b = entity('b', 'B');
  const engine = new BattleEngine([a], [b]);
  const apply = (id, effect) => buffSkill(id, effect).execute(a, [a], [b], engine.logger, engine);
  apply('increase', stats => { stats.skillCastRate += 1; });
  assert.equal(a.getEffectiveStats().skillCastRate, 1);
  apply('decrease', stats => { stats.skillCastRate -= 1; });
  assert.ok(Math.abs(engine.getSkillCastChance(a) - 0.35) < 1e-12);
  apply('exhausted', stats => { stats.skillCastRate -= 2; });
  assert.equal(engine.getSkillCastChance(a), 0);
  a.buffs = [];
  apply('focus', stats => { stats.skillCastRate += 0.15; });
  b.passives = [{ id: 'pressure', enemySkillCastMultiplier: 0.75 }];
  assert.equal(engine.getSkillCastChance(a), 0.375);
  apply('relative', stats => { stats.skillCastRate *= 0.5; });
  assert.equal(engine.getSkillCastChance(a), 0.1875);
  apply('invalid', stats => { stats.skillCastRate = NaN; });
  assert.throws(() => engine.getSkillCastChance(a), /skillCastRate/);
});

test('the lottery reads current buffs; 0% uses normal attack and 100% still requires SP', t => {
  t.mock.method(Math, 'random', () => 0.4);
  const a = entity('a', 'A'), b = entity('b', 'B');
  a.normalAttack = new Skill({ id: 'normal', actions: [{ type: 'TEXT', targetType: 'SELF' }] });
  a.skills = [new Skill({ id: 'active', actions: [{ type: 'TEXT', targetType: 'SELF', spCost: 2 }] })];
  const engine = new BattleEngine([a], [b], { luckEvents: { enabled: false } });
  t.mock.method(Formulas, 'determineActionOrder', () => [a]);
  const act = () => { engine.executeTurn(); return engine.logger.logs.at(-1).skillId; };
  assert.equal(act(), 'normal');
  buffSkill('focus', stats => { stats.skillCastRate += 0.15; }).execute(a, [a], [b], engine.logger, engine);
  assert.equal(act(), 'active');
  buffSkill('silence', stats => { stats.skillCastRate = 0; }).execute(a, [a], [b], engine.logger, engine);
  assert.equal(act(), 'normal');
  a.buffs = [];
  a.stats.skillCastRate = 1;
  assert.equal(act(), 'active');
  a.stats.sp = 0;
  assert.equal(act(), 'normal');
  a.skills = [];
  assert.equal(act(), 'normal');
});
