// Boss 戰：用被動（passives）把一隻 Boss 寫出階段感。
// 示範：BATTLE_START 開場護盾、HP_BELOW 半血狂暴、LAST_STAND 保命一次、
//       AFTER_ACTION 計數 + engine.insertAction 插隊放大招、hitOrder: 'wave' 逐波全體攻擊。
// 執行：node examples/boss-fight.js
const { Entity, Skill, BattleEngine, createSeededRandom } = require('../src');

const say = (logger, self, message) => logger.addLog({ type: 'SKILL_TEXT', actorId: self.id, message });

// ---- 隊伍 ----
const sword = new Skill({ id: 'sword', name: '劍擊', actions: [{ type: 'DAMAGE' }] });
const heal = new Skill({ id: 'heal', name: '治癒之光', actions: [
  // 群體治療，回復量 = (atk × 0.5 + int × 1) × power
  { type: 'HEAL', targetType: 'ALLY_ALL', spCost: 8, power: 0.8, stat: { atk: 0.5, int: 1 } }
] });
const party = [
  new Entity({ id: 'knight', name: '騎士', team: 'A', normalAttack: sword,
    stats: { hp: 2400, sp: 40, atk: 140, def: 120, spd: 70, cri: 0.1 } }),
  new Entity({ id: 'archer', name: '弓手', team: 'A', normalAttack: sword,
    stats: { hp: 1500, sp: 40, atk: 170, def: 50, spd: 130, cri: 0.3 } }),
  new Entity({ id: 'priest', name: '祭司', team: 'A', normalAttack: sword, skills: [heal],
    stats: { hp: 1400, sp: 80, atk: 60, int: 220, def: 60, spd: 90, skillCastRate: 0.5 } })
];

// ---- Boss ----
const bite = new Skill({ id: 'bite', name: '撕咬', actions: [{ type: 'DAMAGE' }] });
// 插隊用的大招：三波全體攻擊，第 2 波起先印過場（text.wave）。
const meteor = new Skill({ id: 'meteor', name: '隕星雨', tier: 'ultimate', actions: [
  // 後面的段落預設沿用前一段的目標（inheritTarget），所以開場白就要選好全體。
  { type: 'TEXT', targetType: 'ENEMY_ALL', message: ctx => `${ctx.caster.name} 振翅升空，天空開始崩落——` },
  { type: 'DAMAGE', targetType: 'ENEMY_ALL', hits: 3, hitOrder: 'wave', power: 0.35,
    text: { action: '', wave: ctx => `第 ${ctx.hitIndex} 陣隕石砸了下來！` } }
] });

// 被動的狀態（計數、用過了沒）放在建立函式的閉包裡：每場戰鬥重新建一隻，狀態才不會跨場殘留。
function createDragon() {
  let actionsTaken = 0;
  let lastStandUsed = false;
  return new Entity({
    id: 'dragon', name: '古龍', team: 'B', normalAttack: bite,
    stats: { hp: 5200, sp: 100, atk: 165, def: 140, spd: 100, cri: 0.15 },
    dialogues: { opening: '又有人來送死了。', death: '這片天空……終究不屬於我……' },
    passives: [
      { // 開場：第 1 回合之前掛上護盾。
        trigger: 'BATTLE_START',
        action: (self, battle, logger) => {
          self.addBuff({ id: 'scale', name: '龍鱗護盾', type: 'STAT', duration: 99, shield: 400 });
          say(logger, self, `${self.name} 周身浮現龍鱗護盾。`);
        }
      },
      { // 半血一次性階段轉換：condition + threshold，簽名是 (self, logger, engine)。
        condition: 'HP_BELOW', threshold: 0.5,
        action: (self, logger) => {
          self.addBuff({ id: 'rage', name: '狂暴', type: 'STAT', duration: 99, effect: stats => { stats.atk *= 1.4; } });
          say(logger, self, `${self.name} 發出震耳的怒吼，攻擊力大幅上升！`);
        }
      },
      { // 每行動 5 次就插隊放一次大招。AFTER_ACTION 會通知場上所有人，所以要先過濾出手者。
        trigger: 'AFTER_ACTION',
        enabled: (self, { actor }) => actor === self,
        action: (self, action, logger, engine) => {
          if (++actionsTaken % 5 === 0) engine.insertAction(self, meteor);
        }
      },
      { // 這一擊會致死時才執行；把傷害壓到剩 1 HP。只用一次。
        trigger: 'LAST_STAND',
        enabled: () => !lastStandUsed,
        action: (self, hit, logger) => {
          lastStandUsed = true;
          hit.damage = self.stats.hp - 1;
          say(logger, self, `${self.name} 硬是撐住了最後一口氣！`); // 這行會排在傷害那行之後
        }
      }
    ]
  });
}

const result = new BattleEngine(party, [createDragon()], { rng: createSeededRandom(2), maxTurns: 40 }).start();

if (require.main === module) {
  for (const log of result.logs) console.log(log.message);
}

module.exports = result;
