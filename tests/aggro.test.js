const test = require('node:test');
const assert = require('node:assert/strict');
const { Entity, Skill, BattleEngine, Formulas } = require('../src');

const entity = (id, team, stats = {}) => new Entity({ id, name: id, team,
  stats: { hp: 100, maxHp: 100, sp: 10, atk: 10, def: 5, ...stats } });
const strike = new Skill({ id: 'strike', actions: [{ type: 'DAMAGE', power: 0, targetType: 'ENEMY_SINGLE' }] });
// 嘲諷／隱蔽都只是改 aggro 的 STAT buff，框架不需要為它們準備任何專用欄位。
const aggroSkill = (id, effect, duration = 3) => new Skill({ id, actions: [{
  type: 'BUFF', targetType: 'SELF', buffs: [{ id, type: 'STAT', duration, effect }]
}] });

// 抽 n 次，回傳每個 id 被選中的次數。
const sample = (candidates, n) => {
  const hits = new Map(candidates.map(c => [c.id, 0]));
  for (let i = 0; i < n; i++) {
    const picked = Formulas.pickByAggro(candidates);
    hits.set(picked.id, hits.get(picked.id) + 1);
  }
  return hits;
};

test('aggro defaults to 1 and rejects invalid values', () => {
  assert.equal(entity('a', 'A').stats.aggro, 1);
  assert.equal(entity('a', 'A', { aggro: 0 }).stats.aggro, 0);
  assert.equal(entity('a', 'A', { aggro: 4 }).getEffectiveStats().aggro, 4);
  for (const value of [-1, NaN, Infinity, '3']) {
    assert.throws(() => entity('a', 'A', { aggro: value }), /aggro/);
  }
});

// 加權抽籤不能改變亂數序列，否則每一場固定亂數的戰鬥都會變成另一場。
// 單一候選人也要擲骰：舊的均勻抽在那裡照樣呼叫 Math.random()。
test('equal aggro picks the same target as the old uniform draw, from exactly one random roll', () => {
  const pool = ['a', 'b', 'c', 'd'].map(id => entity(id, 'B'));
  const original = Math.random;
  try {
    for (const candidates of [pool, pool.slice(0, 2), pool.slice(0, 1)]) {
      for (const roll of [0, 0.1, 0.25, 0.49, 0.5, 0.75, 0.99]) {
        let calls = 0;
        Math.random = () => { calls++; return roll; };
        assert.equal(Formulas.pickByAggro(candidates), candidates[Math.floor(roll * candidates.length)]);
        assert.equal(calls, 1, `${candidates.length} 名候選人時應該剛好擲一次骰`);
      }
    }
  } finally {
    Math.random = original;
  }
});

test('aggro weights the draw proportionally', () => {
  const [plain, taunter] = [entity('plain', 'B'), entity('taunter', 'B', { aggro: 4 })];
  const hits = sample([plain, taunter], 20000);
  // 期望 4:1。放寬到 3:1~6:1，讓這個斷言不會偶發性失敗。
  const ratio = hits.get('taunter') / hits.get('plain');
  assert.ok(ratio > 3 && ratio < 6, `expected roughly 4:1, got ${ratio.toFixed(2)}:1`);
});

test('zero aggro is skipped while anyone else is targetable, but never deadlocks the battle', () => {
  const [hidden, plain] = [entity('hidden', 'B', { aggro: 0 }), entity('plain', 'B')];
  const hits = sample([hidden, plain], 2000);
  assert.equal(hits.get('hidden'), 0);
  assert.equal(hits.get('plain'), 2000);
  // 全員權重 0 時退回均勻抽，否則單體技能會永遠選不到目標。
  const allZero = sample([hidden, entity('ghost', 'B', { aggro: 0 })], 2000);
  assert.ok(allZero.get('hidden') > 0 && allZero.get('ghost') > 0);
});

test('a taunt skill redirects enemy single-target skills, and expiry restores the base value', () => {
  // 血量拉高，讓這一輪只量目標分布，不會有人中途倒下改變候選名單。
  const hp = { hp: 1000000, maxHp: 1000000, sp: 1000000, maxSp: 1000000 };
  const attacker = entity('attacker', 'A', hp);
  const [tank, squishy] = [entity('tank', 'B', hp), entity('squishy', 'B', hp)];
  const engine = new BattleEngine([attacker], [tank, squishy]);
  const taunt = aggroSkill('taunt', stats => { stats.aggro *= 9; });

  taunt.execute(tank, [tank, squishy], [attacker], engine.logger, engine);
  assert.equal(tank.getEffectiveStats().aggro, 9);
  assert.equal(tank.stats.aggro, 1, 'STAT buff 不該寫回原始 stats');

  let tankHits = 0;
  for (let i = 0; i < 500; i++) {
    const logger = { logs: [], addLog(entry) { this.logs.push(entry); } };
    strike.execute(attacker, [attacker], [tank, squishy], logger, engine);
    const hit = logger.logs.find(entry => entry.targetId);
    assert.ok(hit, 'DAMAGE action 應該留下一筆帶 targetId 的日誌');
    if (hit.targetId === 'tank') tankHits++;
  }
  assert.ok(tankHits > 400, `expected the taunt to soak most attacks, got ${tankHits}/500`);

  for (let i = 0; i < 3; i++) tank.tickBuffs();
  assert.equal(tank.getEffectiveStats().aggro, 1);
});

test('fatigue does not change aggro', () => {
  const tired = entity('tired', 'B', { sp: 1, maxSp: 100, aggro: 3 });
  assert.equal(tired.getFatigueStage(), 'EXHAUSTED');
  assert.equal(tired.getEffectiveStats().aggro, 3);
  assert.ok(tired.getEffectiveStats().atk < tired.stats.atk, '力竭仍然要削弱一般能力值');
});
