const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Entity, Skill, BattleEngine, Formulas, createSanityRules } = require('../src');

const unit = (id = 'a', options = {}) => new Entity({ id, name: id, team: 'A',
  stats: { hp: 1000, maxHp: 1000, sp: 100, maxSp: 100, atk: 10, def: 0,
    spd: 10, hit: 100, eva: 0, cri: 0, counter: 0, luk: 0 }, ...options });
const logger = () => ({ logs: [], addLog(entry) { this.logs.push(entry); } });
const wait = new Skill({ id: 'wait', name: '等待', actions: [{ type: 'TEXT', targetType: 'SELF' }] });
const change = amount => new Skill({ id: 'pressure', name: '精神衝擊',
  actions: [{ type: 'CHANGE_SANITY', amount, targetType: 'ENEMY_ALL' }] });
const battle = (a, b = unit('b', { team: 'B' }), options = {}) =>
  new BattleEngine([a], [b], { luckEvents: { enabled: false }, ...options });
const turn = (engine, n) => { engine.currentTurn = n; engine.executeTurn(); };

test('sanity is opt-in, validates configuration, isolates state, and supports custom scales', () => {
  assert.equal(unit().sanity, null);
  assert.equal(unit('a', { sanity: false }).sanity, null);
  for (const sanity of [true, null, [], 1, { min: 0 }, { max: 0 }, { initial: 51 },
    { min: NaN }, { max: Infinity }, { neutral: -50 }, { rules: null },
    { rules: { getState: 1 } }, { rules: { panicEnabled: 1 } }]) {
    assert.throws(() => unit('a', { sanity }), /[Ss]anity|sanity/);
  }
  const config = { min: 0, max: 100, neutral: 40, initial: 70 };
  const a = unit('a', { sanity: config });
  const b = unit('b', { sanity: config });
  assert.equal(a.sanity.state, 'INSPIRED');
  assert.equal(a.changeSanity(90), 30);
  assert.equal(a.sanity.value, 100);
  assert.equal(b.sanity.value, 70);
  assert.equal(a.changeSanity(-200), -100);
  assert.equal(a.isPanicked(), true);
  assert.equal(a.sanity.panicUntil, 1);
});

test('changes report actual values, sources and transitions, but no-ops/dead units emit nothing', () => {
  const calls = [];
  const a = unit('a', { sanity: {}, passives: ['ON_SANITY_CHANGE', 'ON_SANITY_STATE_CHANGE'].map(trigger => ({
    trigger, action: (self, event) => calls.push([trigger, event])
  })) });
  const out = logger();
  assert.equal(a.changeSanity(100, out, { source: 'COURAGE' }), 50);
  assert.deepEqual(out.logs.map(e => e.type), ['SANITY_CHANGE', 'SANITY_STATE_CHANGE']);
  assert.equal(calls.length, 2);
  assert.deepEqual([calls[0][1].before, calls[0][1].after, calls[0][1].source], [0, 50, 'COURAGE']);
  a.changeSanity(-1, out);
  assert.equal(calls.length, 3); // Same state, only the numeric event.
  a.changeSanity(0, out);
  a.isAlive = false;
  assert.equal(a.changeSanity(-50, out), 0);
  assert.equal(unit().changeSanity(-50, out), 0);
  assert.equal(calls.length, 3);
  assert.throws(() => a.changeSanity(NaN), /finite/);
});

test('rules can be replaced or disabled without losing numeric events', () => {
  const a = unit('a', { sanity: { rules: false } });
  a.changeSanity(-50);
  assert.equal(a.canAct(), true);
  assert.equal(a.sanity.state, 'SHAKEN');
  assert.equal(a.getEffectiveStats().skillCastRate, 0.35);
  const engine = battle(a);
  a.sanity.endRound(a, engine.logger, engine);
  assert.equal(a.sanity.value, -50);
  const rules = createSanityRules({ panicEnabled: false, castRateModifier: () => 0.2,
    recoveryAmount: () => 3, getState: s => s.value < -10 ? 'FEAR' : 'CALM' });
  const b = unit('b', { sanity: { initial: -20, rules } });
  assert.equal(b.sanity.state, 'FEAR');
  assert.equal(b.getEffectiveStats().skillCastRate, 0.55);
  b.sanity.endRound(b, engine.logger, engine);
  assert.equal(b.sanity.value, -17);
  assert.throws(() => unit('x', { sanity: { rules: { getState: () => 'PANIC' } } }), /getState/);
});

