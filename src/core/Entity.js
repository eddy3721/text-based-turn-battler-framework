const Buff = require('./Buff');

class Entity {
  constructor({ id, name, team, stats, normalAttack, skills = [], buffs = [], passives = [] }) {
    this.id = id;
    this.name = name;
    this.team = team;
    this.stats = { ...stats }; // 複製一份，避免改到原始資料
    this.normalAttack = normalAttack;
    this.skills = skills; 
    this.buffs = buffs.map(b => new Buff(b)); 
    this.passives = passives; // 觸發型被動技能/事件
    this.isAlive = this.stats.hp > 0;
  }

  takeDamage(amount, logger) {
    this.stats.hp -= amount;
    this.checkDeath();
    this.checkPassives('ON_HP_CHANGE', logger);
  }

  heal(amount, logger) {
    this.stats.hp = Math.min(this.stats.maxHp, this.stats.hp + amount);
    this.checkPassives('ON_HP_CHANGE', logger);
  }

  checkPassives(triggerEvent, logger) {
    if (!logger) return; // 保護機制
    this.passives.forEach(passive => {
      if (passive.triggered) return;

      if (triggerEvent === 'ON_HP_CHANGE' && passive.condition === 'HP_BELOW') {
         if ((this.stats.hp / this.stats.maxHp) <= passive.threshold) {
            passive.triggered = true;
            if (passive.action) {
               passive.action(this, logger);
            }
         }
      }
    });
  }

  checkDeath() {
    if (this.stats.hp <= 0) {
      this.stats.hp = 0;
      this.isAlive = false;
    }
  }

  addBuff(buffConfig) {
    this.buffs.push(new Buff(buffConfig));
  }

  // 回合結束時，減少所有 buff 持續時間，並清除過期的
  tickBuffs() {
    this.buffs.forEach(b => b.duration--);
    this.buffs = this.buffs.filter(b => b.duration > 0);
  }

  // 判斷是否能行動 (例如是否有暈眩 Buff)
  canAct() {
    if (!this.isAlive) return false;
    return !this.buffs.some(b => b.type === 'STUN');
  }

  // 取得加成後的能力值
  getEffectiveStats() {
    const effectiveStats = { ...this.stats };
    this.buffs.filter(b => b.type === 'STAT').forEach(b => {
      if (typeof b.effect === 'function') {
        b.effect(effectiveStats);
      }
    });
    return effectiveStats;
  }
}

module.exports = Entity;
