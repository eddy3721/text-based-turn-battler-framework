const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Entity, Skill, BattleEngine } = require('../src');
const Formulas = require('../src/utils/Formulas');
const attack = new Skill({ id: 'basic', actions: [{ type: 'DAMAGE' }] });
const unit = (id, extra = {}) => new Entity({ id, name: id, team: id === 'a' ? 'A' : 'B',
  normalAttack: attack, stats: { hp: 1000, maxHp: 1000, sp: 100, maxSp: 100,
    atk: 100, def: 100, spd: 100, cri: 0.2, criDmg: 1.5, ...extra } });
const logger = () => ({ logs: [], addLog(log) { this.logs.push(log); } });

test('inclusive thresholds, nonstacking stats and transition logs', () => {
  const a = unit('a'), log = logger();
  a.spendSp(50, log);
  assert.equal(a.getEffectiveStats().atk, 80);
  assert.equal(a.getEffectiveStats().criDmg, 1.4);
  assert.equal(a.getEffectiveStats().maxSp, 100);
  a.spendSp(1, log);
  assert.equal(log.logs.length, 1);
  a.spendSp(39, log);
  assert.equal(a.getEffectiveStats().spd, 60);
  assert.equal(a.getEffectiveStats().criDmg, 1.3);
  a.restoreSp(41, log);
  assert.equal(a.getEffectiveStats().atk, 100);
  a.spendSp(1, log);
  assert.deepEqual(log.logs.map(l => l.stage), ['TIRED', 'EXHAUSTED', 'TIRED']);
  const b = unit('b');
  b.spendSp(95, log);
  assert.equal(log.logs.at(-1).stage, 'EXHAUSTED');
});

test('fatigue lowers skill cast rate by stage, after buffs and before clamping', () => {
  const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
  const a = unit('a');
  close(a.getEffectiveStats().skillCastRate, 0.35);
  a.stats.sp = 50;
  close(a.getEffectiveStats().skillCastRate, 0.25);
  a.stats.sp = 10;
  close(a.getEffectiveStats().skillCastRate, 0.20);
  assert.equal(a.stats.skillCastRate, 0.35);
  a.addBuff({ id: 'focus', type: 'STAT', duration: 2, effect: stats => { stats.skillCastRate += 0.15; } });
  close(a.getEffectiveStats().skillCastRate, 0.35);
  a.addBuff({ id: 'silence', type: 'STAT', duration: 2, effect: stats => { stats.skillCastRate -= 0.4; } });
  assert.equal(a.getEffectiveStats().skillCastRate, 0);
  const b = unit('b', { sp: 10 });
  b.fatigueEnabled = false;
  assert.equal(b.getEffectiveStats().skillCastRate, 0.35);
});

test('recovering into a lighter stage stays silent but can be reported again later', () => {
  const a = unit('a', { sp: 5 }), log = logger();
  a.syncFatigue(log);
  assert.deepEqual(log.logs.map(l => l.stage), ['EXHAUSTED']);
  a.restoreSp(35, log);
  assert.equal(a.getFatigueStage(), 'TIRED');
  assert.equal(log.logs.length, 1);
  a.spendSp(31, log);
  assert.deepEqual(log.logs.map(l => l.stage), ['EXHAUSTED', 'EXHAUSTED']);
});

test('resource-free and explicitly exempt units do not suffer fatigue', () => {
  const a = unit('a', { sp: 0, maxSp: 0 });
  assert.equal(a.getFatigueStage(), 'NORMAL');
  assert.equal(a.getBasicAttackCost(), 0);
  const b = unit('b', { sp: 0 });
  b.fatigueEnabled = false;
  assert.equal(b.getEffectiveStats().atk, 100);
});

test('each attempted combo hit costs SP, including misses; insufficient SP stops it', t => {
  t.mock.method(Formulas, 'getCombos', () => 5);
  t.mock.method(Formulas, 'isHit', () => false);
  const a = unit('a', { sp: 3 }), b = unit('b'), log = logger();
  attack.execute(a, [a], [b], log);
  assert.equal(a.stats.sp, 0);
  assert.equal(log.logs.filter(l => l.type === 'MISS').length, 3);
});

