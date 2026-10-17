const test = require('node:test');
const assert = require('node:assert/strict');
const { BattleEngine, Entity, Skill, Formulas } = require('../src');

const stats = { hp: 10000, maxHp: 10000, atk: 100, def: 20, sta: 100, agi: 10, spd: 10,
  tec: 10, int: 10, luk: 0 };
const entity = (id, team) => new Entity({ id, name: id, team, stats: { ...stats },
  normalAttack: null, skills: [], passives: [] });

// 施放者剛好行動一次、每擊必中、沒有反擊，其他人都不動。
function setup(t, skill, resolver, extra = {}) {
  const caster = entity('caster', 'A');
  const ally = entity('ally', 'A');
  const enemy = entity('enemy', 'B');
  for (const unit of [ally, enemy]) unit.actionDisabled = true;
  caster.normalAttack = skill;
  t.mock.method(Formulas, 'isHit', () => true);
  t.mock.method(Formulas, 'isCounter', () => false);
  t.mock.method(Formulas, 'determineActionOrder', () => [caster]);
  const calls = [];
  const engine = new BattleEngine([caster, ally], [enemy], {
    luckEvents: { enabled: false }, ...extra,
    targetSelectionResolver: context => { calls.push(context); return resolver(context); }
  });
  return { caster, ally, enemy, engine, calls };
}

const hpLost = unit => unit.stats.maxHp - unit.stats.hp;

test('a self-only skill never asks the target selection resolver', t => {
  const skill = new Skill({ id: 'focus', name: 'focus', actions: [
    { type: 'TEXT', message: () => 'focus' },
    { type: 'HEAL', targetType: 'SELF', power: 1 }
  ] });
  const { engine, calls } = setup(t, skill, () => ({ swapSides: true }));
  engine.executeTurn();
  assert.equal(calls.length, 0);
});

test('the resolver is asked once per slot and its swap covers every later segment', t => {
  const skill = new Skill({ id: 'mixed', name: 'mixed', actions: [
    { type: 'TEXT', message: () => 'go' },
    { type: 'DAMAGE', targetType: 'ENEMY_SINGLE', power: 1 },
    { type: 'HEAL', targetType: 'ALLY_ALL', inheritTarget: false, power: 0.01 },
    { type: 'DAMAGE', targetType: 'ENEMY_SINGLE', inheritTarget: false, power: 1 }
  ] });
  const { caster, ally, enemy, engine, calls } = setup(t, skill, () => ({ swapSides: true, excludeSelf: true }));
  enemy.stats.hp = 5000;
  engine.executeTurn();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].skill, skill);
  assert.equal(calls[0].targetType, 'ENEMY_SINGLE');
  // 沒寫 targetType 的 TEXT 抓到的敵人不能延續到反轉後的傷害段。
  assert.ok(hpLost(ally) > 0);
  assert.equal(hpLost(caster), 0);
  assert.ok(enemy.stats.hp > 5000);
});

test('targets picked through selectTargets survive the swap when forced into a sub-skill', t => {
  const hit = new Skill({ id: 'shell_hit', name: 'hit', actions: [{ type: 'DAMAGE', power: 1, hits: 3 }] });
  let picked = null;
  class Shell extends Skill {
    execute(caster, allies, enemies, logger, engine, options) {
      super.execute(caster, allies, enemies, logger, engine, options);
      picked = engine.selectTargets(caster, 'ENEMY_SINGLE')[0];
      hit.execute(caster, allies, enemies, logger, engine, { targets: [picked], ignoreSp: true });
    }
  }
  const skill = new Shell({ id: 'shell', name: 'shell', actions: [{ type: 'TEXT', targetType: 'SELF' }] });
  const { caster, ally, enemy, engine, calls } = setup(t, skill, () => ({ swapSides: true }));
  engine.executeTurn();
  assert.equal(calls.length, 1);
  assert.notEqual(picked, enemy);
  const struck = engine.logger.logs.filter(log => log.type === 'DAMAGE' && log.skillId === 'shell_hit');
  assert.equal(struck.length, 3);
  assert.ok(struck.every(log => log.targetId === picked.id));
  assert.equal(hpLost(enemy), 0);
  assert.ok(hpLost(caster) + hpLost(ally) > 0);
});

test('targets picked straight from enemies are still re-rolled under a swap', t => {
  const hit = new Skill({ id: 'legacy_hit', name: 'hit', actions: [{ type: 'DAMAGE', power: 1 }] });
  class Legacy extends Skill {
    execute(caster, allies, enemies, logger, engine, options) {
      engine.selectTargets(caster, 'ENEMY_SINGLE');
      hit.execute(caster, allies, enemies, logger, engine, { targets: [enemies[0]], ignoreSp: true });
    }
  }
  const skill = new Legacy({ id: 'legacy', name: 'legacy', actions: [] });
  const { enemy, engine } = setup(t, skill, () => ({ swapSides: true }));
  engine.executeTurn();
  assert.equal(hpLost(enemy), 0);
});

test('targetPool mirrors both sides and honours excludeSelf', t => {
  const skill = new Skill({ id: 'noop', name: 'noop', actions: [] });
  const { caster, ally, enemy, engine } = setup(t, skill, () => ({ swapSides: true, excludeSelf: true }));
  engine.withActionTargetOverride(caster, engine.pendingTargetResolution(caster, skill), () => {
    assert.deepEqual(engine.targetPool(caster, 'SELF'), [caster]);
    assert.deepEqual(engine.targetPool(caster, 'ENEMY_ALL'), [ally]);
    assert.deepEqual(engine.targetPool(caster, 'ALLY_SINGLE'), [enemy]);
  });
  // 行動槽結束後不留痕跡。
  assert.deepEqual(engine.targetPool(caster, 'ENEMY_ALL'), [enemy]);
});

test('an eager actionTargetResolver answer wins and the lazy resolver is never asked', t => {
  const skill = new Skill({ id: 'strike', name: 'strike', actions: [{ type: 'DAMAGE', power: 1 }] });
  const { ally, enemy, engine, calls } = setup(t, skill, () => ({ swapSides: true }),
    { actionTargetResolver: ({ caster }) => caster.id === 'caster' ? [ally] : null });
  engine.actionTargetResolver = () => [ally];
  engine.executeTurn();
  assert.equal(calls.length, 0);
  assert.ok(hpLost(ally) > 0);
  assert.equal(hpLost(enemy), 0);
});

test('inserted actions are full slots and ask the lazy resolver too', t => {
  const strike = new Skill({ id: 'strike', name: 'strike', actions: [{ type: 'DAMAGE', power: 1 }] });
  const idle = new Skill({ id: 'idle', name: 'idle', actions: [{ type: 'TEXT', targetType: 'SELF', message: () => 'wait' }] });
  const { caster, enemy, engine, calls } = setup(t, idle, () => ({ swapSides: true }));
  engine.insertAction(caster, strike);
  engine.runInsertedActions();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].skill, strike);
  assert.equal(hpLost(enemy), 0);
});

test('a resolver answer of the wrong shape throws', t => {
  const skill = new Skill({ id: 'strike', name: 'strike', actions: [{ type: 'DAMAGE', power: 1 }] });
  const { engine } = setup(t, skill, () => ({ swap: true }));
  assert.throws(() => engine.executeTurn(), /targetSelectionResolver must return/);
});
