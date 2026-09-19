const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Entity, Skill, BattleEngine, Formulas } = require('../src');

const strike = (actions = [{ type: 'DAMAGE', hits: 3 }]) => new Skill({ id: 'strike', name: '斬擊', actions });
// 反擊率有上限（見 Formulas 的 COUNTER_CEILING），點數再高也不可能必定反擊，
// 所以「反擊發生之後會怎樣」的測試一律直接壓住判定；曲線本身另外測。
function setup(t, attack = strike()) {
  t.mock.method(Formulas, 'isHit', () => true);
  t.mock.method(Formulas, 'isCritical', () => false);
  t.mock.method(Formulas, 'calculateDamage', () => 10);
  t.mock.method(Formulas, 'isCounter', () => true);
  const make = (id, team) => new Entity({ id, name: id, team,
    stats: { hp: 100, maxHp: 100, sp: 30, atk: 10, spd: 1000, counter: 100 }, normalAttack: strike() });
  const a = make('a', 'A'); const b = make('b', 'B');
  const engine = new BattleEngine([a], [b]);
  const run = () => attack.execute(a, [a], [b], engine.logger, engine);
  return { a, b, engine, run };
}

test('every landed hit rolls its own parry, each replying immediately without recursion or buff ticks', t => {
  const { a, b, engine, run } = setup(t);
  b.addBuff({ id: 'test', type: 'STAT', duration: 2 });
  run();
  // counter=1：三擊全被招架，攻擊方一點傷害都打不出去，自己挨三下還擊。
  assert.equal(a.stats.hp, 70);
  assert.equal(b.stats.hp, 100);
  assert.equal(b.stats.sp, 27);
  assert.equal(b.buffs[0].duration, 2);
  assert.equal(b.hasActed, false);
  assert.deepEqual(engine.logger.logs.map(l => l.type), ['COUNTER', 'COUNTER', 'COUNTER']);
  assert.equal(engine.logger.logs[0].value, 10);
  assert.equal(engine.logger.logs[0].isNormalAttack, true);
  // 開頭沿用被反制那一擊的文案：斬擊沒有自訂 text，用的是 DAMAGE 的預設開頭。
  assert.equal(engine.logger.logs[0].message, 'a 攻擊，但是遭b反擊，受到 10 點傷害！');
  assert.equal(engine.logger.logs[1].message, '第 2 擊，但是遭b反擊，受到 10 點傷害！');
});

test('the counter line reuses the parried hit own lead instead of restating the skill', t => {
  // 多段技能通常會先獨立宣告一次技能名，之後每擊只印「第 N 擊，」。
  // 反擊取代的是其中一擊，所以不能再複述一次技能名。
  const announced = new Skill({ id: 'strike', name: '斬擊', actions: [{
    type: 'DAMAGE', hits: 2,
    text: { action: ctx => `${ctx.caster.name} 使出了 ${ctx.skill.name}，`, combo: ctx => `第 ${ctx.hitIndex} 擊，` }
  }] });
  const { engine, run } = setup(t, announced);
  let rolls = 0;
  t.mock.method(Formulas, 'isCounter', () => ++rolls === 2);
  run();
  const counter = engine.logger.logs.find(l => l.type === 'COUNTER');
  assert.equal(counter.message, '第 2 擊，但是遭b反擊，受到 10 點傷害！');
  assert.doesNotMatch(counter.message, /使出了/);
});

test('a miss never consumes a roll; every other hit rolls once and a failed roll does not block later hits', t => {
  const attack = strike([{ type: 'DAMAGE' }, { type: 'DAMAGE', hits: 3 }]);
  const { b, engine, run } = setup(t, attack);
  let hit = 0; let rolls = 0;
  t.mock.method(Formulas, 'isHit', () => ++hit !== 1);
  t.mock.method(Formulas, 'isCounter', () => { rolls++; return false; });
  run();
  // 四擊，第一擊落空不判定，其餘三擊各判定一次。
  assert.equal(rolls, 3);
  assert.equal(b.stats.hp, 70);
  assert.equal(engine.logger.logs[0].type, 'MISS');
});