test('cast chance normalizes asymmetric scales and combines fatigue before clamp and aura', () => {
  const a = unit('a', { sanity: { min: 0, neutral: 40, max: 100, initial: 70 } });
  assert.ok(Math.abs(a.getEffectiveStats().skillCastRate - 0.4) < 1e-12);
  a.changeSanity(-50);
  assert.ok(Math.abs(a.getEffectiveStats().skillCastRate - 0.3) < 1e-12);
  a.stats.sp = 50;
  const b = unit('b', { team: 'B', passives: [{ id: 'aura', enemySkillCastMultiplier: 0.5 }] });
  assert.ok(Math.abs(battle(a, b).getSkillCastChance(a) - 0.1) < 1e-12);
  a.stats.skillCastRate = 0.01;
  assert.equal(a.getEffectiveStats().skillCastRate, 0);
  a.stats.skillCastRate = 1;
  a.stats.sp = 100;
  a.changeSanity(100);
  assert.equal(a.getEffectiveStats().skillCastRate, 1);
});

test('CHANGE_SANITY supports mixed multi-target teams, actual-value text and inherited targets', () => {
  const a = unit();
  const b = unit('b', { sanity: { initial: 45 }, team: 'B' });
  const c = unit('c', { team: 'B' });
  const out = logger();
  const skill = new Skill({ id: 'cheer', name: '鼓舞', actions: [
    { type: 'CHANGE_SANITY', amount: 20, targetType: 'ENEMY_ALL',
      text: { action: '鼓舞：', sanity: ctx => `${ctx.target.name}+${ctx.value}` } },
    { type: 'CHANGE_SANITY', amount: -5, targetType: 'SELF', message: ctx => `繼承 ${ctx.target.name} ${ctx.value}` }
  ] });
  skill.execute(a, [a], [b, c], out);
  assert.equal(b.sanity.value, 45);
  assert.deepEqual(out.logs.filter(e => e.type === 'SANITY_CHANGE').map(e => e.message), ['鼓舞：b+5', '繼承 b -5']);
  assert.equal(out.logs[0].skillId, 'cheer');
  assert.equal(out.logs[0].actorId, a.id);
  assert.throws(() => change(Infinity), /finite amount/);
});

test('a separate sanity action is not gated by a preceding miss', t => {
  t.mock.method(Formulas, 'isHit', () => false);
  const a = unit();
  const b = unit('b', { team: 'B', sanity: {} });
  const skill = new Skill({ id: 'mixed', actions: [
    { type: 'DAMAGE', power: 1 }, { type: 'CHANGE_SANITY', amount: -10 }
  ] });
  skill.execute(a, [a], [b], logger());
  assert.equal(b.stats.hp, 1000);
  assert.equal(b.sanity.value, -10);
});

test('recovery runs once per global round independent of speed and never crosses neutral', t => {
  const a = unit('a', { sanity: { initial: -12 }, normalAttack: wait });
  const engine = battle(a);
  t.mock.method(Formulas, 'determineActionOrder', () => [a, a, a, a]);
  turn(engine, 1);
  assert.equal(a.sanity.value, -7);
  t.mock.method(Formulas, 'determineActionOrder', () => []);
  turn(engine, 2);
  assert.equal(a.sanity.value, -2);
  turn(engine, 3);
  assert.equal(a.sanity.value, 0);
  a.changeSanity(2);
  turn(engine, 4);
  assert.equal(a.sanity.value, 0);
});

test('panic cancels remaining current and next-round slots; healing cannot shorten or extend it', t => {
  const a = unit('a', { sanity: {}, normalAttack: wait });
  const b = unit('b', { team: 'B', normalAttack: change(-50) });
  const engine = battle(a, b);
  t.mock.method(Formulas, 'determineActionOrder', () => [a, b, a, a]);
  turn(engine, 1);
  assert.equal(a.sanity.panicUntil, 2);
  assert.equal(a.sanity.value, -50);
  assert.equal(engine.logger.logs.filter(e => e.type === 'SKILL_TEXT').length, 1);
  a.changeSanity(90, engine.logger, { engine });
  assert.equal(a.sanity.value, 40);
  assert.equal(a.canAct(), false);
  a.changeSanity(-90, engine.logger, { engine });
  assert.equal(a.sanity.panicUntil, 2);
  t.mock.method(Formulas, 'determineActionOrder', () => [a, a]);
  turn(engine, 2);
  assert.equal(a.isPanicked(), false);
  assert.equal(a.sanity.value, 0);
  turn(engine, 3);
  assert.equal(engine.logger.logs.filter(e => e.type === 'SKILL_TEXT').length, 3);
  assert.equal(engine.logger.logs.filter(e => e.type === 'SANITY_PANIC').length, 1);
  assert.equal(engine.logger.logs.filter(e => e.type === 'SANITY_RECOVER').length, 1);
});

