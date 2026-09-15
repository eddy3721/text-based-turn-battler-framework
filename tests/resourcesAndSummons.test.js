const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Entity, Skill, BattleEngine } = require('../src');
const Formulas = require('../src/utils/Formulas');
const entity = (id, team = 'A', extra = {}) => new Entity({ id, name: id, team,
  stats: { hp: 100, maxHp: 100, atk: 10, sp: 20, spd: 10, ...extra } });
const logger = () => ({ logs: [], addLog(log) { this.logs.push(log); } });

test('HP/SP recovery returns actual capped amounts, never revives and preserves legacy maxSp', () => {
  const e = entity('a');
  assert.equal(e.stats.maxSp, 20);
  e.stats.sp = 19;
  assert.equal(e.restoreSp(8), 1);
  assert.equal(e.restoreSp(8), 0);
  e.stats.hp = 98;
  assert.equal(e.heal(10), 2);
  const explicit = entity('b', 'A', { sp: 5, maxSp: 40 });
  assert.equal(explicit.restoreSp(50), 35);
  e.takeDamage(100, logger());
  assert.equal(e.heal(100), 0);
  assert.equal(e.restoreSp(10), 0);
  assert.equal(e.isAlive, false);
});

test('refresh is opt-in; legacy same-id buffs still stack', () => {
  const e = entity('a');
  const config = { id: 'p', type: 'STAT', duration: 3, effect: s => { s.atk *= 2; } };
  e.addBuff(config); e.addBuff(config);
  assert.equal(e.getEffectiveStats().atk, 40);
  e.addBuff({ ...config, stackPolicy: 'refresh' });
  assert.equal(e.getEffectiveStats().atk, 20);
  e.tickBuffs(); e.addBuff({ ...config, stackPolicy: 'refresh' });
  assert.equal(e.buffs.length, 1);
  assert.equal(e.buffs[0].duration, 3);
});

test('summons have unique IDs, limits, next-turn actions and survive their summoner', t => {
  const king = entity('king', 'B');
  const player = entity('summon_1');
  const summon = new Skill({ id: 's', actions: [{ type: 'SUMMON', monsterId: 'g', maxAlive: 2, maxTotal: 4, spCost: 1 }] });
  king.openingSkill = summon;
  king.normalAttack = new Skill({ id: 'wait', actions: [{ type: 'TEXT' }] });
  const engine = new BattleEngine([player], [king], { summonFactory: (_, options) => entity(options.entityId, 'B') });
  // King gets two slots, but opening summon must happen only once.
  t.mock.method(Formulas, 'determineActionOrder', () => [king, king]);
  engine.executeTurn();
  assert.equal(engine.teamB.length, 2);
  const first = engine.teamB[1];
  assert.notEqual(first.id, player.id);
  assert.equal(first.hasActed, false);
  t.mock.method(Formulas, 'determineActionOrder', es => es.filter(e => e.isAlive));
  engine.executeTurn();
  assert.equal(first.hasActed, true);
  summon.execute(king, engine.teamB, engine.teamA, engine.logger, engine);
  assert.equal(summon.canCast(king, engine), false);
  const sp = king.stats.sp;
  summon.execute(king, engine.teamB, engine.teamA, engine.logger, engine);
  assert.equal(king.stats.sp, sp);
  first.takeDamage(100, engine.logger);
  assert.equal(summon.canCast(king, engine), true);
  summon.execute(king, engine.teamB, engine.teamA, engine.logger, engine);
  engine.teamB[2].takeDamage(100, engine.logger);
  summon.execute(king, engine.teamB, engine.teamA, engine.logger, engine);
  engine.teamB[3].takeDamage(100, engine.logger);
  assert.equal(summon.canCast(king, engine), false);
  assert.equal(engine.summonCounts.get(king.id), 4);
  king.takeDamage(100, engine.logger);
  engine.checkWinCondition();
  assert.equal(engine.result, null);
  engine.teamB[4].takeDamage(100, engine.logger);
  engine.checkWinCondition();
  assert.equal(engine.result, 'TEAM_A');
  assert.equal(new Set([...engine.teamA, ...engine.teamB].map(e => e.id)).size, 6);
});

