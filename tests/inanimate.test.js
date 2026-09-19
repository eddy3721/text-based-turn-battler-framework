const test = require('node:test');
const assert = require('node:assert/strict');
const { Entity, Skill, BattleEngine, Formulas } = require('../src');
const make = (id, team, extra = {}) => new Entity({ id, name: id, team,
  stats: { hp: 1000, maxHp: 1000, atk: 40, def: 0, sp: 0, spd: 10,
    hit: 100, eva: 0, cri: 0, counter: 0, luk: 0 }, ...extra });
const logger = () => ({ logs: [], addLog(log) { this.logs.push(log); } });

test('disabled entities cannot cast or counter, but remain eligible for luck and buff ticks', t => {
  t.mock.method(Math, 'random', () => 0);
  const attack = new Skill({ id: 'hit', actions: [{ type: 'DAMAGE', power: 1 }] });
  const a = make('a', 'A', { actionDisabled: true, normalAttack: attack, openingSkill: attack,
    skills: [attack], lockedStats: ['atk', 'spd', 'counter'] });
  const b = make('b', 'B');
  t.mock.method(Formulas, 'determineActionOrder', () => [a, b]);
  a.addBuff({ id: 'bonus', type: 'STAT', duration: 2, effect: s => { s.atk = 999; s.counter = 999; } });
  b.stats.luk = 100;
  assert.equal(a.getEffectiveStats().atk, 0);
  assert.equal(attack.canCast(a), false);
  const log = logger();
  attack.execute(a, [a], [b], log);
  assert.equal(log.logs.length, 0);
  const engine = new BattleEngine([a], [b], { maxTurns: 1 });
  assert.equal(engine.tryCounter(b, a, attack), false);
  const result = engine.start();
  assert.ok(result.logs.some(entry => entry.type === 'LUCK_EVENT' && entry.actorId === a.id));
  assert.equal(a.buffs[0].duration, 1);
});

test('complete attack hook sums multi-action hits once, excluding counters and direct damage', t => {
  t.mock.method(Math, 'random', () => 0.5);
  const hits = [];
  const a = make('a', 'A');
  const b = make('b', 'B', { passives: [{ trigger: 'AFTER_ATTACK_RECEIVED',
    action: (self, hit) => hits.push(hit.actualDamage) }] });
  const skill = new Skill({ id: 'double', actions: [
    { type: 'DAMAGE', power: 1 }, { type: 'DAMAGE', power: 1 }
  ] });
  const log = logger();
  skill.execute(a, [a], [b], log);
  assert.deepEqual(hits, [80]);
  b.takeDamage(5, log, { source: 'DOT' });
  b.takeDamage(5, log, { source: 'REFLECTION', caster: a });
  const engine = new BattleEngine([a], [b]);
  engine.withCounterSource({ actorId: a.id, targetId: b.id }, () => skill.execute(a, [a], [b], log, engine));
  assert.deepEqual(hits, [80]);
});

test('the attacker sees the same aggregate once per target, after the receiver reacts', t => {
  t.mock.method(Math, 'random', () => 0.5);
  const order = [];
  // Two DAMAGE actions on purpose: hitIndex restarts at 1 for the second action,
  // so a passive that tried to detect "end of attack" from hitIndex === hits
  // would fire twice here. The aggregate hook must still fire once per target.
  const skill = new Skill({ id: 'double', targetType: 'ENEMY_ALL', actions: [
    { type: 'DAMAGE', targetType: 'ENEMY_ALL', power: 1 },
    { type: 'DAMAGE', targetType: 'ENEMY_ALL', power: 1 }
  ] });
  const a = make('a', 'A', { passives: [{ trigger: 'AFTER_ATTACK_DEALT',
    action: (self, hit) => order.push(`dealt:${hit.target.id}:${hit.actualDamage}`) }] });
  const mark = id => ({ trigger: 'AFTER_ATTACK_RECEIVED',
    action: self => order.push(`received:${id}`) });
  const b = make('b', 'B', { passives: [mark('b')] });
  const c = make('c', 'B', { passives: [mark('c')] });

  skill.execute(a, [a], [b, c], logger());
  assert.deepEqual(order, ['received:b', 'dealt:b:80', 'received:c', 'dealt:c:80']);
});

test('a dead attacker does not get its complete-attack reaction', t => {
  t.mock.method(Math, 'random', () => 0.5);
  const dealt = [];
  const a = make('a', 'A', { passives: [{ trigger: 'AFTER_ATTACK_DEALT',
    action: () => dealt.push(1) }] });
  // Killing the attacker from the receiver hook is the realistic shape: a thorns
  // passive can settle the attacker's death before the attacker's own reaction.
  const b = make('b', 'B', { passives: [{ trigger: 'AFTER_ATTACK_RECEIVED',
    action: () => { a.stats.hp = 0; a.checkDeath(); } }] });
  const skill = new Skill({ id: 'poke', actions: [{ type: 'DAMAGE', power: 1 }] });

  skill.execute(a, [a], [b], logger());
  assert.deepEqual(dealt, []);
});
