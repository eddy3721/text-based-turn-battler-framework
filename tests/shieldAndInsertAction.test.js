const test = require('node:test');
const assert = require('node:assert/strict');
const { BattleEngine, Entity, Skill } = require('../src');

function make(id, team, { passives = [], stats = {}, buffs = [] } = {}) {
  const entity = new Entity({
    id, name: id, team,
    stats: { hp: 1000, atk: 10, def: 5, sta: 10, agi: 10, spd: 10, tec: 10, int: 10, luk: 0, sp: 100, ...stats },
    normalAttack: new Skill({ id: `${id}_attack`, name: 'attack', actions: [{ type: 'DAMAGE' }] }),
    passives
  });
  for (const buff of buffs) entity.addBuff(buff);
  return entity;
}

const shield = (amount, extra = {}) => ({ id: 'shield', name: '護盾', type: 'STAT', duration: 99, shield: amount, ...extra });

test('shield absorbs damage before hp and is removed once emptied', () => {
  const target = make('target', 'B', { buffs: [shield(30)] });
  const logs = [];
  const logger = { addLog: log => logs.push(log) };

  const first = target.takeDamage(20, logger, { source: 'DIRECT' });
  assert.equal(first.damage, 0);
  assert.equal(first.shieldAbsorbed, 20);
  assert.equal(first.blocked, true);
  assert.equal(first.blockMethod, '護盾');
  assert.equal(target.stats.hp, 1000);
  assert.equal(target.buffs[0].shield.value, 10);

  const second = target.takeDamage(25, logger, { source: 'DIRECT' });
  assert.equal(second.shieldAbsorbed, 10);
  assert.equal(second.damage, 15);
  assert.equal(target.stats.hp, 985);
  assert.equal(target.buffs.length, 0, 'emptied shield is removed');
  assert.ok(logs.some(log => log.type === 'SHIELD_BREAK' && log.message === 'target 的護盾碎掉了！'));
});

test('a hit fully absorbed by a breaking shield still logs the break', () => {
  const target = make('target', 'B', { buffs: [shield(10)] });
  const logs = [];
  const outcome = target.takeDamage(10, { addLog: log => logs.push(log) }, { source: 'DIRECT' });
  assert.equal(outcome.damage, 0);
  assert.equal(logs.filter(log => log.type === 'SHIELD_BREAK').length, 1);
});

test('shield stacks absorb in order, apply after damage multipliers, and ignoreShield bypasses them', () => {
  const target = make('target', 'B', { buffs: [
    { id: 'vuln', name: 'vuln', type: 'STAT', duration: 99, damageTaken: { multiplier: 2, filter: () => true } },
    shield(5, { id: 'a', name: 'A' }), shield(100, { id: 'b', name: 'B' })
  ] });
  const outcome = target.takeDamage(10, null, { source: 'DIRECT' });
  assert.equal(outcome.shieldAbsorbed, 20);
  assert.equal(outcome.blockMethod, 'A');
  assert.deepEqual(target.buffs.map(buff => buff.id), ['vuln', 'b']);
  assert.equal(target.buffs[1].shield.value, 85);

  const pierce = target.takeDamage(10, null, { source: 'ATTACK', action: { type: 'DAMAGE', ignoreShield: true } });
  assert.equal(pierce.shieldAbsorbed, undefined);
  assert.equal(target.stats.hp, 980);
});

test('shield-blocked attacks use the default block text and carry shieldAbsorbed in the log', () => {
  const attacker = make('attacker', 'A', { stats: { atk: 200, tec: 999 } });
  const target = make('target', 'B', { buffs: [shield(1e9)] });
  const engine = new BattleEngine([attacker], [target], { luckEvents: { enabled: false } });
  const skill = new Skill({ id: 'poke', name: 'poke', actions: [{ type: 'DAMAGE', accuracy: 99 }] });
  skill.execute(attacker, [attacker], [target], engine.logger, engine);
  const log = engine.logger.logs.find(entry => entry.skillId === 'poke' && entry.type === 'BLOCK');
  assert.ok(log, 'blocked hit logged');
  assert.match(log.message, /但是被 target 用護盾擋下了！/);
  assert.ok(log.shieldAbsorbed > 0);
  assert.equal(target.stats.hp, 1000);
});

test('invalid shield amounts throw', () => {
  const target = make('target', 'B');
  assert.throws(() => target.addBuff(shield(0)));
  assert.throws(() => target.addBuff(shield(Number.NaN)));
});

test('insertAction runs right after the current slot as a full slot', () => {
  const ult = new Skill({ id: 'ult', name: 'ult', actions: [{ type: 'TEXT', text: { action: 'ULT' } }] });
  const seen = [];
  let inserted = false;
  const boss = make('boss', 'B', { stats: { spd: 1 } });
  const hero = make('hero', 'A', { stats: { spd: 1e9 }, passives: [{
    trigger: 'AFTER_ACTION',
    action: (self, action, logger, engine) => {
      seen.push(action.actor.id + ':' + action.skill.id);
      if (!inserted && action.actor === self) { inserted = true; engine.insertAction(boss, ult); }
    }
  }] });
  const engine = new BattleEngine([hero], [boss], { luckEvents: { enabled: false }, maxTurns: 1 });
  engine.executeTurn();

  assert.equal(seen[0], 'hero:hero_attack');
  assert.equal(seen[1], 'boss:ult', 'inserted action is the very next slot');
  const slot = engine.actionSlots.find(entry => entry.skill === ult);
  assert.equal(slot.inserted, true);
  assert.ok(engine.logger.logs.slice(slot.start, slot.end).some(log => log.message === 'ULT'));
});

test('insertAction is cancelled with onSkip when the entity cannot act', () => {
  const ult = new Skill({ id: 'ult', name: 'ult', actions: [{ type: 'TEXT', text: { action: 'ULT' } }] });
  const skipped = [];
  const boss = make('boss', 'B', { buffs: [{ id: 'stun', name: 'stun', type: 'STUN', duration: 99 }] });
  const hero = make('hero', 'A');
  const engine = new BattleEngine([hero], [boss], { luckEvents: { enabled: false }, maxTurns: 1 });
  engine.insertAction(boss, ult, { onSkip: (entity, skill) => skipped.push([entity.id, skill.id]) });
  engine.executeTurn();
  assert.deepEqual(skipped, [['boss', 'ult']]);
  assert.ok(!engine.logger.logs.some(log => log.message === 'ULT'));
  assert.throws(() => engine.insertAction(boss, null));
});

test('an attack fully absorbed by a shield still reaches AFTER_ATTACK_RECEIVED', () => {
  const received = [];
  const attacker = make('attacker', 'A', { stats: { atk: 200, tec: 999 } });
  const target = make('target', 'B', { buffs: [shield(1e9)], passives: [{
    trigger: 'AFTER_ATTACK_RECEIVED', action: (self, hit) => received.push([hit.actualDamage, hit.shieldAbsorbed])
  }] });
  const engine = new BattleEngine([attacker], [target], { luckEvents: { enabled: false } });
  const skill = new Skill({ id: 'poke', name: 'poke', actions: [{ type: 'DAMAGE', accuracy: 99, hits: 2 }] });
  skill.execute(attacker, [attacker], [target], engine.logger, engine);
  assert.equal(received.length, 1, 'once per attack');
  assert.equal(received[0][0], 0);
  assert.ok(received[0][1] > 0);
});
