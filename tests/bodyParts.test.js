const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Entity, Skill, Buff, BattleEngine, Formulas } = require('../src');
const parts = [{ id: 'head', name: '頭部', maxDurability: 20 }, { id: 'tail', name: '尾巴', maxDurability: 30 }];
const make = (id, extra = {}) => new Entity({ id, name: id, team: id === 'a' ? 'A' : 'B',
  stats: { hp: 100, maxHp: 100, atk: 10, sp: 100, maxSp: 100, spd: 10 }, ...extra });
const log = () => ({ logs: [], addLog(entry) { this.logs.push(entry); } });
function setup(t, extra = {}) {
  t.mock.method(Formulas, 'isHit', () => true);
  t.mock.method(Formulas, 'isCritical', () => false);
  t.mock.method(Formulas, 'isCounter', () => false);
  t.mock.method(Formulas, 'calculateDamage', () => 10);
  const a = make('a');
  const b = make('b', { parts, ...extra });
  const engine = new BattleEngine([a], [b], { luckEvents: { enabled: false } });
  const cast = (actions = [{ type: 'DAMAGE' }]) => new Skill({ id: 'hit', actions }).execute(a, [a], [b], engine.logger, engine);
  return { a, b, engine, cast };
}

test('parts validate configuration and clone mutable durability per entity', () => {
  const a = make('a', { parts });
  const b = make('b', { parts });
  a.parts[0].durability = 0;
  assert.equal(b.parts[0].durability, 20);
  assert.equal(parts[0].durability, undefined);
  for (const invalid of [null, {}, [{ id: 'x', maxDurability: 0 }], [{ id: 'x', maxDurability: 1.2 }],
    [{ id: 'x', maxDurability: Infinity }], [{ id: 'x', maxDurability: 2 }, { id: 'x', maxDurability: 3 }]]) {
    assert.throws(() => make('a', { parts: invalid }));
  }
  for (const partDamageMultiplier of [-1, Infinity, NaN, '2']) {
    assert.throws(() => new Skill({ id: 'bad', actions: [{ type: 'DAMAGE', partDamageMultiplier }] }));
  }
});

test('no parts consumes no extra randomness, and exposes actual HP loss on overkill', t => {
  const logger = log();
  const a = make('a');
  const observed = [];
  const b = make('b', { passives: [{ trigger: 'AFTER_DAMAGE_RECEIVED', action: (_, hit) => observed.push(hit) }] });
  t.mock.method(Math, 'random', () => assert.fail('no extra random draw'));
  const hit = b.takeDamage(150, logger, { caster: a, action: { type: 'DAMAGE' } });
  assert.equal(hit.damage, 150);
  assert.equal(hit.actualDamage, 100);
  assert.equal(hit.lethal, true);
  assert.equal(hit.source, 'ATTACK');
  assert.equal(hit.partId, undefined);
  assert.equal(observed.length, 1);
  assert.equal(b.takeDamage(5, logger).actualDamage, 0);
});

test('receive is after each logged hit, before healing/HP reactions, and settles once', t => {
  const seen = [];
  const { a, b, engine, cast } = setup(t, { passives: [
    { trigger: 'AFTER_DAMAGE_RECEIVED', enabled: (_, hit) => !hit.lethal, action: (self, hit, logger) => {
      seen.push({ actual: hit.actualDamage, last: logger.logs.at(-1).type, hp: self.stats.hp });
      logger.addLog({ type: 'RECEIVED', message: 'receive' });
    } },
    { condition: 'HP_BELOW', threshold: 0.9, action: self => { self.stats.hp += 5; } }
  ] });
  cast();
  assert.deepEqual(seen, [{ actual: 10, last: 'DAMAGE', hp: 90 }]);
  assert.equal(b.stats.hp, 95);
  const hit = b.takeDamage(3, engine.logger, { deferReactions: true, caster: a, action: { type: 'DAMAGE' } });
  assert.equal(seen.length, 1);
  engine.logger.addLog({ type: 'DAMAGE' });
  b.finishDamage(hit, engine.logger, engine);
  b.finishDamage(hit, engine.logger, engine);
  assert.equal(seen.length, 2);
});

