const test = require('node:test');
const assert = require('node:assert/strict');
const { BattleEngine, Entity, Skill } = require('../src');

function make(id, team, passives = []) {
  return new Entity({
    id, name: id, team,
    stats: { hp: 1000, atk: 10, def: 5, sta: 10, agi: 10, spd: 10, tec: 10, int: 10, luk: 0, sp: 100 },
    normalAttack: new Skill({ id: `${id}_attack`, name: 'attack', dealsBasicAttackDamage: true, actions: [{ type: 'DAMAGE' }] }),
    passives
  });
}

const runAway = (seen = []) => ({
  trigger: 'BATTLE_START',
  action: (self, battle, logger, engine) => {
    seen.push(self.id);
    logger.addLog({ type: 'TEXT', actorId: self.id, message: `${self.name} 跑走了` });
    engine.result = 'DRAW';
  }
});

test('BATTLE_START runs before round 1 and can end the battle as a draw', () => {
  const engine = new BattleEngine([make('bobo', 'A', [runAway()])], [make('foe', 'B')], { luckEvents: { enabled: false } });
  const result = engine.start();
  assert.equal(result.winner, 'DRAW');
  const types = result.logs.map(log => log.type);
  assert.ok(!types.includes('TURN_START'), '一個回合都沒跑');
  assert.deepEqual(result.logs.map(log => log.message).slice(-2), ['bobo 跑走了', '戰鬥結束，獲勝方: DRAW']);
  assert.equal(engine.currentTurn, 1);
});

test('once a result is set the remaining BATTLE_START passives do not fire', () => {
  const seen = [];
  const engine = new BattleEngine([make('a', 'A', [runAway(seen)])], [make('b', 'B', [runAway(seen)])],
    { luckEvents: { enabled: false } });
  engine.start();
  assert.deepEqual(seen, ['a']);
  assert.equal(engine.logger.logs.filter(log => log.message?.endsWith('跑走了')).length, 1);
});

test('BATTLE_START without a result lets the battle continue normally', () => {
  const seen = [];
  const engine = new BattleEngine([make('a', 'A', [{
    trigger: 'BATTLE_START', action: (self, battle, logger, eng) => { seen.push(battle.maxTurns); assert.equal(eng.currentTurn, 1); }
  }])], [make('b', 'B')], { luckEvents: { enabled: false }, maxTurns: 2 });
  engine.start();
  assert.deepEqual(seen, [2]);
  assert.ok(engine.logger.logs.some(log => log.type === 'TURN_START'));
});
