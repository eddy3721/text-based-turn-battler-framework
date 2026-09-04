const { Entity, Skill, BattleEngine } = require('./src/index');

// 定義技能
const normalAttack = new Skill({
  id: 'skill_attack',
  name: '普通攻擊',
  actions: [
    {
      type: 'DAMAGE',
      spCost: 0,
      targetType: 'ENEMY_SINGLE', // 第一段決定目標
      power: 1,
      hits: 1,
      message: (ctx) => `${ctx.caster.name} 攻擊 ${ctx.target.name}，造成 ${ctx.value} 點${ctx.isCrit ? "爆擊" : ""}傷害！`
    }
  ]
});

const starburstStream = new Skill({
  id: 'skill_starburst',
  name: '星爆氣流斬',
  actions: [
    {
      type: 'TEXT',
      message: (ctx) => `${ctx.caster.name} 拔出了雙劍，大喊：「幫我撐十秒！」`
    },
    {
      type: 'DAMAGE',
      spCost: 30, // 啟動耗費 30 SP
      targetType: 'ENEMY_SINGLE',
      power: 0.2,
      hits: 10,
      message: (ctx) => `第 ${ctx.hitIndex} 擊！對 ${ctx.target.name} 造成了 ${ctx.value} 點${ctx.isCrit ? "爆擊" : ""}傷害！`
    },
    {
      type: 'DAMAGE',
      spCost: 20, // 後半段再耗費 20 SP，並且延續使用同一個目標
      inheritTarget: true,
      power: 0.5,
      hits: 6,
      message: (ctx) => `第 ${ctx.hitIndex + 10} 擊！對 ${ctx.target.name} 造成了 ${ctx.value} 點${ctx.isCrit ? "爆擊" : ""}傷害！`
    },
    {
      type: 'TEXT',
      message: (ctx) => `${ctx.caster.name} 帥氣地收起了雙劍。`
    }
  ]
});

const healAndBuff = new Skill({
  id: 'skill_heal',
  name: '治療與守護',
  actions: [
    {
      type: 'HEAL',
      spCost: 15,
      targetType: 'ALLY_SINGLE',
      power: 1.5,
      message: (ctx) => `${ctx.caster.name} 施放了治療術，使 ${ctx.target.name} 回復了 ${ctx.value} 點生命！`
    },
    {
      type: 'BUFF',
      spCost: 5,
      // 不延續目標，改對全隊上 Buff (這裡示範不同的 targetType)
      inheritTarget: false,
      targetType: 'ALLY_ALL',
      buffs: [{ id: 'hot_1', name: '持續恢復', type: 'HOT', duration: 3, value: 30 }],
      message: (ctx) => `${ctx.target.name} 獲得了 ${ctx.buff.name} 效果！`
    }
  ]
});

const poisonDart = new Skill({
  id: 'skill_poison',
  name: '毒飛鏢',
  actions: [
    {
      type: 'DAMAGE',
      spCost: 10,
      targetType: 'ENEMY_SINGLE',
      power: 0.5,
      message: (ctx) => `${ctx.caster.name} 投擲了毒飛鏢，對 ${ctx.target.name} 造成了 ${ctx.value} 點傷害！`
    },
    {
      type: 'BUFF',
      spCost: 0,
      inheritTarget: true, // 延續剛剛被打的人，幫他上毒
      buffs: [{ id: 'dot_poison', name: '中毒', type: 'DOT', duration: 3, value: 20 }],
      message: (ctx) => `${ctx.target.name} 中毒了！`
    }
  ]
});

const nodachiSlash = new Skill({
  id: 'skill_nodachi',
  name: '野太刀斬擊',
  actions: [
    {
      type: 'TEXT',
      message: (ctx) => `${ctx.caster.name} 揮舞著野太刀，發動了猛烈的斬擊！`
    },
    {
      type: 'DAMAGE',
      spCost: 0,
      inheritTarget: false, // 因為上一段 TEXT 預設抓了單體目標，所以這裡要強制拒絕延續，重新抓取全體！
      targetType: 'ENEMY_ALL', // 變成全體攻擊！
      power: 1.5,
      message: (ctx) => `對 ${ctx.target.name} 造成了 ${ctx.value} 點${ctx.isCrit ? "爆擊" : ""}傷害！`
    }
  ]
});

// 建立實體
const player1 = new Entity({
  id: 'p1',
  name: '桐人',
  team: 'A',
  stats: { hp: 1000, maxHp: 1000, sp: 100, maxSp: 100, atk: 150, def: 50, spd: 120, cri: 0.2 },
  normalAttack: normalAttack,
  skills: [starburstStream]
});

const player2 = new Entity({
  id: 'p2',
  name: '亞絲娜',
  team: 'A',
  stats: { hp: 800, maxHp: 800, sp: 80, maxSp: 80, atk: 120, def: 40, spd: 110, cri: 0.1 },
  normalAttack: normalAttack,
  skills: [healAndBuff]
});

const enemy1 = new Entity({
  id: 'e1',
  name: '狗頭人王 伊爾凡格',
  team: 'B',
  stats: { hp: 1200, maxHp: 1200, sp: 50, maxSp: 50, atk: 130, def: 60, spd: 90, cri: 0.05 }, // 故意調降血量方便測試二階段
  normalAttack: normalAttack,
  skills: [poisonDart],
  passives: [
    {
      type: 'HP_THRESHOLD',
      condition: 'HP_BELOW',
      threshold: 0.5,
      triggered: false,
      action: (entity, logger) => {
        logger.addLog({
          type: 'TEXT',
          actorId: entity.id,
          message: `【階段轉換】${entity.name} 發出怒吼，扔掉了武器與盾牌，拔出了背上的野太刀！`
        });
        entity.stats.atk += 100;
        entity.stats.spd += 50;
        entity.normalAttack = nodachiSlash; // 普攻替換成野太刀全體斬擊
        entity.skills = [];
      }
    }
  ]
});

// 開始戰鬥
const engine = new BattleEngine([player1, player2], [enemy1]);
const result = engine.start();

// 輸出結果
console.log(`=== 戰鬥結果 ===`);
console.log(`獲勝方: ${result.winner}`);
console.log(`\n=== 戰鬥日誌 ===`);
result.logs.forEach(log => {
  if (log.type === 'TURN_START' || log.type === 'TEXT' || log.type === 'SKILL_TEXT' || log.type === 'DAMAGE' || log.type === 'DEATH' || log.type === 'HEAL' || log.type === 'MISS' || log.type === 'BUFF_APPLY' || log.type === 'BUFF_EFFECT') {
    console.log(log.message || JSON.stringify(log));
  }
});