test('RESTORE_SP and SUMMON logs compose from text fragments like every other action', () => {
  const chef = entity('chef');
  const restore = (text) => {
    const ally = entity('ally');
    ally.stats.sp = 0;
    const log = logger();
    new Skill({ id: 'feast', name: '佳餚', actions: [{ type: 'RESTORE_SP', targetType: 'ALLY_ALL', amount: 8, text }] })
      .execute(chef, [ally], [], log);
    return log.logs.at(-1).message;
  };
  assert.equal(restore(undefined), 'chef 的佳餚使 ally 回復了 8 SP！');
  assert.equal(restore({ action: '', recover: ctx => `${ctx.target.name} 恢復了 ${ctx.value} SP！` }), 'ally 恢復了 8 SP！');

  const king = entity('king', 'B');
  const engine = new BattleEngine([entity('hero')], [king], { summonFactory: (_, o) => entity(o.entityId, 'B') });
  const summonWith = (text) => {
    const skill = new Skill({ id: 's', name: '集結', actions: [{ type: 'SUMMON', monsterId: 'g', text }] });
    engine.summon(king, skill.actions[0], skill);
    return engine.logger.logs.at(-1).message;
  };
  assert.equal(summonWith(undefined), `king 召來了 ${engine.teamB.at(-1).name}！`);
  assert.equal(summonWith({ action: '', summon: ctx => `${ctx.target.name} 爬了出來！` }), `${engine.teamB.at(-1).name} 爬了出來！`);
});

test('dead or stunned opening caster cannot summon; ordinary engine needs no factory', t => {
  const a = entity('a'), b = entity('b', 'B');
  b.openingSkill = new Skill({ id: 's', actions: [{ type: 'SUMMON', monsterId: 'g' }] });
  const engine = new BattleEngine([a], [b]);
  assert.equal(b.openingSkill.canCast(b, engine), false);
  assert.equal(b.openingSkill.canCast(b), false);
  engine.summonFactory = (_, options) => entity(options.entityId, 'B');
  b.addBuff({ id: 'stun', type: 'STUN', duration: 1 });
  t.mock.method(Formulas, 'determineActionOrder', () => [b]);
  engine.executeTurn();
  assert.equal(b.hasActed, false);
  assert.equal(engine.teamB.length, 1);
  engine.executeTurn();
  assert.equal(engine.teamB.length, 2);
  b.takeDamage(100, engine.logger);
  assert.equal(engine.canSummon(b, b.openingSkill.actions[0]), false);
});

test('a factory returning nothing means no reinforcement was available, not a crash', t => {
  t.mock.method(Formulas, 'isHit', () => true);
  const caller = new Entity({ id: 'caller', name: '灰燼', team: 'A',
    stats: { hp: 100, maxHp: 100, sp: 50, atk: 10, spd: 10 } });
  const foe = new Entity({ id: 'foe', name: '敵', team: 'B',
    stats: { hp: 100, maxHp: 100, sp: 0, atk: 10, spd: 1 } });
  const sign = new Skill({ id: 'sign', name: '白色召喚印記', actions: [{
    type: 'SUMMON', monsterId: 'phantom', maxTotal: 1, maxAlive: 1, spCost: 10,
    text: { summon: ctx => `的印記亮起，${ctx.target.name} 回應了召喚！`, fail: () => '放下了印記，但沒有人回應。' }
  }] });
  const engine = new BattleEngine([caller], [foe], { summonFactory: () => null });

  sign.execute(caller, [caller], [foe], engine.logger, engine);
  assert.deepEqual(engine.logger.logs.map(log => log.type), ['SUMMON_FAILED']);
  assert.equal(engine.logger.logs[0].message, '灰燼 放下了印記，但沒有人回應。');
  assert.equal(engine.teamA.length, 1);
  assert.equal(caller.stats.sp, 40); // 印記還是用掉了
  // 嘗試本身計入 maxTotal，所以不會每個行動槽重試一次把戰報洗滿。
  assert.equal(sign.canCast(caller, engine), false);
});

