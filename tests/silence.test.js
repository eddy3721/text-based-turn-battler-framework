const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Entity, Skill, BattleEngine, Buff } = require('../src');
const Formulas = require('../src/utils/Formulas');

const attack = new Skill({ id: 'attack', name: '攻擊', actions: [{ type: 'DAMAGE', power: 1 }] });
const bolt = new Skill({ id: 'bolt', name: '魔力彈', tags: ['spell'],
  actions: [{ type: 'DAMAGE', power: 1, stat: 'int' }] });
const fireball = new Skill({ id: 'fireball', name: '火球', tags: ['spell'],
  actions: [{ type: 'DAMAGE', power: 3, stat: 'int' }] });
const slash = new Skill({ id: 'slash', name: '斬擊', actions: [{ type: 'DAMAGE', power: 2 }] });
const spellsOnly = { filter: skill => skill.tags.includes('spell') };

const unit = (id, team, { stats, ...extra } = {}) => new Entity({ id, name: id, team,
  // 施放率 1：技能抽選必中，固定的 Math.random 只決定抽到哪一招。
  stats: { hp: 100000, maxHp: 100000, atk: 10, int: 50, sp: 200, spd: 10, skillCastRate: 1, ...stats },
  normalAttack: attack, ...extra });

// 跑幾個行動槽，回傳 a 的出手紀錄與沉默行。
function run(t, a, roll, buff) {
  t.mock.method(Formulas, 'isHit', () => true);
  t.mock.method(Formulas, 'isCritical', () => false);
  t.mock.method(Formulas, 'isCounter', () => false);
  // 只讓 a 出手，亂數就只花在 a 的技能抽選與傷害浮動上。
  t.mock.method(Formulas, 'determineActionOrder', () => [a, a]);
  t.mock.method(Math, 'random', () => roll);
  const b = unit('b', 'B', { normalAttack: new Skill({ id: 'idle', name: '待機', actions: [] }) });
  const engine = new BattleEngine([a], [b], { luckEvents: { enabled: false } });
  if (buff) a.addBuff({ id: 'mute', name: '沉默', type: 'STAT', duration: 99, ...buff }, engine);
  engine.maxTurns = 2;
  engine.start();
  return {
    slots: engine.actionSlots.filter(slot => slot.actor === a).map(slot => slot.skill.id),
    silenced: engine.logger.logs.filter(log => log.type === 'SILENCED'),
    logs: engine.logger.logs
  };
}

test('silence: true blocks lottery skills and falls back to the normal attack', t => {
  const { slots, silenced } = run(t, unit('a', 'A', { skills: [slash] }), 0, { silence: true });
  assert.ok(slots.length >= 2);
  assert.ok(slots.every(id => id === 'attack'), '技能被擋就改用普攻');
  assert.equal(silenced.length, slots.length, '每個被擋的槽各一行');
  assert.equal(silenced[0].skillId, 'slash');
  assert.equal(silenced[0].message, 'a 被沉默封住，無法使用 斬擊！');
});

test('without silence the same rolls cast the skill, so the lottery is unchanged', t => {
  const { slots, silenced } = run(t, unit('a', 'A', { skills: [slash] }), 0);
  assert.ok(slots.every(id => id === 'slash'));
  assert.equal(silenced.length, 0);
});

test('a filter only blocks matching skills and keeps the draw over all castable skills', t => {
  // 兩招都可施放：0.6 × 2 → 第 1 招（火球）被擋，0.1 × 2 → 第 0 招（斬擊）照放。
  const blocked = run(t, unit('a', 'A', { skills: [slash, fireball] }), 0.6, { silence: spellsOnly });
  assert.ok(blocked.slots.every(id => id === 'attack'));
  const allowed = run(t, unit('a', 'A', { skills: [slash, fireball] }), 0.1, { silence: spellsOnly });
  assert.ok(allowed.slots.every(id => id === 'slash'));
  assert.equal(allowed.silenced.length, 0);
});

test('a silenced normal attack becomes a plain ATK strike charged like a basic attack', t => {
  const a = unit('a', 'A', { normalAttack: bolt });
  const { slots, silenced, logs } = run(t, a, 0.5, { silence: spellsOnly });
  assert.ok(slots.every(id => id === 'silenced_strike'));
  assert.equal(silenced[0].skillId, 'bolt');
  const hit = logs.find(log => log.type === 'DAMAGE' && log.actorId === 'a');
  assert.equal(hit.isNormalAttack, true, '替代攻擊佔普攻的位置');
  assert.ok(a.stats.sp < 200, '照普攻逐擊收費');
});

test('one line per slot even when both the skill and the normal attack are blocked', t => {
  const a = unit('a', 'A', { normalAttack: bolt, skills: [fireball] });
  const { slots, silenced } = run(t, a, 0, { silence: spellsOnly });
  assert.equal(silenced.length, slots.length);
  assert.equal(silenced[0].skillId, 'fireball', '寫原本想用的那一招');
});

test('a custom fallback and message replace the defaults', t => {
  const staff = new Skill({ id: 'staff', name: '杖擊', actions: [{ type: 'DAMAGE', power: 0.5 }] });
  const a = unit('a', 'A', { normalAttack: bolt });
  const { slots, silenced } = run(t, a, 0.5, { silence: { ...spellsOnly, fallback: staff },
    message: ({ entity, skill }) => `${entity.name} 張口想詠唱 ${skill.name}，卻發不出聲音。` });
  assert.ok(slots.every(id => id === 'staff'));
  assert.equal(silenced[0].message, 'a 張口想詠唱 魔力彈，卻發不出聲音。');
});

test('silence blocks the opening skill but leaves counters alone', t => {
  const a = unit('a', 'A', { openingSkill: slash, stats: { skillCastRate: 0 } });
  const { slots } = run(t, a, 0.5, { silence: true });
  assert.equal(slots[0], 'attack');
  const muted = unit('m', 'A', { counterSkill: fireball });
  muted.addBuff({ id: 'mute', type: 'STAT', duration: 9, silence: true });
  assert.equal(muted.silencedBy(fireball)?.id, 'mute', '技能本身算被擋');
  assert.equal(muted.counterSkill, fireball, '反擊不經過沉默檢查');
});

test('silence expires with its duration', t => {
  const a = unit('a', 'A', { skills: [slash] });
  const { slots } = run(t, a, 0, { silence: true, duration: 1 });
  assert.equal(slots[0], 'attack');
  assert.ok(slots.slice(1).includes('slash'), '沉默一個行動槽後恢復');
});

test('invalid silence configs throw', () => {
  assert.throws(() => new Buff({ id: 'x', type: 'STAT', duration: 1, silence: { filter: 1 } }));
  assert.throws(() => new Buff({ id: 'x', type: 'STAT', duration: 1, silence: { fallback: {} } }));
  assert.throws(() => new Buff({ id: 'x', type: 'STAT', duration: 1, silence: 'yes' }));
  assert.throws(() => new Buff({ id: 'x', type: 'STAT', duration: 1, silence: true, message: 3 }));
  assert.equal(new Buff({ id: 'x', type: 'STAT', duration: 1, silence: false }).silence, undefined);
});
