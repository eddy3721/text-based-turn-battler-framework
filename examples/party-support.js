// 團隊配合：被動不只看自己，也能對隊友與對手的行動做反應。
// 示範：aggro 嘲諷（STAT Buff 改仇恨）、BEFORE_SKILL_CAST 替隊友擋招、
//       AFTER_ACTION 隊友出手後鼓舞、ON_EVADE / AFTER_EVADE 閃避方式與閃避後反擊準備、healTaken 減療。
// 執行：node examples/party-support.js
const { Entity, Skill, BattleEngine, createSeededRandom } = require('../src');

const say = (logger, self, message) => logger.addLog({ type: 'SKILL_TEXT', actorId: self.id, message });
const strike = new Skill({ id: 'strike', name: '攻擊', actions: [{ type: 'DAMAGE' }] });

// ---- 我方 ----
// 嘲諷：aggro 是敵方單體技能抽目標的權重（預設 1），乘 4 等於被打的機率變四倍。
const taunt = new Skill({ id: 'taunt', name: '挑釁', actions: [
  { type: 'BUFF', targetType: 'SELF', spCost: 5,
    buffs: [{ id: 'taunt', name: '挑釁', type: 'STAT', duration: 4, effect: stats => { stats.aggro *= 4; } }],
    text: { action: ctx => `${ctx.caster.name} 敲響盾牌挑釁敵人，` } }
] });
const knight = new Entity({ id: 'knight', name: '騎士', team: 'A', normalAttack: strike, skills: [taunt],
  stats: { hp: 2600, sp: 50, atk: 110, def: 160, spd: 70 },
  passives: [{
    // 對手每次出招之前都會問一次。把這一招所有傷害段乘上 0.5，等於替隊友擋下一半。
    trigger: 'BEFORE_SKILL_CAST',
    enabled: (self, cast) => cast.skill.id === 'cleave',
    action: (self, cast, logger) => {
      cast.damageMultiplier *= 0.5;
      say(logger, self, `${self.name} 舉盾擋在隊友身前！`);
    }
  }] });

const rogue = new Entity({ id: 'rogue', name: '盜賊', team: 'A', normalAttack: strike,
  stats: { hp: 1300, sp: 40, atk: 160, def: 40, spd: 150, eva: 60, cri: 0.25 },
  passives: [
    // 落空時描述「怎麼躲的」：evadeMethod 是片段，會拼成「但是被 盜賊 用殘影躲開了！」
    { trigger: 'ON_EVADE', action: (self, evasion) => { evasion.evadeMethod = '殘影'; } },
    // 躲開之後才有後果：下一擊爆擊率大增。
    { trigger: 'AFTER_EVADE', action: (self, evasion, logger) => {
      self.addBuff({ id: 'focus', name: '伺機', type: 'STAT', duration: 1, stackPolicy: 'refresh',
        effect: stats => { stats.cri = 1; } });
      say(logger, self, `${self.name} 從殘影後方鎖定了破綻。`);
    } }
  ] });

const bard = new Entity({ id: 'bard', name: '吟遊詩人', team: 'A', normalAttack: strike,
  stats: { hp: 1400, sp: 40, atk: 90, def: 60, spd: 100 },
  passives: [{
    // AFTER_ACTION 通知場上所有人；這裡只對「隊友用了技能」做反應。
    trigger: 'AFTER_ACTION',
    enabled: (self, { actor, skill }) => actor !== self && actor.team === self.team && actor.isAlive && skill !== actor.normalAttack,
    action: (self, { actor }, logger) => {
      actor.addBuff({ id: 'anthem', name: '戰歌', type: 'STAT', duration: 3, stackPolicy: 'refresh',
        effect: stats => { stats.atk *= 1.3; } });
      say(logger, self, `${self.name} 為 ${actor.name} 奏起戰歌！`);
    }
  }] });

// ---- 敵方 ----
const cleave = new Skill({ id: 'cleave', name: '迴旋斬', actions: [
  { type: 'DAMAGE', targetType: 'ENEMY_ALL', power: 0.9, spCost: 6,
    text: { action: ctx => `${ctx.caster.name} 掄起巨斧迴旋斬，` } }
] });
const curse = new Skill({ id: 'curse', name: '腐朽詛咒', actions: [
  { type: 'BUFF', spCost: 5, buffs: [{ id: 'rot', name: '腐朽', type: 'STAT', duration: 4, healTaken: { multiplier: 0.5 } }] }
] });
const orcs = [
  new Entity({ id: 'orc1', name: '獸人戰士', team: 'B', normalAttack: strike, skills: [cleave],
    stats: { hp: 2200, sp: 60, atk: 150, def: 80, spd: 90, skillCastRate: 0.5 } }),
  new Entity({ id: 'orc2', name: '獸人戰士', team: 'B', normalAttack: strike, skills: [cleave], // 同名會自動編號成「獸人戰士2」
    stats: { hp: 2200, sp: 60, atk: 150, def: 80, spd: 85, skillCastRate: 0.5 } }),
  new Entity({ id: 'shaman', name: '獸人薩滿', team: 'B', normalAttack: strike, skills: [curse],
    stats: { hp: 1500, sp: 60, atk: 110, def: 50, spd: 110 } })
];

const result = new BattleEngine([knight, rogue, bard], orcs, { rng: createSeededRandom(1), maxTurns: 40 }).start();

if (require.main === module) {
  for (const log of result.logs) console.log(log.message);
}

module.exports = result;
