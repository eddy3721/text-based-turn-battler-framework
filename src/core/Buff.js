const { normalizeTags } = require('../utils/Tags');

class Buff {
  constructor({ id, name, type, duration, value, effect, trigger, remainingTriggers, skillIds, chance, message, polarity = 'neutral', dispellable = false, invincible = false, untouchable = false, tags, damageTaken, healTaken, silence, shield }) {
    if (!['positive', 'negative', 'neutral'].includes(polarity) || typeof dispellable !== 'boolean' ||
        typeof invincible !== 'boolean' || typeof untouchable !== 'boolean') {
      throw new Error('Invalid buff polarity, dispellable, invincible or untouchable');
    }
    this.polarity = polarity;
    // 自由標籤，DOT 扣血時放進 hit.tags，見 TAGS.md。
    this.tags = normalizeTags(tags, `Buff "${id}"`);
    this.dispellable = dispellable;
    this.invincible = invincible;
    // 打不到：DAMAGE 的每一擊不擲命中骰，直接落空（見 PROTECTION.md）。
    // 跟 invincible 的差別是「沒碰到」而不是「碰到了但沒受傷」，所以走閃避那條路。
    this.untouchable = untouchable;
    // 承傷倍率（1.0.26）：持有者受到的傷害先乘上 multiplier，再跑 BEFORE_DAMAGE。
    // filter(hit) 決定哪些傷害算數（例如只放大法術）；省略時只作用在 DAMAGE 攻擊，
    // DOT 與環境／直接扣血不受影響。見 PROTECTION.md。
    if (damageTaken !== undefined) {
      const { multiplier, filter } = damageTaken || {};
      if (!Number.isFinite(multiplier) || multiplier < 0 ||
        (filter !== undefined && typeof filter !== 'function')) {
        throw new Error(`Buff "${id}" damageTaken needs a finite nonnegative multiplier and an optional filter function.`);
      }
      this.damageTaken = { multiplier, filter: filter || (hit => hit.source === 'ATTACK') };
    }
    // 治療承受倍率（1.0.33）：持有者受到的所有治療（HEAL 招式、HOT、遊戲層呼叫 heal）乘上 multiplier。
    // damageTaken 的對稱版本，給減療、老化這類「補了也只回一部分」的效果用。見 PROTECTION.md。
    if (healTaken !== undefined) {
      const { multiplier } = healTaken || {};
      if (!Number.isFinite(multiplier) || multiplier < 0) {
        throw new Error(`Buff "${id}" healTaken needs a finite nonnegative multiplier.`);
      }
      this.healTaken = { multiplier };
    }
    // 護盾（1.0.38）：吸收持有者受到的傷害，吸收量在 value 裡逐擊扣掉，扣完就碎掉、從身上移除。
    // 排在承傷倍率、BEFORE_DAMAGE 與無敵之後、LAST_STAND 之前，所以吸收的是最後真正要扣的血。
    // 持續傷害也吸收；招式帶 ignoreShield 才會穿過去。見 PROTECTION.md。
    if (shield !== undefined) {
      if (!Number.isFinite(shield) || shield <= 0) throw new Error(`Buff "${id}" shield needs a positive finite amount.`);
      this.shield = { value: Math.floor(shield), max: Math.floor(shield) };
    }
    // 沉默（1.0.30）：擋下持有者的技能，見 SILENCE.md。
    // true 是傳統的「不能用技能、普攻照常」；物件可以給 filter(skill, entity) 決定擋哪些招，
    // 擋到普攻時改用 fallback（省略時是框架的 ×1 ATK 攻擊）。
    if (silence !== undefined && silence !== false) {
      const config = silence === true ? {} : silence;
      if (!config || typeof config !== 'object' ||
        (config.filter !== undefined && typeof config.filter !== 'function') ||
        (config.fallback !== undefined && typeof config.fallback?.execute !== 'function')) {
        throw new Error(`Buff "${id}" silence must be true or { filter?: function, fallback?: Skill }.`);
      }
      this.silence = {
        filter: config.filter || ((skill, entity) => skill !== entity.normalAttack),
        fallback: config.fallback || null
      };
    }
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
    if (this.silence && message !== undefined) {
      if (typeof message !== 'string' && typeof message !== 'function') {
        throw new Error(`Silence buff "${id}" message must be a string or a function.`);
      }
      this.message = message;
    }
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

  // 沉默擋下某一招時的戰報句子，skill 是原本想用的那一招。
  silenceMessage(entity, skill) {
    if (typeof this.message === 'function') return this.message({ entity, buff: this, skill });
    return this.message || `${entity.name} 被${this.name || '沉默'}封住，無法使用 ${skill.name}！`;
  }

  // 進入回合前觸發 (例如中毒扣血)
  onPreTurn(entity, logger, context) {
    if (this.type === 'DOT') {
      const outcome = entity.takeDamage(this.value, logger, { source: 'DOT', buffId: this.id, tags: this.tags, deferReactions: true });
      logger.addLog({
        type: 'BUFF_EFFECT',
        actorId: entity.id,
        buffId: this.id,
        buffType: 'DOT',
        message: `${entity.name} 受到 ${this.name} 影響，受到了 ${outcome.damage} 點傷害！`,
        value: outcome.damage
      });
      entity.finishDamage(outcome, logger, context);
    } else if (this.type === 'HOT') {
      const heal = Math.min(entity.stats.maxHp - entity.stats.hp, entity.scaleHealing(this.value));
      // 滿血時什麼都沒發生：不印「回復了 0 點」。全隊持續回血在戰報裡每槽洗一行空話，
      // 而且沒有回復就沒有血量變化，也不必跑血量被動（1.0.26）。
      if (heal <= 0) return;
      // buffType 讓顯示端分得出這行是持續傷害還是持續回復，不必比對訊息文字。
      logger.addLog({
        type: 'BUFF_EFFECT',
        actorId: entity.id,
        buffId: this.id,
        buffType: 'HOT',
        message: `${entity.name} 受到 ${this.name} 影響，回復了 ${heal} 點生命值！`,
        value: heal
      });
      entity.heal(heal, logger, { engine: context, scaled: true });
    }
  }
}

module.exports = Buff;
