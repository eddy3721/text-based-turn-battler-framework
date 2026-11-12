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

// ───────────── BATTLE_END 被動（1.0.56） ─────────────

function withPassives(id, team, passives, stats) {
  const entity = make(id, team, stats);
  entity.passives = passives;
  return entity;
}

const announce = (seen = []) => ({
  trigger: 'BATTLE_END',
  enabled: (self, battle) => battle.winner === `TEAM_${self.team}`,
  action: (self, battle, logger) => {
    seen.push(self.id);
    logger.addLog({ type: 'TEXT', actorId: self.id, message: `${self.name} WIN！` });
  }
});

test('BATTLE_END runs after the result, right before the BATTLE_END log', () => {
  const engine = new BattleEngine([withPassives('ken', 'A', [announce()], { atk: 500 })], [make('foe', 'B', { hp: 10 })],
    { luckEvents: { enabled: false } });
  const result = engine.start();
  assert.equal(result.winner, 'TEAM_A');
  assert.deepEqual(result.logs.map(log => log.message).slice(-2), ['ken WIN！', '戰鬥結束，獲勝方: TEAM_A']);
});

test('BATTLE_END runs after the encounter battleEnd', () => {
  const engine = new BattleEngine([withPassives('ken', 'A', [announce()], { atk: 500 })], [make('foe', 'B', { hp: 10 })], {
    luckEvents: { enabled: false },
    battleEnd: e => e.logger.addLog({ type: 'TEXT', message: '重播' })
  });
  const messages = engine.start().logs.map(log => log.message);
  assert.ok(messages.indexOf('重播') < messages.indexOf('ken WIN！'));
});

test('BATTLE_END also reaches fallen units and the losing side', () => {
  const seen = [];
  const watcher = { trigger: 'BATTLE_END', action: self => seen.push(`${self.id}:${self.isAlive}`) };
  const engine = new BattleEngine([withPassives('ken', 'A', [watcher], { atk: 500 })],
    [withPassives('foe', 'B', [watcher], { hp: 10 })], { luckEvents: { enabled: false } });
  engine.start();
  assert.deepEqual(seen, ['ken:true', 'foe:false']);
});

test('without BATTLE_END passives the log is unchanged', () => {
  const run = passives => {
    const engine = new BattleEngine([withPassives('ken', 'A', passives, { atk: 500 })], [make('foe', 'B', { hp: 10 })],
      { luckEvents: { enabled: false }, rng: () => 0.42 });
    return engine.start().logs.map(log => log.message);
  };
  assert.deepEqual(run([]), run([{ trigger: 'BATTLE_END', enabled: () => false }]));
});