test('dispatching normal attacks charge their delegated hits and rest when empty', t => {
  // 派發型普攻：自身沒有 actions，execute 時轉發給另一個 Skill。
  // 這是烏薩奇與巴奇那種「固定節奏」普攻的形狀。
  const inner = new Skill({ id: 'inner', actions: [{ type: 'DAMAGE' }] });
  class Dispatcher extends Skill {
    get dealsBasicAttackDamage() { return true; }
    execute(caster, allies, enemies, log, context) { inner.execute(caster, allies, enemies, log, context); }
  }
  const dispatcher = new Dispatcher({ id: 'rhythm' });
  const a = new Entity({ id: 'a', name: 'a', team: 'A', normalAttack: dispatcher,
    stats: { hp: 1000, maxHp: 1000, sp: 3, maxSp: 100, atk: 100, def: 100, spd: 100 } });
  const b = unit('b');
  const engine = new BattleEngine([a], [b], { luckEvents: { enabled: false } });
  t.mock.method(Formulas, 'determineActionOrder', () => [a]);
  t.mock.method(Formulas, 'getCombos', () => 5);
  t.mock.method(Formulas, 'isHit', () => false);
  t.mock.method(Math, 'random', () => 0.5);
  engine.executeTurn();
  // 轉發出去的五擊照樣逐擊收費，收到見底為止——修正前這裡是全額免費。
  assert.equal(a.stats.sp, 0);
  assert.equal(engine.logger.logs.filter(l => l.type === 'MISS').length, 3);
  // 體力見底後改為喘息，而不是空轉掉行動槽。
  engine.executeTurn();
  assert.equal(engine.logger.logs.some(l => l.type === 'REST'), true);
});

test('fatigue blocks before action triggers and ticks buffs; stun takes precedence', t => {
  const a = unit('a', { sp: 10 }), b = unit('b');
  const engine = new BattleEngine([a], [b], { luckEvents: { enabled: false } });
  t.mock.method(Formulas, 'determineActionOrder', () => [a]);
  t.mock.method(Math, 'random', () => 0.19);
  a.addBuff({ id: 'timed', type: 'STAT', duration: 3 });
  a.addBuff({ id: 'charge', trigger: 'BEFORE_ACTION', remainingTriggers: 1, skillIds: ['missing'] });
  engine.executeTurn();
  assert.equal(a.stats.sp, 10);
  assert.equal(a.hasActed, false);
  assert.equal(a.buffs[0].duration, 2);
  assert.equal(a.buffs[1].remainingTriggers, 1);
  assert.equal(engine.logger.logs.filter(l => l.type === 'FATIGUE_SKIP').length, 1);
  a.addBuff({ id: 'stun', type: 'STUN', duration: 2 });
  engine.executeTurn();
  assert.equal(engine.logger.logs.filter(l => l.type === 'FATIGUE_SKIP').length, 1);
});

test('an unblocked empty unit rests and recovers 40 percent', t => {
  const a = unit('a', { sp: 0 }), b = unit('b');
  const engine = new BattleEngine([a], [b], { luckEvents: { enabled: false } });
  t.mock.method(Formulas, 'determineActionOrder', () => [a]);
  t.mock.method(Math, 'random', () => 0.2);
  engine.executeTurn();
  assert.equal(a.stats.sp, 40);
  assert.equal(engine.logger.logs.find(l => l.type === 'REST').value, 40);
  assert.equal(b.stats.hp, 1000);
});

test('empty defenders cannot intercept with a free basic counter', t => {
  const a = unit('a'), b = unit('b', { sp: 0 });
  const engine = new BattleEngine([a], [b]);
  t.mock.method(Formulas, 'isCounter', () => true);
  assert.equal(engine.tryCounter(a, b, attack, { action: attack.actions[0] }), false);
  assert.equal(a.stats.hp, 1000);
});

test('skill payment applies fatigue before damage without adding per-hit basic costs', t => {
  const a = unit('a', { sp: 51 }), b = unit('b'), log = logger();
  const spell = new Skill({ id: 'spell', actions: [{ type: 'DAMAGE', spCost: 2, hits: 2 }] });
  t.mock.method(Formulas, 'isHit', () => true);
  t.mock.method(Formulas, 'isCritical', () => false);
  const strengths = [];
  t.mock.method(Formulas, 'calculateDamage', caster => { strengths.push(caster.getEffectiveStats().atk); return 1; });
  spell.execute(a, [a], [b], log);
  assert.deepEqual(strengths, [80, 80]);
  assert.equal(a.stats.sp, 49);
  assert.equal(log.logs[0].message, 'a 開始有點喘');
});

test('buffs apply before fatigue and locked stats stay zero; basic costs are configurable', () => {
  const a = unit('a', { sp: 50 });
  a.addBuff({ id: 'power', type: 'STAT', duration: 2, effect: stats => { stats.atk *= 2; stats.spd = 500; } });
  a.lockedStats = ['spd'];
  assert.equal(a.getEffectiveStats().atk, 160);
  assert.equal(a.getEffectiveStats().spd, 0);
  a.normalAttackSpCost = 4;
  a.stats.sp = 3;
  assert.equal(attack.canCast(a), false);
  a.stats.sp = 4;
  assert.equal(attack.canCast(a), true);
  assert.throws(() => new Entity({ normalAttackSpCost: -1 }), /normalAttackSpCost/);
});
