const test = require('node:test');
const assert = require('node:assert/strict');
const { BattleEngine, Entity, Skill } = require('../src');

function make(id, team, stats = {}) {
  return new Entity({
    id, name: id, team,
    stats: { hp: 1000, atk: 10, def: 5, sta: 10, agi: 10, spd: 10, tec: 10, int: 10, luk: 0, sp: 100, ...stats },
    normalAttack: new Skill({ id: `${id}_attack`, name: 'attack', actions: [{ type: 'DAMAGE' }] })
  });
}

test('actionSlots records every acted slot with its log range, including the deciding one', () => {
  const a = make('a', 'A', { atk: 500, tec: 999 });
  const b = make('b', 'B', { hp: 30, spd: 1 });
  b.actionDisabled = true;
  const engine = new BattleEngine([a], [b], { luckEvents: { enabled: false }, maxTurns: 5 });

  const result = engine.start();

  assert.equal(result.winner, 'TEAM_A');
  assert.ok(engine.actionSlots.length >= 1);
  const last = engine.actionSlots.at(-1);
  assert.equal(last.actor, a);
  assert.equal(last.skill, a.normalAttack);
  const slice = result.logs.slice(last.start, last.end);
  assert.ok(slice.some(log => log.type === 'DEATH' && log.actorId === 'b'), 'the killing slot owns the death log');
  for (const slot of engine.actionSlots) {
    assert.ok(slot.start <= slot.end && Number.isInteger(slot.turn));
    assert.ok(result.logs.slice(slot.start, slot.end).every(log => log.type !== 'TURN_START'));
  }
});

test('actionSlots skips slots that did not act', () => {
  const a = make('a', 'A');
  const b = make('b', 'B');
  a.actionDisabled = true;
  b.actionDisabled = true;
  const engine = new BattleEngine([a], [b], { luckEvents: { enabled: false }, maxTurns: 1 });

  engine.start();

  assert.deepEqual(engine.actionSlots, []);
});

test('battleEnd runs once after the result is decided and before BATTLE_END', () => {
  const a = make('a', 'A', { atk: 500, tec: 999 });
  const b = make('b', 'B', { hp: 30 });
  const calls = [];
  const engine = new BattleEngine([a], [b], {
    luckEvents: { enabled: false }, maxTurns: 5,
    battleEnd: engine => {
      calls.push(engine.result);
      engine.logger.addLog({ type: 'TEXT', message: 'replay' });
    }
  });

  const result = engine.start();

  assert.deepEqual(calls, [result.winner]);
  const types = result.logs.slice(-2).map(log => log.message);
  assert.deepEqual(types, ['replay', `戰鬥結束，獲勝方: ${result.winner}`]);
});

test('battleEnd also runs on a draw by turn limit', () => {
  const a = make('a', 'A');
  const b = make('b', 'B');
  a.actionDisabled = true;
  b.actionDisabled = true;
  let seen = null;
  const engine = new BattleEngine([a], [b], { luckEvents: { enabled: false }, maxTurns: 1, battleEnd: e => { seen = e.result; } });

  engine.start();

  assert.equal(seen, 'DRAW');
});