test('lethal reply cancels remaining attack and settles death once', t => {
  const { a, b, engine, run } = setup(t);
  a.stats.hp = 5;
  run();
  assert.equal(b.stats.hp, 100);
  assert.equal(engine.result, 'TEAM_B');
  assert.equal(engine.logger.logs.filter(l => l.type === 'DEATH').length, 1);
});

// 判定必成功都還擋得住，才證明這兩條是硬性前置條件而不是機率問題。
test('stun prevents counter and direct/DOT damage never rolls, even when the roll would succeed', t => {
  const { a, b, engine, run } = setup(t);
  b.addBuff({ id: 'stun', type: 'STUN', duration: 2 });
  run();
  assert.equal(b.stats.hp, 70);
  assert.equal(a.stats.hp, 100);
  b.buffs = [];
  b.takeDamage(10, engine.logger, { engine });
  assert.equal(a.stats.hp, 100);
  assert.equal(b.stats.hp, 60);
});

test('counter chance rides the technique gap and never truncates the weaker side to zero', () => {
  const ceiling = Formulas.counterChance({ stats: { counter: 0 } }, { stats: { counter: 1e9 } });
  const at = (defender, attacker) => Formulas.counterChance({ stats: { counter: attacker } }, { stats: { counter: defender } });
  assert.equal(at(100, 100), ceiling / 2, '技巧相同 → 上限的一半');
  assert.equal(at(400, 400), ceiling / 2, '只看差值，絕對值高低不影響');
  // 技巧輸人仍然打得出反擊，只是機率低——這正是不用 max(0, 差值) 的理由。
  assert.ok(at(100, 200) > 0 && at(100, 200) < ceiling / 2);
  assert.ok(at(100, 400) > 0 && at(100, 400) < at(100, 200), '差距越大越低，但不歸零');
  assert.ok(at(200, 100) > ceiling / 2 && at(200, 100) < ceiling, '技巧壓過對手 → 高於一半、不超過上限');
  // 同樣差 100 點，兩邊一起變強也不改變結果。
  assert.equal(at(200, 100), at(500, 400));
  // 0 點是「不參與反擊」的開關，不是「技巧最低」。
  assert.equal(Formulas.counterChance({ stats: {} }, { stats: {} }), 0);
  assert.equal(Formulas.counterChance({ stats: { counter: 1e9 } }, { stats: {} }), 0);
});

