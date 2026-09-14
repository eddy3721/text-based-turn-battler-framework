const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Entity, BattleEngine } = require('../src');
const Formulas = require('../src/utils/Formulas');
const { templates, randomLuckMessage } = require('../src/utils/LuckEvents');
const unit = (id, team, luk = 0) => new Entity({ id, name: id, team,
  stats: { hp: 1000, maxHp: 1000, luk, sp: 20, spd: 10 } });

test('luck curve, exclusive boundaries, caps and effective stats', () => {
  const a = unit('a', 'A'), b = unit('b', 'B', 100);
  const p = Formulas.luckEventProfile(a, b);
  assert.equal(p.purpleChance, 0.15); assert.equal(p.redChance, 0.05);
  assert.equal(p.purpleDamage, 120); assert.equal(p.redDamage, 240);
  assert.equal(Formulas.rollLuckEvent(p, 0), 'RED');
  assert.equal(Formulas.rollLuckEvent(p, 0.05), 'PURPLE');
  assert.equal(Formulas.rollLuckEvent(p, 0.20), null);
  assert.equal(Formulas.rollLuckEvent(Formulas.luckEventProfile(b, a), 0), null);
  a.addBuff({ id: 'luck', type: 'STAT', duration: 2, effect: s => { s.luk += 100; } });
  assert.equal(Formulas.luckEventProfile(a, b).gap, 0);
  b.stats.luk = 1e9;
  const cap = Formulas.luckEventProfile(a, b);
  assert.ok(cap.purpleChance < 0.3 && cap.redChance < 0.1);
});

test('damage is independent of HP, grows beyond normal hits and rounds down with a minimum', t => {
  const a = unit('a', 'A'), b = unit('b', 'B', 1000);
  b.stats.atk = 200;
  t.mock.method(Math, 'random', () => 0.5);
  const p = Formulas.luckEventProfile(a, b);
  assert.equal(p.purpleDamage, 1200); assert.equal(p.redDamage, 2400);
  assert.ok(p.purpleDamage > Formulas.calculateDamage(b, a));
  a.stats.hp = 1; a.stats.maxHp = 100000;
  assert.deepEqual(Formulas.luckEventProfile(a, b), p);
  b.stats.luk = 10000;
  assert.equal(Formulas.luckEventProfile(a, b).redDamage, 24000);
  b.stats.luk = 1;
  assert.equal(Formulas.applyDamageVariance(Formulas.luckEventProfile(a, b).purpleDamage), 1);
  assert.equal(Formulas.applyDamageVariance(Formulas.luckEventProfile(a, b).redDamage), 2);
  b.stats.luk = 3;
  assert.equal(Formulas.applyDamageVariance(Formulas.luckEventProfile(a, b).purpleDamage), 3);
  assert.equal(Formulas.applyDamageVariance(Formulas.luckEventProfile(a, b).redDamage), 7);
});

test('luck damage uses normal damage variance and logs the final rolled damage', t => {
  for (const [tier, eventRoll, scale] of [['PURPLE', 0.1, 1.2], ['RED', 0, 2.4]]) {
    for (const varianceRoll of [0, 0.5, 0.999999]) {
      const a = unit('a', 'A'), b = unit('b', 'B', 101);
      const engine = new BattleEngine([a], [b]);
      const rolls = [eventRoll, varianceRoll, 0];
      t.mock.method(Math, 'random', () => {
        assert.ok(rolls.length, 'unexpected random draw');
        return rolls.shift();
      });
      assert.equal(engine.tryLuckEvent(a), true);
      const expected = Math.floor(101 * scale * (0.9 + varianceRoll * 0.2));
      const log = engine.logger.logs[0];
      assert.equal(log.tier, tier); assert.equal(log.value, expected);
      assert.equal(a.stats.hp, 1000 - expected);
      assert.ok(log.message.includes(`${expected} 點傷害`));
      assert.equal(rolls.length, 0);
      b.stats.atk = 101 * scale;
      t.mock.method(Math, 'random', () => varianceRoll);
      assert.equal(Formulas.calculateDamage(b, a), expected);
    }
  }
});

test('failed luck event does not draw damage variance or a message', t => {
  let draws = 0;
  t.mock.method(Math, 'random', () => { draws++; return 0.9; });
  const a = unit('a', 'A'), b = unit('b', 'B', 100);
  assert.equal(new BattleEngine([a], [b]).tryLuckEvent(a), false);
  assert.equal(draws, 1);
});