test('multi-hit attacks select a new uniform random part per hit and break only once', t => {
  const broken = [];
  const { b, engine, cast } = setup(t, { passives: [{ trigger: 'ON_PART_BREAK', action: (_, hit) => broken.push(hit.partId) }] });
  const samples = [0, 0.999, 0];
  t.mock.method(Math, 'random', () => samples.shift() ?? 0);
  cast([{ type: 'DAMAGE', targetType: 'ENEMY_ALL', hits: 3 }]);
  assert.deepEqual(engine.logger.logs.filter(x => x.type === 'DAMAGE').map(x => x.partId), ['head', 'tail', 'head']);
  assert.deepEqual(broken, ['head']);
  assert.equal(b.stats.hp, 70);
  assert.equal(b.parts[0].broken, true);
  assert.equal(b.parts[1].durability, 20);
  assert.ok(engine.logger.logs.some(x => x.message?.includes('頭部')));
  cast([{ type: 'DAMAGE', targetType: 'ENEMY_ALL' }]);
  assert.equal(b.stats.hp, 60);
  assert.equal(engine.logger.logs.at(-1).partDamage, 0);
  assert.equal(engine.logger.logs.filter(x => x.type === 'PART_BREAK').length, 1);
});

test('part damage multiplier is independent of HP damage and capped at remaining durability', t => {
  const { b, cast } = setup(t);
  t.mock.method(Math, 'random', () => 0);
  cast([{ type: 'DAMAGE', partDamageMultiplier: 0 }]);
  assert.equal(b.stats.hp, 90);
  assert.equal(b.parts[0].durability, 20);
  cast([{ type: 'DAMAGE', partDamageMultiplier: 3 }]);
  assert.equal(b.stats.hp, 80);
  assert.equal(b.parts[0].durability, 0);
});

test('lethal part damage uses actual HP loss, not overkill', t => {
  const { a, b, engine } = setup(t);
  t.mock.method(Math, 'random', () => 0);
  b.stats.hp = 5;
  const hit = b.takeDamage(100, engine.logger, { caster: a, action: { type: 'DAMAGE', partDamageMultiplier: 2 }, engine });
  assert.equal(hit.actualDamage, 5);
  assert.equal(hit.partDamage, 10);
  assert.equal(b.parts[0].broken, false);
});

test('full blocks and misses do not damage parts or fire receive; partial blocks count actual loss', t => {
  const seen = [];
  const { b, engine, cast } = setup(t, { passives: [
    { trigger: 'BEFORE_DAMAGE', action: (_, hit) => { hit.damage = 0; hit.blocked = true; } },
    { trigger: 'AFTER_DAMAGE_RECEIVED', action: (_, hit) => seen.push(hit.actualDamage) }
  ] });
  t.mock.method(Math, 'random', () => 0);
  cast();
  assert.equal(b.parts[0].durability, 20);
  assert.equal(engine.logger.logs.at(-1).partDurability, 20);
  t.mock.method(Formulas, 'isHit', () => false);
  cast();
  assert.deepEqual(seen, []);
  t.mock.method(Formulas, 'isHit', () => true);
  b.passives[0].action = (_, hit) => { hit.damage *= 0.5; hit.blocked = true; };
  cast();
  assert.deepEqual(seen, [5]);
  assert.equal(b.parts[0].durability, 15);
});

