const test = require('node:test');
const assert = require('node:assert/strict');
const { BattleEngine, Entity, Skill } = require('../src');

function make(id, team, stats = {}, passives = []) {
  return new Entity({
    id, name: id, team, passives,
    stats: { hp: 1000, atk: 10, def: 5, sta: 10, agi: 10, spd: 10, tec: 10, int: 10, luk: 0, sp: 100, ...stats },
    normalAttack: new Skill({ id: `${id}_attack`, name: 'attack', actions: [{ type: 'DAMAGE' }] })
  });
}

const finisher = (afterResult) => ({
  id: 'finisher', trigger: 'AFTER_ATTACK_DEALT', ...(afterResult ? { afterResult: true } : {}),
  enabled: (_self, hit) => !hit.target.isAlive,
  action: (self, _hit, logger) => logger.addLog({ type: 'TEXT', actorId: self.id, message: `${self.name}：「收工。」` })
});

function fight(afterResult) {
  const a = make('a', 'A', { atk: 500, tec: 999 }, [finisher(afterResult)]);
  const b = make('b', 'B', { hp: 30, spd: 1 });
  b.actionDisabled = true;
  const engine = new BattleEngine([a], [b], { luckEvents: { enabled: false }, maxTurns: 5 });
  return engine.start();
}

test('passives stop once the battle is decided, so the deciding blow gets no reaction by default', () => {
  const result = fight(false);
  assert.equal(result.winner, 'TEAM_A');
  assert.ok(!result.logs.some(log => log.message === 'a：「收工。」'));
});

test('an afterResult passive still reacts to the deciding blow, before BATTLE_END', () => {
  const result = fight(true);
  assert.equal(result.winner, 'TEAM_A');
  const line = result.logs.findIndex(log => log.message === 'a：「收工。」');
  const death = result.logs.findIndex(log => log.type === 'DEATH' && log.actorId === 'b');
  const end = result.logs.findIndex(log => log.type === 'BATTLE_END');
  assert.ok(line > death && line < end);
});

test('passives without the flag that follow one with it are still skipped', () => {
  const seen = [];
  const passive = (id, afterResult) => ({ id, trigger: 'AFTER_ATTACK_DEALT', afterResult,
    enabled: (_self, hit) => !hit.target.isAlive, action: () => seen.push(id) });
  const a = make('a', 'A', { atk: 500, tec: 999 }, [passive('flagged', true), passive('plain', false)]);
  const b = make('b', 'B', { hp: 30, spd: 1 });
  b.actionDisabled = true;
  new BattleEngine([a], [b], { luckEvents: { enabled: false }, maxTurns: 5 }).start();
  assert.deepEqual(seen, ['flagged']);
});
