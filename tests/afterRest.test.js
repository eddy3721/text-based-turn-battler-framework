const test = require('node:test');
const assert = require('node:assert/strict');
const { BattleEngine, Entity, Skill } = require('../src');

function make(id, team, { passives = [], stats = {} } = {}) {
  return new Entity({
    id, name: id, team,
    stats: { hp: 1000, atk: 10, def: 5, sta: 10, agi: 10, spd: 10, tec: 10, int: 10, luk: 0, sp: 100, ...stats },
    normalAttack: new Skill({ id: `${id}_attack`, name: 'attack', dealsBasicAttackDamage: true, actions: [{ type: 'DAMAGE' }] }),
    passives
  });
}

function restingPair(passives) {
  const tired = make('tired', 'A', { passives, stats: { spd: 100 } });
  tired.stats.sp = 0;
  const foe = make('foe', 'B', { stats: { spd: 1 } });
  foe.actionDisabled = true;
  return { tired, engine: new BattleEngine([tired], [foe], { luckEvents: { enabled: false }, maxTurns: 1 }) };
}

test('AFTER_REST runs after the rest log with logger, engine and the recovered SP', () => {
  const seen = [];
  const { tired, engine } = restingPair([{
    trigger: 'AFTER_REST',
    action: (self, rest, logger, eng) => {
      seen.push(rest.value);
      assert.ok(logger && eng === engine);
      assert.equal(logger.logs.at(-1).type, 'REST', '被動跑在喘息日誌之後');
      logger.addLog({ type: 'TEXT', actorId: self.id, message: 'after' });
    }
  }]);
  engine.executeTurn();
  assert.equal(seen.length, 1);
  assert.ok(seen[0] > 0);
  const rest = engine.logger.logs.findIndex(log => log.type === 'REST' && log.actorId === tired.id);
  assert.equal(engine.logger.logs[rest].message, 'tired 暫時停下攻勢，調整呼吸', '沒有 restMessage 時沿用預設句');
  assert.equal(engine.logger.logs[rest + 1].message, 'after');
});

test('the first enabled passive with restMessage replaces the default rest line', () => {
  const { engine } = restingPair([
    { trigger: 'AFTER_REST', enabled: () => false, restMessage: () => 'disabled' },
    { trigger: 'AFTER_REST', restMessage: (self, rest) => `${self.name} 站定（${rest.value}）` },
    { trigger: 'AFTER_REST', restMessage: () => 'second' }
  ]);
  engine.executeTurn();
  const rest = engine.logger.logs.find(log => log.type === 'REST');
  assert.match(rest.message, /^tired 站定（\d+）$/);
});

test('AFTER_REST does not fire for slots that act', () => {
  let fired = 0;
  const actor = make('actor', 'A', { passives: [{ trigger: 'AFTER_REST', action: () => { fired++; } }] });
  const foe = make('foe', 'B');
  foe.actionDisabled = true;
  const engine = new BattleEngine([actor], [foe], { luckEvents: { enabled: false }, maxTurns: 1 });
  engine.executeTurn();
  assert.equal(fired, 0);
});