test('initial panic blocks exactly round one, preserves opening skill and retains higher recovery', t => {
  const a = unit('a', { sanity: { initial: -50 }, openingSkill: wait });
  const engine = battle(a);
  t.mock.method(Formulas, 'determineActionOrder', () => [a, a]);
  engine.roundStart = () => a.changeSanity(90, engine.logger, { engine });
  turn(engine, 1);
  assert.equal(a.hasActed, false);
  assert.equal(a.sanity.value, 40);
  assert.equal(a.canAct(), true);
  engine.roundStart = null;
  turn(engine, 2);
  assert.equal(a.hasActed, true);
  assert.equal(engine.logger.logs.filter(e => e.skillId === 'wait').length, 1);
});

test('round-start and final-slot panic both include the next entire round', t => {
  for (const atStart of [true, false]) {
    const a = unit('a', { sanity: {}, normalAttack: wait });
    const b = unit('b', { team: 'B', normalAttack: change(-50) });
    const engine = battle(a, b, { roundStart: atStart
      ? e => { if (e.currentTurn === 1) a.changeSanity(-50, e.logger, { engine: e }); } : undefined });
    t.mock.method(Formulas, 'determineActionOrder', () => atStart ? [a] : [a, b]);
    turn(engine, 1);
    assert.equal(a.sanity.panicUntil, 2);
    t.mock.method(Formulas, 'determineActionOrder', () => [a]);
    turn(engine, 2);
    assert.equal(a.isPanicked(), false);
    assert.equal(engine.logger.logs.filter(e => e.type === 'SKILL_TEXT').length, atStart ? 0 : 1);
  }
});

test('panic interrupts remaining damage hits/actions but keeps completed damage and reactions', t => {
  t.mock.method(Formulas, 'isHit', () => true);
  const a = unit('a', { sanity: {} });
  const b = unit('b', { team: 'B', passives: [{ trigger: 'AFTER_DAMAGE_RECEIVED',
    action: (self, hit, out, engine) => hit.caster.changeSanity(-50, out, { engine }) }] });
  const engine = battle(a, b);
  const skill = new Skill({ id: 'multi', actions: [
    { type: 'DAMAGE', hits: 3 }, { type: 'HEAL', targetType: 'SELF', inheritTarget: false }
  ] });
  skill.execute(a, [a], [b], engine.logger, engine);
  assert.equal(engine.logger.logs.filter(e => e.type === 'DAMAGE').length, 1);
  assert.equal(engine.logger.logs.some(e => e.type === 'HEAL'), false);
  assert.ok(b.stats.hp < 1000);
  assert.equal(a.isPanicked(), true);
});

test('panic blocks counter, luck, direct/triggered casts and ignoreSp without RNG or SP cost', t => {
  const a = unit('a', { sanity: { initial: -50 } });
  const b = unit('b', { team: 'B' });
  const engine = battle(a, b, { luckEvents: { enabled: true }, skillResolver: () => wait });
  const random = t.mock.method(Math, 'random', () => { throw new Error('unexpected RNG'); });
  assert.equal(a.canAct(), false);
  assert.equal(wait.canCast(a, engine, { ignoreSp: true }), false);
  assert.equal(engine.tryCounter(b, a, wait), false);
  assert.equal(engine.tryLuckEvent(a), false);
  engine.castSkill(a, ['wait']);
  wait.execute(a, [a], [b], engine.logger, engine, { ignoreSp: true });
  assert.equal(engine.logger.logs.length, 0);
  assert.equal(a.stats.sp, 100);
  assert.equal(random.mock.callCount(), 0);
});

