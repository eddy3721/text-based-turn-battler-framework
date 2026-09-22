/**
 * 一場跑得起來的完整戰鬥 —— 用 `npm run demo` 執行。
 *
 * 這支腳本刻意把七種 action type 都用過一次，順序大致就是你自己接框架時會遇到的順序：
 *
 *   TEXT / DAMAGE  → 多段連擊與演出台詞（星爆氣流斬）
 *   HEAL / BUFF    → 治療、全隊 HOT、以及打完立刻上 DOT（毒飛鏢）
 *   RESTORE_SP     → 補 SP，讓隊伍撐得住耗 SP 的大招
 *   SUMMON         → 需要建立引擎時注入 summonFactory
 *   CAST_SKILL     → 需要注入 skillResolver，等機率抽一招真正施放
 *
 * 再加上一個 condition: 'HP_BELOW' 的階段轉換被動（半血換武器）。
 * 各機制的完整規則寫在 README.md 與同層的主題文件（EVASION.md、COUNTERS.md …）。
 */

const { Entity, Skill, BattleEngine } = require('../src/index');

// ---------------------------------------------------------------- 技能

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

// RESTORE_SP：把資源還給隊伍。amount 是固定值，但日誌帶的是「實際恢復量」，
// 所以滿 SP 的人身上會誠實地印出 0，而不是假裝補了一整份。
const hymnOfTheDawn = new Skill({
  id: 'skill_hymn',
  name: '晨曦聖詠',
  actions: [
    {
      type: 'TEXT',
      message: (ctx) => `${ctx.caster.name} 哼起了一段聖詠。`
    },
    {
      type: 'RESTORE_SP',
      spCost: 0,
      inheritTarget: false,
      targetType: 'ALLY_ALL',
      amount: 25,
      message: (ctx) => `${ctx.target.name} 感到氣力回升，回復了 ${ctx.value} 點 SP！`
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

// SUMMON：框架不持有怪物表，實際生出誰由建立引擎時注入的 summonFactory 決定。
// maxAlive 限制同時在場數，maxTotal 限制整場的嘗試次數（招不到人也算用掉一次）。
const callTheHorde = new Skill({
  id: 'skill_horde',
  name: '呼喚部族',
  actions: [
    {
      type: 'SUMMON',
      spCost: 20,
      monsterId: 'kobold_warrior',
      maxAlive: 2,
      maxTotal: 3,
      message: (ctx) => `${ctx.caster.name} 吹響號角，${ctx.target.name} 從側邊的坑道衝了出來！`
    }
  ]
});

// CAST_SKILL 的候選技能。它們不必掛在施放者的 skills 裡，但必須能被 skillResolver 找到。
const hammerSmash = new Skill({
  id: 'skill_hammer',
  name: '巨槌砸擊',
  actions: [{
    type: 'DAMAGE', spCost: 0, targetType: 'ENEMY_SINGLE', power: 1.3,
    message: (ctx) => `巨槌砸向 ${ctx.target.name}，造成 ${ctx.value} 點${ctx.isCrit ? "爆擊" : ""}傷害！`
  }]
});

const spearThrust = new Skill({
  id: 'skill_spear',
  name: '長槍突刺',
  actions: [{
    type: 'DAMAGE', spCost: 0, targetType: 'ENEMY_ALL', power: 0.7,
    message: (ctx) => `長槍掃過，${ctx.target.name} 受到 ${ctx.value} 點傷害！`
  }]
});

// CAST_SKILL：等機率抽一個候選技能真正施放。子技能自己選目標、用自己的文案，
// 不另外扣 SP、也不占一個行動槽——所以這是「一招多變化」而不是「連續行動兩次」。
const weaponRack = new Skill({
  id: 'skill_weapon_rack',
  name: '換手',
  actions: [
    {
      type: 'TEXT',
      message: (ctx) => `${ctx.caster.name} 隨手從背上抽了一把武器。`
    },
    {
      type: 'CAST_SKILL',
      spCost: 12,
      skillIds: ['skill_hammer', 'skill_spear']
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

// 遊戲端自己管技能表，框架只透過 skillResolver 查詢。
const SKILL_BOOK = [
  normalAttack, starburstStream, healAndBuff, hymnOfTheDawn, poisonDart,
  callTheHorde, hammerSmash, spearThrust, weaponRack, nodachiSlash
].reduce((book, skill) => book.set(skill.id, skill), new Map());

// ---------------------------------------------------------------- 實體

const player1 = new Entity({
  id: 'p1',
  name: '桐人',
  team: 'A',
  // 兩位玩家都帶傷進場，否則滿血的人被治療或 HOT 只會印出「回復 0 點」。
  stats: { hp: 880, maxHp: 1000, sp: 100, maxSp: 100, atk: 150, def: 50, spd: 120, cri: 0.2 },
  normalAttack: normalAttack,
  skills: [starburstStream]
});

const player2 = new Entity({
  id: 'p2',
  name: '亞絲娜',
  team: 'A',
  // skillCastRate 是「這個行動槽改用主動技能而不是普攻」的機率，預設 0.35。
  // 這裡調高，只是為了讓示範每次跑都看得到治療與聖詠。
  stats: { hp: 560, maxHp: 800, sp: 80, maxSp: 80, atk: 120, def: 40, spd: 110, cri: 0.1, skillCastRate: 0.7 },
  normalAttack: normalAttack,
  skills: [healAndBuff, hymnOfTheDawn]
});

const enemy1 = new Entity({
  id: 'e1',
  name: '狗頭人王 伊爾凡格',
  team: 'B',
  // 同樣為了示範而調高 skillCastRate，讓召喚與 CAST_SKILL 每場都出得來。
  stats: { hp: 1200, maxHp: 1200, sp: 80, maxSp: 80, atk: 130, def: 60, spd: 90, cri: 0.05, skillCastRate: 0.8 },
  normalAttack: normalAttack,
  skills: [poisonDart, callTheHorde, weaponRack],
  // openingSkill 在第一次能行動時必定施放一次（可施放的話），不受 skillCastRate 影響。
  // Boss 的起手式用這個，比祈禱隨機抽中可靠。
  openingSkill: callTheHorde,
  // 台詞只要給本體字串，引號與戰鬥名稱由引擎補上；每個事件整場只播一次。
  dialogues: {
    opening: '入侵者……這座礦坑是我們的巢！',
    death: '不……部族會記住你的名字……'
  },
  passives: [
    {
      // 一次性階段轉換：血量變動時檢查，觸發過就不再觸發。
      trigger: 'ON_HP_CHANGE',
      condition: 'HP_BELOW',
      threshold: 0.5,
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

// ---------------------------------------------------------------- 開戰

const engine = new BattleEngine([player1, player2], [enemy1], {
  // SUMMON 用的怪物工廠。陣營由引擎決定（工廠自己填的 team 會被蓋掉）；
  // 回傳 null 代表「這次沒有可用的增援」，引擎會改寫出 SUMMON_FAILED。
  summonFactory: (monsterId, { entityId }) => new Entity({
    id: entityId,
    name: '狗頭人戰士',
    stats: { hp: 220, maxHp: 220, sp: 0, atk: 90, def: 20, spd: 100, cri: 0.05 },
    normalAttack
  }),
  // CAST_SKILL 用的技能查詢。框架不持有註冊表，未知 ID 會直接報錯。
  skillResolver: id => SKILL_BOOK.get(id)
});

const result = engine.start();

// ---------------------------------------------------------------- 輸出

console.log(`=== 戰鬥結果 ===`);
console.log(`獲勝方: ${result.winner}`);
console.log(`\n=== 戰鬥日誌 ===`);
// 實際遊戲會依 log.type 決定顏色、字級與動畫（例如 DAMAGE 且 isCrit 就放大震動）。
// 這裡一律印 message 就好：用白名單挑 type 的話，之後新增的日誌種類會被靜默吃掉。
result.logs.forEach(log => {
  if (log.message) console.log(log.message);
});