test('event consumes slot, ticks buffs, preserves SP and opening skill until next action', t => {
  const a = unit('a', 'A'), b = unit('b', 'B', 100);
  let casts = 0;
  a.openingSkill = { canCast: () => true, execute: () => { casts++; } };
  a.addBuff({ id: 'buff', type: 'STAT', duration: 3 });
  const engine = new BattleEngine([a], [b]);
  t.mock.method(Formulas, 'determineActionOrder', () => [a]);
  t.mock.method(Math, 'random', () => 0.05);
  engine.executeTurn();
  assert.equal(a.stats.hp, 891); assert.equal(a.stats.sp, 20);
  assert.equal(a.hasActed, false); assert.equal(casts, 0);
  assert.equal(a.buffs[0].duration, 2);
  assert.equal(engine.logger.logs.filter(l => l.type === 'LUCK_EVENT').length, 1);
  t.mock.method(Math, 'random', () => 0.9);
  engine.executeTurn();
  assert.equal(casts, 1); assert.equal(a.hasActed, true);
});

test('disabled, stunned, equal luck and no living enemies never trigger', t => {
  t.mock.method(Math, 'random', () => 0);
  const a = unit('a', 'A'), b = unit('b', 'B', 100);
  assert.equal(new BattleEngine([a], [b], { luckEvents: { enabled: false } }).tryLuckEvent(a), false);
  const engine = new BattleEngine([a], [b]);
  a.addBuff({ id: 'stun', type: 'STUN', duration: 1 });
  assert.equal(engine.tryLuckEvent(a), false);
  a.buffs = []; a.stats.luk = 100;
  assert.equal(engine.tryLuckEvent(a), false);
  a.stats.luk = 0; b.isAlive = false;
  assert.equal(engine.tryLuckEvent(a), false);
});

test('environment damage respects mitigation and HP passives without attacker reactions', t => {
  t.mock.method(Math, 'random', () => 0);
  const a = unit('a', 'A'), b = unit('b', 'B', 100);
  let lowHp = 0;
  a.stats.hp = 150;
  a.passives = [
    { trigger: 'BEFORE_DAMAGE', action: (_, hit) => { assert.equal(hit.source, 'LUCK_EVENT'); hit.damage /= 2; } },
    { condition: 'HP_BELOW', threshold: 0.1, action: () => { lowHp++; } }
  ];
  b.passives = [{ trigger: 'AFTER_DAMAGE_DEALT', action: () => assert.fail('environment has no attacker') }];
  const engine = new BattleEngine([a], [b]);
  assert.equal(engine.tryLuckEvent(a), true);
  assert.equal(a.stats.hp, 42); assert.equal(lowHp, 1);
  assert.equal(engine.logger.logs[0].value, 108);
  a.passives = [{ trigger: 'BEFORE_DAMAGE', action: (_, hit) => { hit.damage = 0; } }];
  assert.equal(engine.tryLuckEvent(a), true);
  assert.equal(engine.logger.logs.at(-1).value, 0);
});

test('lethal red event logs before death and settles victory', t => {
  t.mock.method(Math, 'random', () => 0);
  const a = unit('a', 'A'), b = unit('b', 'B', 100);
  a.stats.hp = 50;
  const engine = new BattleEngine([a], [b]);
  assert.equal(engine.tryLuckEvent(a), true);
  assert.equal(a.stats.hp, 0); assert.equal(engine.result, 'TEAM_B');
  assert.deepEqual(engine.logger.logs.slice(0, 2).map(l => l.type), ['LUCK_EVENT', 'DEATH']);
});

test('multiplayer selects one living opponent and every template has no tier label', t => {
  const a = unit('a', 'A'), b = unit('b', 'B'), c = unit('c', 'B', 100);
  const dead = unit('dead', 'B', 1000); dead.isAlive = false;
  const engine = new BattleEngine([a], [b, c, dead]);
  const rolls = [0.75, 0, 0.5, 0];
  t.mock.method(Math, 'random', () => rolls.shift());
  engine.tryLuckEvent(a);
  assert.equal(engine.logger.logs.filter(log => log.type === 'LUCK_EVENT').length, 1);
  assert.equal(engine.logger.logs[0].opponentId, 'c');
  for (const tier of ['PURPLE', 'RED']) {
    templates[tier].forEach((_, i) => {
      t.mock.method(Math, 'random', () => (i + 0.5) / templates[tier].length);
      const log = randomLuckMessage(tier, '$&{damage}', 42);
      assert.ok(log.message.includes('$&{damage}'));
      assert.ok(log.message.includes('42'));
      assert.doesNotMatch(log.message, /紫幸|紅幸/);
    });
  }
});
