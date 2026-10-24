// 最小可執行範例：一個勇者對一個魔王。README 的「快速開始」就是這支檔案。
// 執行：node examples/quickstart.js
const { Entity, Skill, BattleEngine } = require('../src'); // 你的專案裡寫 require('text-based-turn-battler-framework')

// 技能是一串 actions，引擎依序執行。DAMAGE 預設打一個敵人，傷害 = atk × power（再扣防禦）。
const slash = new Skill({ id: 'slash', name: '斬擊', actions: [{ type: 'DAMAGE' }] });
const fireball = new Skill({ id: 'fireball', name: '火球術', actions: [
  { type: 'DAMAGE', power: 1.8, spCost: 10, text: { action: ctx => `${ctx.caster.name} 詠唱火球術，` } }
] });
const claw = new Skill({ id: 'claw', name: '利爪', actions: [{ type: 'DAMAGE' }] });

const hero = new Entity({
  id: 'hero', name: '勇者', team: 'A',
  stats: { hp: 2000, sp: 60, atk: 150, def: 50, spd: 120, cri: 0.2 },
  normalAttack: slash,
  skills: [fireball] // 每個行動槽預設 35% 機率從這裡抽一招（stats.skillCastRate）
});
const boss = new Entity({
  id: 'boss', name: '魔王', team: 'B',
  stats: { hp: 2100, sp: 60, atk: 130, def: 80, spd: 90, cri: 0.1 },
  normalAttack: claw,
  dialogues: { opening: '區區人類。', death: '不可能……' }
});

// 一次跑完整場戰鬥，回傳勝負與完整戰報。
const result = new BattleEngine([hero], [boss]).start();

if (require.main === module) {
  for (const log of result.logs) console.log(log.message);
  console.log(`\n獲勝方：${result.winner}（TEAM_A / TEAM_B / DRAW）`);
}

module.exports = result;
