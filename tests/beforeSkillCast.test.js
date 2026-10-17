const test = require('node:test');
const assert = require('node:assert/strict');
const { BattleEngine, Entity, Skill } = require('../src');

// 固定亂數：比較兩場戰鬥時傷害浮動要一致。
function seeded(fn) {
  const original = Math.random;
  let i = 0;
  Math.random = () => [0.5, 0.3, 0.7, 0.1, 0.9][i++ % 5];
  try { return fn(); } finally { Math.random = original; }
}

function make(id, team, { passives = [], stats = {}, skills = [] } = {}) {
  return new Entity({
    id, name: id, team,
    stats: { hp: 1000, atk: 10, def: 0, sta: 10, agi: 0, spd: 10, tec: 100, int: 10, luk: 0, sp: 100, ...stats },
    normalAttack: new Skill({ id: `${id}_attack`, name: 'attack', dealsBasicAttackDamage: true, actions: [{ type: 'DAMAGE' }] }),
    skills, passives
  });
}

const twoHits = new Skill({ id: 'two_hits', name: 'two', actions: [
  { type: 'DAMAGE', power: 2, accuracy: 99 }, { type: 'DAMAGE', power: 2, accuracy: 99 }] });

function duel(passives) {
  const caster = make('caster', 'A', { stats: { spd: 100 } });
  const watcher = make('watcher', 'B', { passives });
  watcher.actionDisabled = true;
  const engine = new BattleEngine([caster], [watcher], { luckEvents: { enabled: false }, maxTurns: 1 });
  return { caster, watcher, engine };
}

test('BEFORE_SKILL_CAST runs on living opponents before the cast with logger and engine', () => {
  const seen = [];
  const { caster, watcher, engine } = duel([{
    trigger: 'BEFORE_SKILL_CAST',
    action: (self, cast, logger, eng) => {
      assert.ok(logger && eng === engine);
      assert.equal(engine.logger.logs.filter(log => log.type === 'DAMAGE').length, 0, '還沒打出任何一擊');
      seen.push({ self, cast: { ...cast } });
    }
  }]);
  twoHits.execute(caster, [caster], [watcher], engine.logger, engine);
  assert.equal(seen.length, 1, '整招只問一次，不是每段');
  assert.equal(seen[0].self, watcher);
  assert.equal(seen[0].cast.caster, caster);
  assert.equal(seen[0].cast.skill, twoHits);
  assert.equal(seen[0].cast.isCounter, false);
  assert.equal(seen[0].cast.isNormalAttack, false);
  assert.equal(seen[0].cast.damageMultiplier, 1);
});

test('damageMultiplier scales every damage action of that cast only', () => {
  const full = seeded(() => {
    const plain = duel([]);
    twoHits.execute(plain.caster, [plain.caster], [plain.watcher], plain.engine.logger, plain.engine);
    twoHits.execute(plain.caster, [plain.caster], [plain.watcher], plain.engine.logger, plain.engine);
    return plain.engine.logger.logs.filter(log => log.type === 'DAMAGE').map(log => log.value);
  });

  let first = true;
  const halved = duel([{
    trigger: 'BEFORE_SKILL_CAST',
    action: (self, cast) => { if (first) cast.damageMultiplier *= 0.5; first = false; }
  }]);
  const values = seeded(() => {
    twoHits.execute(halved.caster, [halved.caster], [halved.watcher], halved.engine.logger, halved.engine);
    twoHits.execute(halved.caster, [halved.caster], [halved.watcher], halved.engine.logger, halved.engine);
    return halved.engine.logger.logs.filter(log => log.type === 'DAMAGE').map(log => log.value);
  });
  assert.equal(values.length, 4);
  assert.deepEqual(values.slice(0, 2), full.slice(0, 2).map(value => Math.floor(value * 0.5)));
  assert.deepEqual(values.slice(2), full.slice(2), '下一招不受影響');
});

test('allies of the caster are not asked, dead opponents are skipped, normal attacks are flagged', () => {
  const asked = [];
  const passive = name => ({ trigger: 'BEFORE_SKILL_CAST', action: (self, cast) => asked.push([name, cast.isNormalAttack]) });
  const caster = make('caster', 'A', { stats: { spd: 100 }, passives: [passive('self')] });
  const friend = make('friend', 'A', { passives: [passive('friend')] });
  const foe = make('foe', 'B', { passives: [passive('foe')] });
  const dead = make('dead', 'B', { passives: [passive('dead')] });
  dead.stats.hp = 0;
  dead.isAlive = false;
  friend.actionDisabled = true;
  foe.actionDisabled = true;
  const engine = new BattleEngine([caster, friend], [foe, dead], { luckEvents: { enabled: false }, maxTurns: 1 });
  engine.executeTurn();
  assert.ok(asked.length > 0);
  assert.ok(asked.every(([name]) => name === 'foe'));
  assert.ok(asked.every(([, isNormalAttack]) => isNormalAttack), '這一槽是普攻');
});

test('without listeners the battle is unchanged and invalid multipliers throw', () => {
  const run = passives => seeded(() => {
    const { engine } = duel(passives);
    engine.executeTurn();
    return engine.logger.logs.map(log => log.message);
  });
  assert.deepEqual(run([]), run([{ trigger: 'BEFORE_SKILL_CAST', action: () => {} }]));
  assert.throws(() => run([{ trigger: 'BEFORE_SKILL_CAST', action: (self, cast) => { cast.damageMultiplier = NaN; } }]),
    /damageMultiplier/);
});