test('the default failure line reuses the summon action prefix', t => {
  const caller = new Entity({ id: 'caller', name: '灰燼', team: 'A',
    stats: { hp: 100, maxHp: 100, sp: 50, atk: 10, spd: 10 } });
  const sign = new Skill({ id: 'sign', name: '印記',
    actions: [{ type: 'SUMMON', monsterId: 'phantom' }] });
  const engine = new BattleEngine([caller], [], { summonFactory: () => undefined });
  sign.execute(caller, [caller], [], engine.logger, engine);
  assert.equal(engine.logger.logs[0].message, '灰燼 沒有得到任何回應。');
});

test('a factory can mark a summon hostile so it joins the opposing side', t => {
  const caller = new Entity({ id: 'caller', name: '灰燼', team: 'A',
    stats: { hp: 100, maxHp: 100, sp: 50, atk: 10, spd: 10 } });
  const foe = new Entity({ id: 'foe', name: '敵', team: 'B',
    stats: { hp: 100, maxHp: 100, sp: 0, atk: 10, spd: 1 } });
  const sign = new Skill({ id: 'sign', name: '印記', actions: [{
    type: 'SUMMON', monsterId: 'spirit', maxTotal: 1, maxAlive: 1,
    text: { summon: ctx => ctx.hostile ? `遭到暗靈 ${ctx.target.name} 入侵！` : `已召喚靈體 ${ctx.target.name}。` }
  }] });
  const engine = new BattleEngine([caller], [foe], {
    summonFactory: (id, options) => Object.assign(new Entity({
      id: options.entityId, name: '入侵者', team: 'A',
      stats: { hp: 50, maxHp: 50, sp: 0, atk: 10, spd: 5 }
    }), { summonHostile: true })
  });

  sign.execute(caller, [caller], [foe], engine.logger, engine);
  assert.equal(engine.teamA.length, 1); // 沒有加入召喚者這邊
  assert.equal(engine.teamB.length, 2);
  const invader = engine.teamB[1];
  assert.equal(invader.team, 'B');
  assert.equal(invader.summonerId, caller.id); // 仍然追得回是誰招來的
  assert.equal(engine.logger.logs[0].message, '灰燼 遭到暗靈 入侵者 入侵！');
  // maxAlive 掃兩邊，敵對增援一樣佔名額。
  assert.equal(sign.canCast(caller, engine), false);
});

test('a friendly summon still joins the caster side and reports hostile as false', t => {
  const caller = new Entity({ id: 'caller', name: '灰燼', team: 'A',
    stats: { hp: 100, maxHp: 100, sp: 50, atk: 10, spd: 10 } });
  const sign = new Skill({ id: 'sign', name: '印記', actions: [{
    type: 'SUMMON', monsterId: 'spirit',
    text: { summon: ctx => ctx.hostile ? '入侵！' : `已召喚靈體 ${ctx.target.name}。` }
  }] });
  const engine = new BattleEngine([caller], [], {
    summonFactory: (id, options) => new Entity({ id: options.entityId, name: '白靈', team: 'B',
      stats: { hp: 50, maxHp: 50, sp: 0, atk: 10, spd: 5 } })
  });
  sign.execute(caller, [caller], [], engine.logger, engine);
  assert.equal(engine.teamA.length, 2);
  assert.equal(engine.teamA[1].team, 'A'); // 工廠給的 team 被召喚者的陣營蓋掉
  assert.equal(engine.logger.logs[0].message, '灰燼 已召喚靈體 白靈。');
});
