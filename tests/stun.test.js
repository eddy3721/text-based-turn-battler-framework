const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Entity, Skill, BattleEngine } = require('../src');
const Formulas = require('../src/utils/Formulas');

const attack = new Skill({ id: 'attack', name: '攻擊', actions: [{ type: 'DAMAGE', power: 1 }] });
const unit = (id, team) => new Entity({ id, name: id, team,
  stats: { hp: 1000, maxHp: 1000, atk: 10, sp: 20, spd: 10 }, normalAttack: attack });

// 擲骰集中在行動槽開頭，所以一場戰鬥裡「無法行動」的次數才等於擲中的次數。
function runSlots(t, buffConfig, rolls) {
  t.mock.method(Formulas, 'isHit', () => true);
  t.mock.method(Formulas, 'isCritical', () => false);
  t.mock.method(Formulas, 'isCounter', () => false);
  let index = 0;
  t.mock.method(Math, 'random', () => rolls[index++ % rolls.length]);
  const a = unit('a', 'A'), b = unit('b', 'B');
  const engine = new BattleEngine([a], [b], { luckEvents: { enabled: false } });
  b.addBuff({ id: 'paralysis', name: '麻痺', duration: 99, ...buffConfig }, engine);
  engine.maxTurns = 3;
  try { engine.start(); } catch { /* 打不完是正常的，這裡只看行動槽 */ }
  return engine.logger.logs.filter(log => log.buffId === 'paralysis');
}

test('STUN chance defaults to 1 so existing stuns stay deterministic', t => {
  const blocked = runSlots(t, { type: 'STUN' }, [0.99]);
  assert.ok(blocked.length >= 3, '每個行動槽都該被擋下');
  assert.ok(blocked.every(log => log.message === 'b 無法行動！'));
  // 沒有 chance 的暈眩仍然讓 canAct() 為 false，反擊與幸運事件那兩條前置條件不變。
  const stunned = unit('b', 'B');
  stunned.addBuff({ id: 'stun', type: 'STUN', duration: 2 });
  assert.equal(stunned.canAct(), false);
});

test('a chance below 1 rolls once per action slot and leaves canAct alone', t => {
  // 擲骰序列輪流落在 0.3 之下與之上，所以擋一次、放行一次。
  const blocked = runSlots(t, { type: 'STUN', chance: 0.3 }, [0.1, 0.9]);
  assert.ok(blocked.length >= 1, '擲中的槽要被擋下');
  const paralysed = unit('b', 'B');
  paralysed.addBuff({ id: 'paralysis', type: 'STUN', duration: 2, chance: 0.3 });
  assert.equal(paralysed.canAct(), true, '機率型麻痺不讓 canAct 為 false');
  assert.equal(paralysed.buffs[0].chance, 0.3);
});

test('the blocking buff supplies its own copy, as a string or a callback', t => {
  const fromFn = runSlots(t,
    { type: 'STUN', message: ({ entity }) => `${entity.name} 身體麻痺，無法動彈！` }, [0.99]);
  assert.equal(fromFn[0].message, 'b 身體麻痺，無法動彈！');
  const fromString = runSlots(t, { type: 'STUN', message: '動不了！' }, [0.99]);
  assert.equal(fromString[0].message, '動不了！');
});

test('a chance outside (0, 1] or a non-text message is rejected at construction', () => {
  const b = unit('b', 'B');
  for (const chance of [0, -0.1, 1.5, Number.NaN, '0.3']) {
    assert.throws(() => b.addBuff({ id: 'bad', type: 'STUN', duration: 2, chance }), /needs chance in/);
  }
  assert.throws(() => b.addBuff({ id: 'bad', type: 'STUN', duration: 2, message: 42 }),
    /message must be a string or a function/);
  // chance 只對 STUN 有意義，其他型別不受影響。
  b.addBuff({ id: 'dot', type: 'DOT', duration: 2, value: 1 });
  assert.equal(b.buffs[0].chance, undefined);
});
