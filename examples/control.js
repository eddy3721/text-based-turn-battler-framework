// 控制效果：沉默、機率麻痺、混亂（敵我互換）。
// 示範：Buff 的 silence 與 STUN chance、引擎選項 actionTargetResolver 回傳 { swapSides: true }。
// 框架不認識「混亂」：它只提供改目標的鉤子，哪個 Buff 代表混亂由遊戲層決定。
// 執行：node examples/control.js
const { Entity, Skill, BattleEngine, createSeededRandom } = require('../src');

const strike = new Skill({ id: 'strike', name: '攻擊', actions: [{ type: 'DAMAGE' }] });

// ---- 我方：一位控場法師 ----
const hush = new Skill({ id: 'hush', name: '噤聲術', actions: [
  { type: 'BUFF', spCost: 6, buffs: [{ id: 'silence', name: '噤聲', type: 'STAT', duration: 3, silence: true }],
    text: { action: ctx => `${ctx.caster.name} 豎起食指，` } } // BUFF 的預設開頭是空字串
] });
const shock = new Skill({ id: 'shock', name: '雷擊', actions: [
  { type: 'DAMAGE', power: 1.2, stat: 'int', spCost: 6 }, // stat 讓傷害改用 int 計算
  // requiresDamage：只對上一段真的打出傷害的目標附加
  { type: 'BUFF', requiresDamage: true, buffs: [{ id: 'paralysis', name: '麻痺', type: 'STUN', duration: 3, chance: 0.5,
    message: ({ entity }) => `${entity.name} 全身發麻，動彈不得！` }] }
] });
const charm = new Skill({ id: 'charm', name: '幻惑之歌', actions: [
  { type: 'BUFF', spCost: 8, buffs: [{ id: 'confused', name: '混亂', type: 'STAT', duration: 2 }],
    text: { action: ctx => `${ctx.caster.name} 唱起幻惑之歌，` } }
] });
const mage = new Entity({ id: 'mage', name: '幻術師', team: 'A', normalAttack: strike, skills: [hush, shock, charm],
  stats: { hp: 4200, sp: 120, atk: 80, int: 240, def: 90, spd: 120, skillCastRate: 0.6 } });

// ---- 敵方：一個靠技能吃飯的術士和他的護衛 ----
const darkBolt = new Skill({ id: 'dark_bolt', name: '暗影箭', actions: [
  { type: 'DAMAGE', power: 2.2, stat: 'int', spCost: 5, text: { action: ctx => `${ctx.caster.name} 射出暗影箭，` } }
] });
const warlock = new Entity({ id: 'warlock', name: '術士', team: 'B', normalAttack: strike, skills: [darkBolt],
  stats: { hp: 1800, sp: 80, atk: 60, int: 150, def: 40, spd: 100, skillCastRate: 0.7 } });
const guard = new Entity({ id: 'guard', name: '護衛', team: 'B', normalAttack: strike,
  stats: { hp: 2000, sp: 40, atk: 130, def: 90, spd: 80 } });

const result = new BattleEngine([mage], [warlock, guard], {
  rng: createSeededRandom(6),
  maxTurns: 40,
  // 每個行動槽出手前問一次。混亂的單位這一槽敵我互換：ENEMY_* 打自己人，ALLY_* 治療到對面。
  // 混亂可能打到自己；要排除自己請回傳 { swapSides: true, excludeSelf: true }。
  actionTargetResolver: ({ caster }) =>
    caster.buffs.some(buff => buff.id === 'confused') ? { swapSides: true } : undefined
}).start();

if (require.main === module) {
  for (const log of result.logs) console.log(log.message);
}

module.exports = result;
