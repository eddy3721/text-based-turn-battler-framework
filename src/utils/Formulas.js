/**
 * 取得「加成後」的能力值。
 *
 * 所有公式都必須走這裡，不要直接讀 entity.stats——type:'STAT' 的 buff 只作用在
 * getEffectiveStats() 回傳的副本上，直接讀原始 stats 會讓那類 buff 靜默失效
 * （戰報照常印出「被附加了 X 狀態」，數值卻完全沒變）。
 *
 * 這是唯讀路徑，回傳的是副本、寫入無效。
 * 扣血一律走 Entity.takeDamage，它寫的是原始 stats.hp。
 *
 * 對沒有這個方法的物件（例如單元測試的樁）退回原始 stats，
 * 讓公式仍然可以脫離 Entity 單獨測試。
 */
const statsOf = (entity) =>
  typeof entity.getEffectiveStats === 'function' ? entity.getEffectiveStats() : entity.stats;

// 每回合的行動槽數 = 存活人數 × 這個倍率。
//
// 這顆旋鈕調的是「行動的顆粒度」，不是總行動量：倍率 2 會讓回合數大致減半
// （實測 1v1 從 27 回合變 14），整場的總行動槽維持在 54~56 不變。
// 所以以行動槽計時的東西——Buff 的 duration、DOT/HOT 的 onPreTurn、tickBuffs、
// SP 預算——佔整場的比例都不受影響，調這個值不需要跟著改技能數值。
// 真正會被影響的是綁「回合」的機制，目前只有 trigger: 'ROUND_START' 那類 Buff：
// 它每回合觸發一次，回合數減半就等於總觸發次數減半。
//
// 從 1 調到 2 的實際效果是壓低變異數。倍率 1 時慢速單位有 29~38% 的機率
// 整個回合一次都沒被抽到，倍率 2 降到 1% 以下——抽中就砍速度 3/4 的衰減有上限，
// 快的人連抽第三、四次時權重已所剩無幾，多出來的槽會落到還沒動過的人身上。
// 慢速單位的槽位佔比因此從 36.6% 升到 41.7%（量測腳本見 mydoujin 的 scratch/slotShare.js）。
const ACTION_SLOTS_PER_ENTITY = 2;

// 連擊門檻：速度差每累積這麼多點，連擊數的下限／上限才各加一。
// 數字越大越難連擊，這是壓制高速角色的主要旋鈕。
//
// 從 40/15 調到 100/40 的理由：mydoujin 的 Lv100 玩家 spd 落在 200~500，
// 而怪物最高只有 100，速度差常態超過 300，換算成一次普攻 8~22 連擊。
// 連擊本身對傷害影響不大（普攻有 40% 遞減，總倍率收斂在 2.5 倍），
// 但每一下都是一行戰報、一次命中判定、一次爆擊判定與一次反擊判定，
// 所以真正被放大的是戰報長度與觸發型機制的觸發次數。
const COMBO_GAP_PER_MIN_HIT = 100;
const COMBO_GAP_PER_MAX_HIT = 40;

/**
 * 反擊：`stats.counter` 是「反擊點數」，不是機率。
 *
 * 機率只看攻守雙方的點數差，跟幸運事件看 luk 差、連擊看 spd 差同型；點數怎麼從
 * 遊戲的能力值換算由遊戲層決定（對照 hit / eva 的作法），框架只負責這條曲線。
 *
 * 曲線是 S 型而不是 max(0, 差值)：落後的一方機率遞減但不歸零，技巧輸人只是
 * 比較難反擊，不是完全反擊不了。截斷成零的版本會讓「數值較低的那一側」整個
 * 失去這個機制——在 mydoujin 就是所有 Boss 的反擊招牌技全部變成死內容。
 *
 *   點數相同      → 上限的一半
 *   落後 GAP_SCALE → 約上限的 27%
 *   領先 GAP_SCALE → 約上限的 73%
 *
 * GAP_SCALE 決定技巧差多敏感（越小越懸殊），CEILING 是機率上限：反擊必定命中
 * 又會跳過原本那一擊的傷害，逼近 100% 等於高點數單位完全免疫低點數單位。
 * 目前 0.2：點數相同 10%，差 ±50 約 14.6% / 5.4%。原本 0.3（相同時 15%）在每擊
 * 各判定一次之下反擊還是太頻繁，整條曲線等比例壓低，形狀不變。
 */