test('DOT, environmental and self damage trigger receive without picking a part', t => {
  const sources = [];
  const { b, engine } = setup(t, { passives: [{ trigger: 'AFTER_DAMAGE_RECEIVED', action: (_, hit) => {
    sources.push(hit.source);
    assert.equal(hit.partId, undefined);
  } }] });
  t.mock.method(Math, 'random', () => assert.fail('non-attack damage must not roll a part'));
  new Buff({ id: 'poison', name: '毒', type: 'DOT', value: 3, duration: 1 }).onPreTurn(b, engine.logger, engine);
  b.takeDamage(3, engine.logger, { source: 'LUCK_EVENT', engine });
  b.takeDamage(3, engine.logger, { caster: b, action: { type: 'DAMAGE' }, engine });
  b.heal(5, engine.logger, { engine });
  assert.deepEqual(sources, ['DOT', 'LUCK_EVENT', 'ATTACK']);
  assert.equal(b.parts[0].durability, 20);
});

test('counter metadata and part-break/receive announcements survive counter buffering', t => {
  const { a, b, engine, cast } = setup(t);
  a.parts = make('a', { parts: [{ id: 'head', maxDurability: 5 }] }).parts;
  let received = 0;
  a.passives.push({ trigger: 'AFTER_DAMAGE_RECEIVED', action: (_, hit, logger) => {
    assert.equal(hit.isCounter, true);
    received++;
    logger.addLog({ type: 'BOSS_DIALOGUE', message: 'hit received' });
  } });
  t.mock.method(Formulas, 'isCounter', () => true);
  cast();
  assert.equal(received, 1);
  assert.equal(a.stats.hp, 90);
  assert.equal(b.stats.hp, 100);
  assert.deepEqual(engine.logger.logs.map(x => x.type), ['COUNTER', 'PART_BREAK', 'BOSS_DIALOGUE']);
  assert.equal(engine.logger.logs[0].partHits[0].partId, 'head');
  assert.equal(engine.logger.logs[0].partHits[0].partDamage, 5);
});

test('breaking a part can change stats and the next hit observes it', t => {
  const { b, cast, engine } = setup(t, { parts: [{ id: 'shell', maxDurability: 10 }], passives: [
    { trigger: 'ON_PART_BREAK', enabled: self => self.isAlive, action: self => { self.stats.def = 0; } }
  ] });
  b.stats.def = 10;
  t.mock.method(Formulas, 'calculateDamage', (_, target) => target.stats.def === 0 ? 20 : 10);
  cast([{ type: 'DAMAGE', hits: 2 }]);
  assert.deepEqual(engine.logger.logs.filter(x => x.type === 'DAMAGE').map(x => x.value), [10, 20]);
  assert.equal(b.stats.hp, 70);
});

test('a receive reaction that kills the attacker stops remaining multi-hit and AoE actions', t => {
  const { a, b, cast, engine } = setup(t, { passives: [
    { trigger: 'AFTER_DAMAGE_RECEIVED', action: (_, hit, logger, battle) => hit.caster.takeDamage(1000, logger, { engine: battle }) }
  ] });
  const other = make('c', { parts });
  engine.teamB.push(other);
  cast([{ type: 'DAMAGE', hits: 3, targetType: 'ENEMY_ALL' }]);
  assert.equal(a.isAlive, false);
  assert.equal(b.stats.hp, 90);
  assert.equal(other.stats.hp, 100);
  assert.equal(engine.result, 'TEAM_B');
});

test('AoE chooses independently for each living target', t => {
  const { a, b, engine } = setup(t);
  const c = make('c', { parts });
  const dead = make('dead', { parts });
  dead.takeDamage(100, log());
  engine.teamB.push(c, dead);
  const samples = [0, 0.99];
  t.mock.method(Math, 'random', () => samples.shift());
  new Skill({ id: 'aoe', actions: [{ type: 'DAMAGE', targetType: 'ENEMY_ALL' }] })
    .execute(a, [a], [b, c, dead], engine.logger, engine);
  assert.equal(b.parts[0].durability, 10);
  assert.equal(c.parts[1].durability, 20);
  assert.equal(dead.parts[0].durability, 20);
});
