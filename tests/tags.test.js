const test = require('node:test');
const assert = require('node:assert/strict');
const { Entity, Skill, Buff, BattleEngine, Formulas } = require('../src');

function duel(t, passives = []) {
  t.mock.method(Formulas, 'isHit', () => true);
  t.mock.method(Formulas, 'isCounter', () => false);
  t.mock.method(Formulas, 'isCritical', () => false);
  const attacker = new Entity({ id: 'a', name: '甲', team: 'A',
    stats: { hp: 1000, atk: 50, def: 0, spd: 10, sp: 100 } });
  const target = new Entity({ id: 'b', name: '乙', team: 'B',
    stats: { hp: 1000, atk: 10, def: 0, spd: 10, sp: 100 }, passives });
  const engine = new BattleEngine([attacker], [target], { luckEvents: { enabled: false } });
  return { attacker, target, engine };
}

function recorder(trigger) {
  const seen = [];
  return { seen, passive: { id: `record_${trigger}`, trigger, action: (self, hit) => { seen.push(hit.tags); } } };
}

test('skill and action tags merge into hit.tags without duplicates', t => {
  const { seen, passive } = recorder('BEFORE_DAMAGE');
  const { attacker, target, engine } = duel(t, [passive]);
  const skill = new Skill({ id: 'fire_blast', tags: ['fire', 'spell'], actions: [
    { type: 'DAMAGE', power: 1, tags: ['aoe', 'fire'] },
    { type: 'DAMAGE', power: 1 }
  ] });
  skill.execute(attacker, [attacker], [target], engine.logger, engine);
  assert.deepEqual(seen, [['fire', 'spell', 'aoe'], ['fire', 'spell']]);
  assert.ok(Object.isFrozen(seen[0]));
});

test('untagged damage of every kind reports an empty array, never undefined', t => {
  const { seen, passive } = recorder('BEFORE_DAMAGE');
  const { attacker, target, engine } = duel(t, [passive]);
  new Skill({ id: 'plain', actions: [{ type: 'DAMAGE' }] })
    .execute(attacker, [attacker], [target], engine.logger, engine);
  target.takeDamage(5, engine.logger, { source: 'ENVIRONMENT' });
  assert.deepEqual(seen, [[], []]);
});

test('a DOT carries its buff tags into the damage it deals', t => {
  const { seen, passive } = recorder('AFTER_DAMAGE_RECEIVED');
  const { attacker, target, engine } = duel(t, [passive]);
  new Skill({ id: 'ignite', actions: [
    { type: 'BUFF', buffs: [{ id: 'burn', name: '燒傷', type: 'DOT', value: 7, duration: 2, tags: ['fire'] }] }
  ] }).execute(attacker, [attacker], [target], engine.logger, engine);
  target.buffs[0].onPreTurn(target, engine.logger, engine);
  assert.deepEqual(seen, [['fire']]);
  assert.equal(target.stats.hp, 993);
  // Buff 本身也能直接帶標籤建立。
  assert.deepEqual(new Buff({ id: 'poison', type: 'DOT', value: 1, duration: 1, tags: ['poison'] }).tags, ['poison']);
});

test('misses expose the attack tags to the defender evasion hooks', t => {
  const seen = [];
  const { attacker, target, engine } = duel(t, [{ id: 'watch', trigger: 'ON_EVADE',
    action: (self, evasion) => { seen.push(evasion.tags); } }]);
  Formulas.isHit.mock.mockImplementation(() => false);
  new Skill({ id: 'water_bullet', tags: ['water'], actions: [{ type: 'DAMAGE' }] })
    .execute(attacker, [attacker], [target], engine.logger, engine);
  assert.deepEqual(seen, [['water']]);
});

test('tags are validated strictly and default to a shared empty array', () => {
  assert.deepEqual(new Skill({ id: 'none' }).tags, []);
  assert.deepEqual(new Buff({ id: 'none', type: 'STAT', duration: 1 }).tags, []);
  for (const bad of ['fire', [''], [1], [null], {}]) {
    assert.throws(() => new Skill({ id: 'bad', tags: bad }), /tags/);
    assert.throws(() => new Buff({ id: 'bad', type: 'DOT', duration: 1, tags: bad }), /tags/);
    assert.throws(() => new Skill({ id: 'bad', actions: [{ type: 'DAMAGE', tags: bad }] }), /tags/);
  }
  // 段落標籤只給傷害段。
  assert.throws(() => new Skill({ id: 'bad', actions: [{ type: 'HEAL', tags: ['fire'] }] }), /DAMAGE/);
});

test('tagging does not change damage, hit rolls or the random sequence', t => {
  const run = tags => {
    let calls = 0;
    const random = Math.random;
    Math.random = () => { calls++; return 0.37; };
    try {
      const attacker = new Entity({ id: 'a', name: '甲', team: 'A', stats: { hp: 100, atk: 40, def: 0, spd: 10, sp: 50 } });
      const target = new Entity({ id: 'b', name: '乙', team: 'B', stats: { hp: 1000, atk: 10, def: 20, spd: 10, sp: 50 } });
      const engine = new BattleEngine([attacker], [target], { luckEvents: { enabled: false } });
      new Skill({ id: 's', tags, actions: [{ type: 'DAMAGE', hits: 3 }] })
        .execute(attacker, [attacker], [target], engine.logger, engine);
      return { hp: target.stats.hp, calls };
    } finally { Math.random = random; }
  };
  assert.deepEqual(run(undefined), run(['fire', 'spell']));
});