const COUNTER_CEILING = 0.2;
const COUNTER_GAP_SCALE = 50;

class Formulas {
  static luckEventProfile(actor, opponent) {
    const gap = Math.max(0, (statsOf(opponent).luk ?? 0) - (statsOf(actor).luk ?? 0));
    const ratio = gap / (gap + 100);
    return { gap, ratio, purpleChance: 0.30 * ratio, redChance: 0.10 * ratio,
      // Raw damage before variance and the universal softenLuckDamage curve.
      purpleDamage: gap * 1.2,
      redDamage: gap * 2.4 };
  }

  // Shared by normal and luck damage: vary before rounding, minimum 1.
  static applyDamageVariance(baseDamage) {
    return Math.max(1, Math.floor(baseDamage * (0.9 + Math.random() * 0.2)));
  }

  // All luck events, regardless of team, character, monster or game mode.
  // Apply after variance, preserving the random stream and small accidents.
  static softenLuckDamage(damage, tier) {
    const multiplier = tier === 'RED' ? 2.4 : 1.2;
    const gap = damage / multiplier;
    const knee = 200;
    if (gap <= knee) return damage;
    return Math.floor(multiplier * (knee + knee * Math.log1p((gap - knee) / knee)));
  }

  static rollLuckEvent(profile, roll = Math.random()) {
    if (roll < profile.redChance) return 'RED';
    if (roll < profile.redChance + profile.purpleChance) return 'PURPLE';
    return null;
  }

  static counterChance(attacker, defender) {
    // 0 點視為「這個單位不參與反擊」，而不是「技巧最低的單位」——
    // 沒設定過 counter 的實體（多數召喚物、測試樁）不該因為差值曲線憑空獲得反擊。
    const points = statsOf(defender).counter || 0;
    if (points <= 0) return 0;
    const gap = points - (statsOf(attacker).counter || 0);
    return COUNTER_CEILING / (1 + Math.exp(-gap / COUNTER_GAP_SCALE));
  }

  static isCounter(attacker, defender) {
    const chance = Formulas.counterChance(attacker, defender);
    return chance > 0 && Math.random() < chance;
  }
  // 決定行動順序，這裡採用基於速度的權重抽籤
  static determineActionOrder(entities) {
    const aliveEntities = [...entities].filter(e => e.isAlive);
    const spds = aliveEntities.map(e => Math.max(1, statsOf(e).spd));
    let sum = spds.reduce((a, b) => a + b, 0);
    const order = [];

    // 每個回合有 [參戰人數 × ACTION_SLOTS_PER_ENTITY] 個行動槽
    const slots = aliveEntities.length * ACTION_SLOTS_PER_ENTITY;
    for (let i = 0; i < slots; i++) {
      let roll = Math.floor(Math.random() * sum);
      for (let j = 0; j < spds.length; j++) {
        if (roll < spds[j]) {
          order.push(aliveEntities[j]);
          // 抽中的人行動速度暫時減少 3/4
          const reduction = Math.floor(spds[j] * (3 / 4));
          spds[j] -= reduction;
          sum -= reduction;
          break;
        }
        roll -= spds[j];
      }
    }

    return order;
  }

