class Buff {
  constructor({ id, name, type, duration, value, effect, trigger, remainingTriggers, skillIds }) {
    this.id = id;
    this.name = name;
    this.type = type; // 'HOT', 'DOT', 'STAT', 'STUN'
    this.duration = duration; // 持續回合數
    this.value = value;
    this.effect = effect; // 可選的自訂效果函式
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

  // 進入回合前觸發 (例如中毒扣血)
  onPreTurn(entity, logger, context) {
    if (this.type === 'DOT') {
      const outcome = entity.takeDamage(this.value, logger, { deferReactions: true });
      logger.addLog({
        type: 'BUFF_EFFECT',
        actorId: entity.id,
        message: `${entity.name} 受到 ${this.name} 影響，失去了 ${outcome.damage} 點生命值！`,
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
