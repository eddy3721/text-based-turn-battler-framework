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

class Formulas {
  // 決定行動順序，這裡採用基於速度的權重抽籤
  static determineActionOrder(entities) {
    const aliveEntities = [...entities].filter(e => e.isAlive);
    const spds = aliveEntities.map(e => Math.max(1, statsOf(e).spd));
    let sum = spds.reduce((a, b) => a + b, 0);
    const order = [];

    // 每個回合有 [參戰人數] 個行動槽
    for (let i = 0; i < aliveEntities.length; i++) {
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

  // 傷害公式 (使用漸進式減傷)
  static calculateDamage(attacker, defender, skillPower = 1) {
    const atk = statsOf(attacker).atk || 0;
    // 確保防禦不小於 0 (如果未來有破甲負防禦機制，可以修改這裡)
    const def = Math.max(0, statsOf(defender).def || 0);
    
    // 防禦常數 (當 def 等於這個常數時，減傷 50%)
    const EHP_C = 300; 

    // 減傷乘數
    const damageMultiplier = EHP_C / (def + EHP_C);

    // 基礎傷害 = (攻擊力 * 技能倍率) * 減傷乘數
    let baseDamage = atk * skillPower * damageMultiplier;
    
    // 加入 ±10% 的隨機浮動 (0.9 ~ 1.1)
    const variance = 0.9 + (Math.random() * 0.2);
    baseDamage = baseDamage * variance;
    
    return Math.max(1, Math.floor(baseDamage)); // 確保最低造成 1 點傷害
  }

  // 計算連擊次數 (根據速度差)
  static getCombos(attacker, defender) {
    const gap = Math.max(0, statsOf(attacker).spd - statsOf(defender).spd);
    const minC = Math.max(1, Math.ceil(gap / 40));
    const maxC = Math.max(1, Math.ceil(gap / 15));
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