  /**
   * 單體技能要打誰：以仇恨值為權重抽一個目標。
   *
   * 呼叫端只保證候選人都還活著，權重一律現算，所以嘲諷／隱蔽這類 type:'STAT'
   * 的 buff 一掛上就生效、一過期就還原，不需要任何人維護一張仇恨表。
   * 刻度是倍率：aggro 2 的人被抽中的機率是 aggro 1 的兩倍。
   *
   * 兩個刻意的性質：
   * - 權重全等時，這裡選到的索引就是 floor(random × n)，跟改用權重之前那行
   *   均勻抽完全一致，而且同樣只消耗一次亂數。既有的戰鬥（與任何固定亂數的
   *   測試）因此一字不變。
   * - 全場權重都是 0（全員隱蔽、或 lockedStats 鎖掉 aggro）時退回均勻抽。
   *   否則單體技能會找不到目標，雙方互相打不到，戰鬥只能卡到 maxTurns。
   */
  static pickByAggro(candidates) {
    if (candidates.length <= 1) return candidates[0];
    const weights = candidates.map(entity => Math.max(0, statsOf(entity).aggro ?? 1));
    const sum = weights.reduce((a, b) => a + b, 0);
    if (sum <= 0) return candidates[Math.floor(Math.random() * candidates.length)];
    let roll = Math.random() * sum;
    for (let i = 0; i < candidates.length; i++) {
      if (roll < weights[i]) return candidates[i];
      roll -= weights[i];
    }
    return candidates[candidates.length - 1]; // 浮點誤差的收尾
  }

  // 傷害公式 (使用漸進式減傷)
  static calculateDamage(attacker, defender, skillPower = 1, statKey = 'atk', { ignoreDefense = false } = {}) {
    const scale = statsOf(attacker)[statKey];
    if (typeof scale !== 'number') {
      throw new Error(`Damage formula references unknown attacker stat "${statKey}".`);
    }
    // 確保防禦不小於 0 (如果未來有破甲負防禦機制，可以修改這裡)
    const def = ignoreDefense ? 0 : Math.max(0, statsOf(defender).def || 0);
    
    // 防禦常數 (當 def 等於這個常數時，減傷 50%)
    const EHP_C = 300; 

    // 減傷乘數
    const damageMultiplier = EHP_C / (def + EHP_C);

    // 基礎傷害 = (指定攻擊能力 * 技能倍率) * 減傷乘數。
    // 預設仍是 atk；法術等技能可明確指定 int，不影響既有技能。
    const baseDamage = scale * skillPower * damageMultiplier;
    
    // 加入 ±10% 的隨機浮動 (0.9 ~ 1.1)
    return Formulas.applyDamageVariance(baseDamage);
  }

  // 計算連擊次數 (根據速度差)
  static getCombos(attacker, defender) {
    const gap = Math.max(0, statsOf(attacker).spd - statsOf(defender).spd);
    const minC = Math.max(1, Math.ceil(gap / COMBO_GAP_PER_MIN_HIT));
    const maxC = Math.max(1, Math.ceil(gap / COMBO_GAP_PER_MAX_HIT));
    return Math.floor(Math.random() * (maxC - minC + 1)) + minC;
  }

  // 爆擊判定
  static isCritical(attacker) {
    return Math.random() < (statsOf(attacker).cri || 0);
  }

  // 爆擊傷害倍率 (預設 1.5 倍)
  static getCriticalMultiplier(attacker) {
    return statsOf(attacker).criDmg || 1.5;
  }

  // 命中判定
  static isHit(attacker, defender, skillAccuracy = 1) {
    const hitStat = Math.max(0, statsOf(attacker).hit || 0);
    const evaStat = Math.max(0, statsOf(defender).eva || 0);

    // 漸進式閃避計算：閃避值越高，實際閃避機率的成長越平緩 (以 100 為基準點)
    // 例如：eva = 100 -> 50% 閃避 | eva = 300 -> 75% 閃避
    const evadeChance = evaStat / (evaStat + 100);

    // 命中率加成：每 1 點 hit 提供 1% 額外命中
    const hitBonus = hitStat / 100;

    let finalHitRate = skillAccuracy + hitBonus - evadeChance;

    // 保底命中率 10% (0.1)，確保不會出現「完全閃避」的情況
    finalHitRate = Math.max(0.1, finalHitRate);

    // 最高命中率 100% (1.0)
    finalHitRate = Math.min(1.0, finalHitRate);

    return Math.random() < finalHitRate;
  }
}

module.exports = Formulas;
