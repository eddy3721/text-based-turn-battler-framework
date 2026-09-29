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

const watcher = (seen, name) => ({
  trigger: 'AFTER_ACTION',
  action: (self, action) => seen.push([name, action.actor.id, action.skill.id])
});

test('AFTER_ACTION reaches every living unit on both teams once per acted slot', () => {
  const seen = [];
  const a = make('a', 'A', { passives: [watcher(seen, 'a')] });
  const ally = make('ally', 'A', { passives: [watcher(seen, 'ally')] });
  const b = make('b', 'B', { passives: [watcher(seen, 'b')] });
  const engine = new BattleEngine([a, ally], [b], { luckEvents: { enabled: false }, maxTurns: 1 });

  engine.executeTurn();

  const actors = seen.filter(([name]) => name === 'a').map(([, actor]) => actor);
  assert.equal(seen.length, actors.length * 3, 'each observer sees the same actions');
  assert.ok(actors.includes('ally') && actors.includes('a') && actors.includes('b'));
  assert.ok(seen.every(([, actor, skill]) => skill === `${actor}_attack`));
});

test('AFTER_ACTION does not fire for stunned or inanimate slots', () => {
  const seen = [];
  const observer = make('observer', 'A', { passives: [watcher(seen, 'observer')], stats: { spd: 1 } });
  const stunned = make('stunned', 'B', { buffs: [{ id: 'stun', name: 'stun', type: 'STUN', duration: 99 }] });
  observer.actionDisabled = true;
  const engine = new BattleEngine([observer], [stunned], { luckEvents: { enabled: false }, maxTurns: 1 });

  engine.executeTurn();

  assert.deepEqual(seen, []);
});

test('AFTER_ACTION passives receive logger and engine, and deaths they cause are settled', () => {
  const victim = make('victim', 'B', { stats: { hp: 5 } });
  victim.actionDisabled = true;
  const sniper = make('sniper', 'A', { passives: [{
    trigger: 'AFTER_ACTION',
    enabled: (self, action) => action.actor === self,
    action: (self, _action, logger, engine) => {
      assert.ok(logger && engine);
      const hit = victim.takeDamage(999, logger, { caster: self, source: 'DIRECT' });
      victim.finishDamage(hit, logger, engine);
    }
  }] });
  const engine = new BattleEngine([sniper], [victim], { luckEvents: { enabled: false }, maxTurns: 1 });

  engine.executeTurn();

  assert.equal(victim.isAlive, false);
  assert.equal(engine.result, 'TEAM_A');
});

test('ROUND_START passives run once per round for living units, after the encounter roundStart', () => {
  const seen = [];
  const hero = make('hero', 'A', { passives: [{
    trigger: 'ROUND_START',
    action: (self, { round }, logger, engine) => {
      assert.ok(logger && engine);
      seen.push([round, self.stats.hp]);
    }
  }] });
  const foe = make('foe', 'B');
  foe.actionDisabled = true;
  hero.actionDisabled = true;
  const engine = new BattleEngine([hero], [foe], {
    luckEvents: { enabled: false }, maxTurns: 5,
    roundStart: engine => { hero.stats.hp -= 10; seen.push(['encounter', engine.currentTurn]); }
  });

  engine.executeTurn();
  engine.currentTurn++;
  engine.executeTurn();

  assert.deepEqual(seen, [['encounter', 1], [1, 990], ['encounter', 2], [2, 980]]);
});
