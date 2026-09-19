const test = require('node:test');
const assert = require('node:assert/strict');
const { Entity, BattleEngine, Formulas } = require('../src');

test('small accidents stay unchanged; high luck damage increases with diminishing returns', () => {
  for (const [tier, scale] of [['PURPLE', 1.2], ['RED', 2.4]]) {
    for (const gap of [0, 1, 100, 200]) assert.equal(Formulas.softenLuckDamage(gap * scale, tier), gap * scale);
    const values = [200, 400, 600, 800].map(gap => Formulas.softenLuckDamage(gap * scale, tier));
    assert.ok(values[1] > values[0]);
    assert.ok(values[2] - values[1] < values[1] - values[0]);
    assert.ok(values[3] - values[2] < values[2] - values[1]);
    assert.ok(Formulas.softenLuckDamage(10000 * scale, tier) > values[3]);
  }
});

test('all teams and inanimate entities use the same curve, log HP loss and cancel actions', t => {
  for (const team of ['A', 'B']) for (const actionDisabled of [false, true]) {
    const make = (id, side, luk) => new Entity({ id, name: id, team: side,
      actionDisabled, stats: { hp: 10000, maxHp: 10000, sp: 100, maxSp: 100, luk } });
    const victim = make('victim', team, 0), lucky = make('lucky', team === 'A' ? 'B' : 'A', 1000);
    const engine = new BattleEngine(team === 'A' ? [victim] : [lucky], team === 'A' ? [lucky] : [victim]);
    const rolls = [0, 0.5, 0];
    t.mock.method(Math, 'random', () => { assert.ok(rolls.length); return rolls.shift(); });
    assert.equal(engine.tryLuckEvent(victim), true);
    const event = engine.logger.logs.find(log => log.type === 'LUCK_EVENT');
    assert.equal(event.value, 1252);
    assert.equal(victim.stats.hp, 10000 - 1252);
    assert.equal(victim.stats.sp, 100);
    assert.equal(event.actionCancelled, true);
    assert.equal(rolls.length, 0);
  }
});