test('a counter can panic the attacker and stop every remaining hit', t => {
  t.mock.method(Formulas, 'isHit', () => true);
  t.mock.method(Formulas, 'isCounter', () => true);
  const a = unit('a', { sanity: {} });
  const b = unit('b', { team: 'B', counterSkill: change(-50) });
  const engine = battle(a, b);
  const attack = new Skill({ id: 'attack', actions: [{ type: 'DAMAGE', hits: 3 }] });
  attack.execute(a, [a], [b], engine.logger, engine);
  assert.equal(a.isPanicked(), true);
  assert.equal(engine.logger.logs.filter(e => e.type === 'COUNTER').length, 1);
  assert.equal(b.stats.hp, 1000);
});

test('DOT/HOT, protection and buff timing remain active; scheduled casts cannot bypass panic', t => {
  const a = unit('a', { sanity: { initial: -50 }, buffs: [
    { id: 'dot', type: 'DOT', value: 10, duration: 2 },
    { id: 'hot', type: 'HOT', value: 3, duration: 2 },
    { id: 'shield', invincible: true, duration: 2 },
    { id: 'scheduled', trigger: 'ROUND_START', remainingTriggers: 1, skillIds: ['wait'] },
    { id: 'charge', trigger: 'BEFORE_ACTION', remainingTriggers: 1, skillIds: ['wait'] }
  ] });
  const engine = battle(a, undefined, { skillResolver: () => wait });
  t.mock.method(Formulas, 'determineActionOrder', () => [a]);
  const outcome = a.takeDamage(10, engine.logger, { action: { type: 'DAMAGE' } });
  assert.equal(outcome.damage, 0);
  turn(engine, 1);
  assert.equal(a.stats.hp, 993);
  assert.equal(a.buffs.find(b => b.id === 'dot').duration, 1);
  assert.equal(a.buffs.some(b => b.id === 'scheduled'), false);
  assert.equal(a.buffs.find(b => b.id === 'charge').remainingTriggers, 1);
  assert.equal(engine.logger.logs.some(e => e.type === 'SKILL_TEXT'), false);
  turn(engine, 2);
  assert.equal(engine.logger.logs.filter(e => e.type === 'SKILL_TEXT').length, 1);
});

test('self-panic in BEFORE_ACTION cancels normal action and child CAST_SKILL', t => {
  const selfPanic = new Skill({ id: 'panic', actions: [
    { type: 'CHANGE_SANITY', amount: -50, targetType: 'SELF' },
    { type: 'CAST_SKILL', skillIds: ['wait'] }
  ] });
  const a = unit('a', { sanity: {}, normalAttack: wait, buffs: [
    { id: 'charge', trigger: 'BEFORE_ACTION', remainingTriggers: 1, skillIds: ['panic'] }
  ] });
  const engine = battle(a, undefined, { skillResolver: id => id === 'panic' ? selfPanic : wait });
  t.mock.method(Formulas, 'determineActionOrder', () => [a]);
  turn(engine, 1);
  assert.equal(a.isPanicked(), true);
  assert.equal(a.hasActed, false);
  assert.equal(engine.logger.logs.some(e => e.type === 'SKILL_TEXT'), false);
});

test('sanity effects do not inherit onto summons and initial summon panic uses arrival round', () => {
  const a = unit('a', { sanity: {} });
  const engine = battle(a, undefined, { summonFactory: (id, { entityId }) =>
    unit(entityId, id === 'panic' ? { sanity: { initial: -50 } } : {}) });
  engine.currentTurn = 4;
  const summon = new Skill({ id: 'summon', actions: [
    { type: 'SUMMON', monsterId: 'plain', maxAlive: 3 },
    { type: 'SUMMON', monsterId: 'panic', maxAlive: 3 }
  ] });
  summon.execute(a, engine.teamA, engine.teamB, engine.logger, engine);
  assert.equal(engine.teamA[1].sanity, null);
  assert.equal(engine.teamA[2].sanity.panicUntil, 5);
});

test('victory and death do not produce post-battle recovery', t => {
  const a = unit('a', { sanity: { initial: 20 } });
  const b = unit('b', { team: 'B' });
  const engine = battle(a, b, { roundStart: e => { b.isAlive = false; e.checkWinCondition(); } });
  t.mock.method(Formulas, 'determineActionOrder', () => []);
  turn(engine, 1);
  assert.equal(a.sanity.value, 20);
  assert.equal(engine.logger.logs.some(e => e.source === 'ROUND_RECOVERY'), false);
  a.isAlive = false;
  a.sanity.endRound(a, engine.logger, { currentTurn: 2 });
  assert.equal(a.sanity.value, 20);
});

