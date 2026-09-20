class Buff {
  constructor({ id, name, type, duration, value, effect, trigger, remainingTriggers, skillIds, chance, message, polarity = 'neutral', dispellable = false, invincible = false }) {
    if (!['positive', 'negative', 'neutral'].includes(polarity) || typeof dispellable !== 'boolean' || typeof invincible !== 'boolean') {
      throw new Error('Invalid buff polarity, dispellable or invincible');
    }
    this.polarity = polarity;
    this.dispellable = dispellable;
    this.invincible = invincible;
    this.id = id;
    this.name = name;
    this.type = type; // 'HOT', 'DOT', 'STAT', 'STUN'
    this.duration = duration; // 持續回合數
    this.value = value;
    this.effect = effect; // 可選的自訂效果函式
    // STUN 的 chance 是「輪到行動時真的被擋下」的機率，每個行動槽各擲一次，
    // 不是「附加這個 buff 的機率」——命中當下 debuff 一定掛上去。
    // 所以 chance 0.3 / duration 4 是「麻痺四個行動槽，每個槽三成動不了」，
    // 而不是「三成機率陷入必定無法行動」。想要後者請在附加端自己擲骰。
    // 省略時預設 1，維持既有「上了就是不能動」的行為。
    if (type === 'STUN') {
      const rate = chance === undefined ? 1 : chance;
      if (!Number.isFinite(rate) || rate <= 0 || rate > 1) {
        throw new Error(`STUN buff "${id}" needs chance in (0, 1], got ${chance}.`);
      }
      this.chance = rate;
      if (message !== undefined) {
        if (typeof message !== 'string' && typeof message !== 'function') {
          throw new Error(`STUN buff "${id}" message must be a string or a function.`);
        }
        this.message = message;
      }
    }
    if (trigger) {
      if (!['BEFORE_ACTION', 'ROUND_START'].includes(trigger) ||
        !Number.isInteger(remainingTriggers) || remainingTriggers < 1 ||
        !Array.isArray(skillIds) || !skillIds.length || skillIds.some(id => typeof id !== 'string' || !id)) {
        throw new Error(`Invalid triggered buff "${id}".`);
      }
      this.trigger = trigger;
      this.remainingTriggers = remainingTriggers;
      this.skillIds = [...skillIds];
    }
  }

  // 擲一次「這個行動槽會不會被擋下」。chance 為 1 時不擲骰，維持既有的必定暈眩。
  rollBlock() {
    return this.chance >= 1 || Math.random() < this.chance;
  }

  // 被擋下時的戰報句子；回呼簽章與技能文案一致，都只收一個 context 物件。
  blockMessage(entity) {
    if (typeof this.message === 'function') return this.message({ entity, buff: this });
    return this.message || `${entity.name} 無法行動！`;
  }

  // 進入回合前觸發 (例如中毒扣血)
  onPreTurn(entity, logger, context) {
    if (this.type === 'DOT') {
      const outcome = entity.takeDamage(this.value, logger, { source: 'DOT', buffId: this.id, deferReactions: true });
      logger.addLog({
        type: 'BUFF_EFFECT',
        actorId: entity.id,
        message: `${entity.name} 受到 ${this.name} 影響，受到了 ${outcome.damage} 點傷害！`,
        value: outcome.damage
      });
      entity.finishDamage(outcome, logger, context);
    } else if (this.type === 'HOT') {
      const heal = Math.min(entity.stats.maxHp - entity.stats.hp, this.value);
      logger.addLog({
        type: 'BUFF_EFFECT',
        actorId: entity.id,
        message: `${entity.name} 受到 ${this.name} 影響，回復了 ${heal} 點生命值！`,
        value: heal
      });
      entity.heal(heal, logger, { engine: context });
    }
  }
}

module.exports = Buff;
