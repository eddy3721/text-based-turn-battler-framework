// 可重現的戰鬥與戰後重播。
// 示範：rng + createSeededRandom 重現同一場戰鬥、遊戲層鉤子用 random() 跟著種子走、
//       ROUND_START 被動、engine.actionSlots 與 battleEnd 在結尾補一段「精彩重播」。
// 執行：node examples/replay.js
const { Entity, Skill, BattleEngine, createSeededRandom, random } = require('../src');

// 每次都重建單位：Entity 在戰鬥中會被改寫（HP、Buff……），同一組物件不能跑兩場。
function createDuel() {
  const blade = new Skill({ id: 'blade', name: '拔刀', actions: [{ type: 'DAMAGE' }] });
  const iai = new Skill({ id: 'iai', name: '居合・一閃', tier: 'ultimate', actions: [
    { type: 'DAMAGE', power: 2.5, spCost: 15, text: { action: ctx => `${ctx.caster.name} 屏息收刀——居合・一閃！` } }
  ] });
  const fang = new Skill({ id: 'fang', name: '狼牙', actions: [{ type: 'DAMAGE', hits: 3, power: 0.5, spCost: 8 }] });
  return [
    new Entity({ id: 'samurai', name: '浪人', team: 'A', normalAttack: blade, skills: [iai],
      stats: { hp: 2400, sp: 60, atk: 170, def: 80, spd: 110, cri: 0.25, counter: 10 } }),
    new Entity({ id: 'wolf', name: '狼王', team: 'B', normalAttack: blade, skills: [fang],
      stats: { hp: 2600, sp: 60, atk: 150, def: 70, spd: 130, cri: 0.15 },
      passives: [{
        // 每 3 回合舔傷口回血。數字用框架的 random()，才會跟著同一個種子走；用 Math.random 就無法重現。
        trigger: 'ROUND_START',
        enabled: (self, { round }) => round % 3 === 0,
        action: (self, { round }, logger) => {
          const healed = self.heal(Math.floor(120 + random() * 80));
          if (healed > 0) logger.addLog({ type: 'SKILL_TEXT', actorId: self.id,
            message: `第 ${round} 回合，${self.name} 舔舐傷口，回復了 ${healed} 點生命。` });
        }
      }] })
  ];
}

// 勝負已定、BATTLE_END 之前執行一次。actionSlots 記著每個真的出手的行動槽在 logs 裡的範圍。
function highlightReplay(engine) {
  const logs = engine.logger.logs;
  let best = null;
  for (const slot of engine.actionSlots) {
    const damage = logs.slice(slot.start, slot.end)
      .filter(log => log.actorId === slot.actor.id && (log.type === 'DAMAGE' || log.type === 'COUNTER'))
      .reduce((sum, log) => sum + (log.value || 0), 0);
    if (!best || damage > best.damage) best = { slot, damage };
  }
  if (best) engine.logger.addLog({ type: 'TEXT', message:
    `★ 精彩重播：第 ${best.slot.turn} 回合，${best.slot.actor.name} 的 ${best.slot.skill.name} 一口氣打出 ${best.damage} 點傷害！` });
}

function fight(seed) {
  const [samurai, wolf] = createDuel();
  return new BattleEngine([samurai], [wolf], { rng: createSeededRandom(seed), battleEnd: highlightReplay }).start();
}

const seed = 20261025;
const result = fight(seed);
const transcript = battle => battle.logs.map(log => log.message).join('\n');
const replayMatches = transcript(fight(seed)) === transcript(result);

if (require.main === module) {
  console.log(transcript(result));
  console.log(`\n同一個種子（${seed}）重跑一次，戰報${replayMatches ? '完全相同' : '不同（不該發生）'}。`);
  console.log(`換一個種子就是另一場：獲勝方 ${fight(seed + 1).winner}。`);
}

module.exports = { result, replayMatches };
