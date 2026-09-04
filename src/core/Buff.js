class Buff {
  constructor({ id, name, type, duration, value, effect }) {
    this.id = id;
    this.name = name;
    this.type = type; // 'HOT', 'DOT', 'STAT', 'STUN'
    this.duration = duration; // 持續回合數
    this.value = value;
    this.effect = effect; // 可選的自訂效果函式
  }

  // 進入回合前觸發 (例如中毒扣血)
  onPreTurn(entity, logger) {
    if (this.type === 'DOT') {
      logger.addLog({
        type: 'BUFF_EFFECT',
        actorId: entity.id,
        message: `${entity.name} 受到 ${this.name} 影響，失去了 ${this.value} 點生命值！`,
        value: this.value
      });
      entity.takeDamage(this.value, logger);
    } else if (this.type === 'HOT') {
      const heal = Math.min(entity.stats.maxHp - entity.stats.hp, this.value);
      logger.addLog({
        type: 'BUFF_EFFECT',
        actorId: entity.id,
        message: `${entity.name} 受到 ${this.name} 影響，回復了 ${heal} 點生命值！`,
        value: heal
      });
      entity.heal(heal, logger);
    }
  }
}

module.exports = Buff;