test('skill reply pays SP, applies damage-gated effects, and falls back without SP', t => {
  const { a, b, engine, run } = setup(t, strike([{ type: 'DAMAGE' }]));
  b.counterSkill = new Skill({ id: 'disarm', name: '劍神流・剝奪劍', actions: [
    { type: 'DAMAGE', spCost: 12 },
    { type: 'BUFF', requiresDamage: true, buffs: [{ id: 'disarm', type: 'STAT', duration: 2 }] }
  ] });
  run();
  assert.equal(b.stats.sp, 18);
  assert.equal(a.buffs[0].id, 'disarm');
  assert.match(engine.logger.logs[0].message, /以劍神流・剝奪劍反擊/);
  assert.doesNotMatch(engine.logger.logs[0].message, /[「」"']/);
  // 剛好夠一次普通反擊、不夠剝奪劍：先確認會退回 basic_counter 並把體力用光，
  // 下一次 run() 才問得出「連普通反擊都付不起時完全不反擊」。
  b.stats.sp = 1; run();
  assert.equal(engine.logger.logs.filter(l => l.type === 'COUNTER').at(-1).skillId, 'basic_counter');
  assert.equal(b.stats.sp, 0);
  const counterCount = engine.logger.logs.filter(l => l.type === 'COUNTER').length;
  run();
  assert.equal(engine.logger.logs.filter(l => l.type === 'COUNTER').length, counterCount);
});

test('counter reply cannot miss, but can be blocked or crit; parried damage does not apply gated buff', t => {
  const { a, b, engine, run } = setup(t, strike([
    { type: 'DAMAGE' }, { type: 'BUFF', requiresDamage: true, buffs: [{ id: 'bad', type: 'STAT', duration: 2 }] }
  ]));
  t.mock.method(Formulas, 'isHit', caster => caster === a);
  run(); assert.equal(b.buffs.length, 0); assert.equal(a.stats.hp, 90);
  assert.equal(engine.logger.logs.at(-1).type, 'COUNTER');
  assert.match(engine.logger.logs.at(-1).message, /受到 10 點傷害/);
  assert.doesNotMatch(engine.logger.logs.at(-1).message, /落空/);
  t.mock.method(Formulas, 'isHit', () => true);
  a.passives = [{ trigger: 'BEFORE_DAMAGE', action: (self, hit) => { hit.damage = 0; hit.blocked = true; } }];
  run(); assert.equal(a.stats.hp, 90); assert.equal(engine.logger.logs.at(-1).type, 'COUNTER');
  assert.match(engine.logger.logs.at(-1).message, /反擊被a擋下了/);
  a.passives = []; t.mock.method(Formulas, 'isCritical', () => true);
  run(); assert.equal(a.stats.hp, 75); assert.equal(engine.logger.logs.at(-1).isCrit, true);
  assert.match(engine.logger.logs.at(-1).message, /會心一擊！受到 15 點傷害/);
});

test('AoE lets every living target roll on every hit it receives', t => {
  const attack = strike([{ type: 'DAMAGE', targetType: 'ENEMY_ALL', hits: 2 }]);
  const { a, b, engine } = setup(t, attack);
  const c = new Entity({ id: 'c', name: 'c', team: 'B', stats: { ...b.stats } });
  engine.teamB.push(c);
  attack.execute(a, [a], [b, c], engine.logger, engine);
  // 兩個目標 × 兩擊 = 四次招架，兩人都毫髮無傷。
  assert.equal(a.stats.hp, 60); assert.equal(b.stats.hp, 100); assert.equal(c.stats.hp, 100);
  assert.equal(engine.logger.logs.filter(l => l.type === 'COUNTER').length, 4);
});

test('each nested cast rolls separately, but counter-derived skills still cannot counter recursively', t => {
  const child = strike([{ type: 'DAMAGE' }]);
  const wrapper = new Skill({ id: 'wrapper', actions: [{ type: 'CAST_SKILL', skillIds: ['strike'] },
    { type: 'CAST_SKILL', skillIds: ['strike'] }] });
  const { a, b, engine } = setup(t);
  engine.skillResolver = () => child;
  b.passives = [{ trigger: 'AFTER_DAMAGE_DEALT', enabled: (self, hit) => hit.skill.id === 'basic_counter',
    action: (self, hit, logger, ctx) => ctx.castSkill(self, ['strike'], { targets: [hit.target] }) }];
  wrapper.execute(a, [a], [b], engine.logger, engine);
  // 兩次 CAST_SKILL 是兩擊，各自判定，所以兩次都被招架。
  assert.equal(a.stats.hp, 60); assert.equal(b.stats.hp, 100);
  assert.equal(engine.logger.logs.filter(l => l.type === 'COUNTER').length, 2);
  // 還擊本身 10 點，加上被動追打的 10 點，都併進同一條 COUNTER。
  assert.equal(engine.logger.logs.find(l => l.type === 'COUNTER').value, 20);
  assert.equal(engine.logger.logs.filter(l => l.isCounter && l.type === 'DAMAGE').length, 0);
  assert.equal(engine.counterSource, null);
});

test('a delayed skill created by a counter retains its origin and cannot trigger counter', t => {
  const { a, b, engine, run } = setup(t, strike([{ type: 'DAMAGE' }]));
  b.counterSkill = new Skill({ id: 'delayed', actions: [{ type: 'BUFF', targetType: 'SELF', buffs: [{
    id: 'charge', trigger: 'BEFORE_ACTION', remainingTriggers: 1, skillIds: ['strike']
  }] }] });
  engine.skillResolver = () => strike([{ type: 'DAMAGE' }]);
  run();
  assert.equal(b.buffs[0].counterSource.actorId, 'b');
  engine.triggerBuffs(b, 'BEFORE_ACTION');
  assert.equal(a.stats.hp, 90);
  assert.equal(engine.logger.logs.filter(l => l.type === 'COUNTER').length, 1);
  assert.equal(engine.logger.logs.at(-1).isCounter, true);
  assert.equal(engine.counterSource, null);
});

test('counter context and call stack unwind if a reply throws', t => {
  const { b, engine, run } = setup(t);
  b.counterSkill = new Skill({ id: 'broken', actions: [{ type: 'HEAL', stat: 'unknown' }] });
  assert.throws(run, /unknown/);
  assert.equal(engine.counterSource, null); assert.equal(engine.skillCallStack.length, 0);
});

test('counterStyle detailed lets the reply keep its own lines instead of being folded in', t => {
  const parry = new Skill({
    id: 'parry', name: '盾反', counterStyle: 'detailed',
    actions: [{ type: 'DAMAGE', text: {
      action: ctx => `${ctx.caster.name} 反手將劍尖送進 ${ctx.target.name} 的胸膛，`,
      hit: ctx => `造成了 ${ctx.value} 點傷害！`
    } }]
  });
  const { a, b, engine, run } = setup(t, strike([{ type: 'DAMAGE' }]));
  b.counterSkill = parry;
  run();

  assert.deepEqual(engine.logger.logs.map(log => log.type), ['COUNTER', 'DAMAGE']);
  // 宣告行不再自己講結果，結果由還擊自己那一行負責。
  assert.equal(engine.logger.logs[0].message, 'a 攻擊，但是遭b以盾反反擊！');
  assert.equal(engine.logger.logs[1].message, 'b 反手將劍尖送進 a 的胸膛，造成了 10 點傷害！');
  // 換掉的只有句子：統計欄位兩種模式一致。
  assert.equal(engine.logger.logs[0].value, 10);
  assert.equal(engine.logger.logs[0].skillId, 'parry');
});

test('the summary style stays the default so existing counter reports do not move', t => {
  const plain = new Skill({ id: 'plain', name: '回擊', actions: [{ type: 'DAMAGE' }] });
  assert.equal(plain.counterStyle, 'summary');
  const { b, engine, run } = setup(t, strike([{ type: 'DAMAGE' }]));
  b.counterSkill = plain;
  run();
  assert.deepEqual(engine.logger.logs.map(log => log.type), ['COUNTER']);
  assert.equal(engine.logger.logs[0].message, 'a 攻擊，但是遭b以回擊反擊，受到 10 點傷害！');
});

test('an unknown counterStyle throws at construction instead of silently condensing', () => {
  assert.throws(() => new Skill({ id: 'oops', name: 'x', counterStyle: 'verbose' }),
    /unknown counterStyle "verbose"/);
});

// 判定必成功都擋得住，才證明 uncounterable 是硬性排除而不是降低機率。
test('an uncounterable skill never rolls, even when the roll would succeed', t => {
  const { a, b, engine, run } = setup(t, new Skill({ id: 'bomb', name: '爆炸', uncounterable: true,
    actions: [{ type: 'DAMAGE', hits: 2 }] }));
  let rolls = 0;
  t.mock.method(Formulas, 'isCounter', () => { rolls++; return true; });
  run();
  assert.equal(rolls, 0);
  assert.equal(a.stats.hp, 100);
  assert.equal(b.stats.hp, 80);
  assert.equal(engine.logger.logs.some(l => l.type === 'COUNTER'), false);
});

test('an uncounterable action only shields its own hits', t => {
  const { a, b, run } = setup(t, strike([
    { type: 'DAMAGE', uncounterable: true },
    { type: 'DAMAGE' }
  ]));
  run();
  // 第一擊照常命中，第二擊被反擊。
  assert.equal(b.stats.hp, 90);
  assert.equal(a.stats.hp, 90);
});

test('uncounterable must be a boolean on the skill and on a DAMAGE action', () => {
  assert.throws(() => new Skill({ id: 'oops', name: 'x', uncounterable: 'yes' }), /must be a boolean/);
  assert.throws(() => new Skill({ id: 'oops', name: 'x', actions: [{ type: 'HEAL', uncounterable: true }] }),
    /uncounterable requires a DAMAGE action/);
});