test('nested changes retain event order and cyclic passives fail with a useful error', () => {
  const seen = [];
  const a = unit('a', { sanity: {}, passives: [
    { trigger: 'ON_SANITY_CHANGE', action: (self, e, out) => {
      seen.push(`value:${e.after}`);
      if (e.after === -10) self.changeSanity(20, out);
    } },
    { trigger: 'ON_SANITY_STATE_CHANGE', action: (self, e) => seen.push(`state:${e.state}`) }
  ] });
  a.changeSanity(-10, logger());
  assert.deepEqual(seen, ['value:-10', 'state:SHAKEN', 'value:10', 'state:INSPIRED']);
  const b = unit('b', { sanity: {}, passives: [{ trigger: 'ON_SANITY_CHANGE',
    action: (self, e) => self.changeSanity(e.after > 0 ? -2 : 2) }] });
  assert.throws(() => b.changeSanity(1), /reaction cycle/);
});

test('disabled sanity preserves seeded results, log contents and random draw count', t => {
  function run(explicit) {
    let seed = 17;
    let draws = 0;
    t.mock.method(Math, 'random', () => {
      draws++;
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    });
    const attack = new Skill({ id: 'attack', actions: [{ type: 'DAMAGE' }] });
    const config = explicit ? { sanity: false } : {};
    const a = unit('a', { ...config, normalAttack: attack });
    const b = unit('b', { ...config, team: 'B', normalAttack: attack });
    const result = battle(a, b, { maxTurns: 4 }).start();
    return { winner: result.winner, logs: result.logs, hp: [a.stats.hp, b.stats.hp], draws };
  }
  assert.deepEqual(run(false), run(true));
});

test('invalid custom rule outputs fail clearly instead of corrupting combat math', () => {
  for (const config of [null, false, true, []]) assert.throws(() => createSanityRules(config), /object/);
  const a = unit('a', { sanity: { rules: { castRateModifier: () => NaN } } });
  assert.throws(() => a.getEffectiveStats(), /castRateModifier/);
  for (const amount of [-1, Infinity, NaN]) {
    const b = unit('b', { sanity: { rules: { recoveryAmount: () => amount } } });
    assert.throws(() => b.sanity.endRound(b, logger(), { currentTurn: 1 }), /recoveryAmount/);
  }
});

test('AoE stops before the next target when a sanity reaction panics the caster', () => {
  const a = unit('a', { sanity: {} });
  const b = unit('b', { team: 'B', sanity: {}, passives: [{ trigger: 'ON_SANITY_CHANGE',
    action: (self, event, out, engine) => event.caster.changeSanity(-50, out, { engine }) }] });
  const c = unit('c', { team: 'B', sanity: {} });
  const engine = new BattleEngine([a], [b, c]);
  change(-10).execute(a, [a], [b, c], engine.logger, engine);
  assert.equal(a.isPanicked(), true);
  assert.equal(b.sanity.value, -10);
  assert.equal(c.sanity.value, 0);
});

test('side-swap targeting applies to sanity effects without changing teams', () => {
  const a = unit('a', { sanity: {} });
  const b = unit('b', { team: 'B', sanity: {} });
  const engine = battle(a, b);
  engine.withActionTargetOverride(a, { swapSides: true }, () =>
    change(-10).execute(a, [a], [b], engine.logger, engine));
  assert.equal(a.sanity.value, -10);
  assert.equal(b.sanity.value, 0);
  assert.equal(a.team, 'A');
});

test('recovery reactions can panic another unit at round end without recovering it immediately', t => {
  const b = unit('b', { team: 'B', sanity: {} });
  const a = unit('a', { sanity: { initial: -5 }, passives: [{ trigger: 'ON_SANITY_CHANGE',
    enabled: (self, event) => event.source === 'ROUND_RECOVERY',
    action: (self, event, out, engine) => b.changeSanity(-50, out, { engine }) }] });
  const engine = battle(a, b);
  t.mock.method(Formulas, 'determineActionOrder', () => []);
  turn(engine, 1);
  assert.equal(b.sanity.value, -50);
  assert.equal(b.sanity.panicUntil, 2);
  turn(engine, 2);
  assert.equal(b.sanity.value, 0);
  assert.equal(b.isPanicked(), false);
});
