const Buff = require('./Buff');

class Entity {
  constructor({ id, name, team, stats, normalAttack, counterSkill = null, openingSkill = null, skills = [], buffs = [], passives = [], dialogues = {} }) {
    this.id = id;
    this.name = name;
    this.team = team;
    this.stats = { ...stats }; // 複製一份，避免改到原始資料
    this.stats.luk = stats.luk ?? 0;
    this.stats.maxSp = stats.maxSp ?? stats.sp ?? 0;
    this.stats.sp = stats.sp ?? 0;
    this.openingSkill = openingSkill;
    this.hasActed = false;
    this.normalAttack = normalAttack;
    this.counterSkill = counterSkill;
    this.skills = skills; 
    this.buffs = buffs.map(b => new Buff(b)); 
    this.passives = passives; // 觸發型被動技能/事件
    this.dialogues = { ...dialogues };
    this.isAlive = this.stats.hp > 0;
  }

  // BEFORE_DAMAGE is repeatable. Its action mutates this hit's context.damage.
  // HP_BELOW retains its existing one-shot behavior.
  takeDamage(amount, logger, context = {}) {
    const result = { ...context, target: this, damage: amount, blocked: false, blockMethod: null };
    if (!this.isAlive) return { ...result, damage: 0 };
    for (const passive of [...this.passives]) {
      if (passive.trigger !== 'BEFORE_DAMAGE') continue;
      if (passive.enabled && !passive.enabled(this, result)) continue;
      if (passive.action) passive.action(this, result, logger);
    }
    result.damage = Math.max(0, Math.floor(result.damage));
    if (result.damage === 0) return result;
    this.stats.hp -= result.damage;
    this.checkDeath();
    if (!context.deferReactions) this.finishDamage(result, logger, context.engine);
    return result;
  }

  // Skill records the triggering hit first; direct damage callers settle immediately.
  finishDamage(hit, logger, engine) {
    engine?.settleDeaths();
    if (hit.damage > 0 && this.isAlive) this.checkPassives('ON_HP_CHANGE', logger, engine);
    if (!engine?.result && hit.damage > 0 && this.isAlive && hit.caster?.isAlive) {
      for (const passive of [...hit.caster.passives]) {
        if (!this.isAlive || !hit.caster.isAlive || engine?.result) break;
        if (passive.trigger !== 'AFTER_DAMAGE_DEALT') continue;
        if (passive.enabled && !passive.enabled(hit.caster, hit)) continue;
        passive.action?.(hit.caster, hit, logger, engine);
      }
    }
    engine?.settleDeaths();
    engine?.checkWinCondition();
  }

  heal(amount, logger, { engine, deferReactions = false } = {}) {
    if (!this.isAlive) return 0;
    const before = this.stats.hp;
    this.stats.hp = Math.min(this.stats.maxHp, this.stats.hp + amount);
    if (!deferReactions) this.checkPassives('ON_HP_CHANGE', logger, engine);
    return this.stats.hp - before;
  }

  restoreSp(amount) {
    if (!this.isAlive) return 0;
    const restored = Math.max(0, Math.min(this.stats.maxSp - this.stats.sp, Math.floor(amount)));
    this.stats.sp += restored;
    return restored;
  }

  checkPassives(triggerEvent, logger, engine) {
    if (!logger || !this.isAlive) return;
    [...this.passives].forEach(passive => {
      if (passive.triggered || !this.isAlive || engine?.result) return;

      if (triggerEvent === 'ON_HP_CHANGE' && passive.condition === 'HP_BELOW') {
         if ((this.stats.hp / this.stats.maxHp) <= passive.threshold) {
            passive.triggered = true;
            if (passive.action) {
               passive.action(this, logger, engine);
            }
         }
      }
    });
  }

  checkDeath() {
    if (this.stats.hp <= 0) {
      this.stats.hp = 0;
      this.isAlive = false;
      this.buffs = this.buffs.filter(buff => !buff.trigger);
    }
  }

  addBuff(buffConfig, context) {
    if (buffConfig.stackPolicy === 'refresh') {
      this.buffs = this.buffs.filter(buff => buff.id !== buffConfig.id);
    }
    const buff = new Buff(buffConfig);
    if (context?.counterSource) buff.counterSource = { ...context.counterSource };
    buff.appliedRound = context?.currentTurn;
    this.buffs.push(buff);
  }

  // 回合結束時，減少所有 buff 持續時間，並清除過期的
  tickBuffs() {
    this.buffs.forEach(b => { if (!b.trigger) b.duration--; });
    this.buffs = this.buffs.filter(b => b.trigger ? b.remainingTriggers > 0 : b.duration > 0);
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
