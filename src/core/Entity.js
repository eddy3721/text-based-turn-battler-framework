const Buff = require('./Buff');
const { EMPTY_TAGS } = require('../utils/Tags');
const { Sanity } = require('./Sanity');
const { createBodyParts, selectBodyPart, damageBodyPart } = require('./BodyParts');
const FATIGUE_SEVERITY = { NORMAL: 0, TIRED: 1, EXHAUSTED: 2 };
// 以預設 35% 為準：疲勞 25%、力竭 20%。
const FATIGUE_CAST_PENALTY = { TIRED: 0.10, EXHAUSTED: 0.15 };

class Entity {
  constructor({ id, name, team, stats, normalAttack, counterSkill = null, openingSkill = null, skills = [], buffs = [], passives = [], dialogues = {}, parts = [], actionDisabled = false, lockedStats = [], fatigueEnabled = true, normalAttackSpCost = 1, sanity = false }) {
    if (!Number.isFinite(normalAttackSpCost) || normalAttackSpCost < 0) throw new Error('normalAttackSpCost must be finite and nonnegative');
    this.fatigueEnabled = fatigueEnabled;
    this.normalAttackSpCost = normalAttackSpCost;
    this.reportedFatigue = 'NORMAL';
    // 這個行動槽是不是普攻。由 BattleEngine 在出手前後設定，派發型普攻靠它收費。
    this.inBasicAttackSlot = false;
    this.actionDisabled = actionDisabled;
    this.lockedStats = [...lockedStats];
    this.id = id;
    this.name = name;
    this.team = team;
    this.stats = { ...stats }; // 複製一份，避免改到原始資料
    this.stats.luk = stats.luk ?? 0;
    this.stats.maxSp = stats.maxSp ?? stats.sp ?? 0;
    this.stats.sp = stats.sp ?? 0;
    this.stats.skillCastRate = stats.skillCastRate ?? 0.35;
    if (!Number.isFinite(this.stats.skillCastRate) || this.stats.skillCastRate < 0 || this.stats.skillCastRate > 1) {
      throw new Error('skillCastRate must be a finite number in [0, 1]');
    }
    // 仇恨值：單體敵方技能抽選目標時的權重。全員預設 1，所以不設定的戰鬥
    // 跟以前一樣是均勻抽（見 Formulas.pickByAggro）。刻度就是倍率——aggro 3
    // 的人被選中的機率是常人的三倍——調整一律靠 type:'STAT' 的 buff 乘除。
    this.stats.aggro = stats.aggro ?? 1;
    if (!Number.isFinite(this.stats.aggro) || this.stats.aggro < 0) {
      throw new Error('aggro must be a finite nonnegative number');
    }
    this.openingSkill = openingSkill;
    this.hasActed = false;
    this.normalAttack = normalAttack;
    this.counterSkill = counterSkill;
    this.skills = skills; 
    this.buffs = buffs.map(b => new Buff(b)); 
    this.passives = passives; // 觸發型被動技能/事件
    this.dialogues = { ...dialogues };
    this.isAlive = this.stats.hp > 0;
    this.parts = createBodyParts(parts);
    this.settledDamage = new WeakSet();
    this.sanity = sanity === false ? null : new Sanity(sanity);
  }

  isPanicked() { return this.sanity?.isPanicked() ?? false; }

  changeSanity(delta, logger, context = {}) {
    if (!Number.isFinite(delta)) throw new Error('Sanity delta must be finite');
    return this.sanity?.change(this, delta, logger, context) ?? 0;
  }

  // BEFORE_DAMAGE is repeatable. Its action mutates this hit's context.damage.
  // HP_BELOW retains its existing one-shot behavior.
  takeDamage(amount, logger, context = {}) {
    // 沒帶標籤的傷害（環境、幸運事件、直接扣血）一律是空陣列，讀取端不必判空。
    const result = { ...context, tags: context.tags ?? EMPTY_TAGS, source: context.source || (context.action?.type === 'DAMAGE' ? 'ATTACK' : 'DIRECT'),
      target: this, damage: amount, actualDamage: 0, lethal: false, blocked: false, blockMethod: null };
    if (!this.isAlive) return { ...result, damage: 0 };
    const partMultiplier = context.action?.partDamageMultiplier ?? 1;
    if (!Number.isFinite(partMultiplier) || partMultiplier < 0) throw new Error('partDamageMultiplier must be finite and nonnegative');
    const part = context.action?.type === 'DAMAGE' && context.caster && context.caster !== this
      ? selectBodyPart(this.parts) : null;
    if (part) Object.assign(result, { partId: part.id, partName: part.name, partDamage: 0,
      partDurability: part.durability, partMaxDurability: part.maxDurability, brokePart: false });
    // 承傷倍率排在 BEFORE_DAMAGE 之前：易傷先放大，格擋、減傷再從放大後的數字扣。
    for (const buff of this.buffs) {
      if (buff.damageTaken && buff.damageTaken.filter(result)) {
        result.damage = Math.floor(result.damage * buff.damageTaken.multiplier);
      }
    }
    for (const passive of [...this.passives]) {
      if (passive.trigger !== 'BEFORE_DAMAGE') continue;
      if (passive.enabled && !passive.enabled(this, result)) continue;
      if (passive.action) passive.action(this, result, logger);
    }
    const protection = context.action?.type === 'DAMAGE' && !context.action.ignoreInvincible
      && this.buffs.find(buff => buff.invincible);
    if (protection) {
      result.damage = 0;
      result.blocked = true;
      result.blockMethod = protection.name || '無敵';
    }
    result.damage = Math.max(0, Math.floor(result.damage));
    // 護盾（1.0.38）：照掛上的順序吸收，扣完的盾碎掉並移除，碎掉的名字留在 shieldsBroken 給 finishDamage 印。
    // 有吸收就算格擋：全吸收是「用護盾擋下了」，吸不完是「用護盾抵擋，造成了 N 點傷害」。
    if (result.damage > 0 && !context.action?.ignoreShield) {
      for (const buff of this.buffs) {
        if (!buff.shield || buff.shield.value <= 0 || result.damage <= 0) continue;
        const absorbed = Math.min(buff.shield.value, result.damage);
        buff.shield.value -= absorbed;
        result.damage -= absorbed;
        result.shieldAbsorbed = (result.shieldAbsorbed || 0) + absorbed;
        if (!result.blocked) { result.blocked = true; result.blockMethod = buff.name || '護盾'; }
        if (buff.shield.value <= 0) (result.shieldsBroken ||= []).push(buff);
      }
      if (result.shieldsBroken) this.buffs = this.buffs.filter(buff => !result.shieldsBroken.includes(buff));
    }
    // 保命（1.0.27）：所有倍率、BEFORE_DAMAGE 與無敵都算完，這一擊仍會致死時才執行。
    // 排在最後，攻擊方臨時插進來的增傷被動才蓋不掉「停在 1 HP」。見 docs/PROTECTION.md。
    // 保命的台詞延後（1.0.39）：LAST_STAND 拿到的是暫存用的 logger，寫進來的日誌先放在
    // hit.pendingLogs，等傷害那一行印完、finishDamage 才補印。直接給真的 logger 會讓
    // 「撐住了最後一口氣」排在「造成 N 點傷害」前面——還沒挨打就先講挨完的事。
    if (result.damage > 0 && result.damage >= this.stats.hp) {
      const deferred = logger ? { addLog: entry => (result.pendingLogs ||= []).push(entry) } : logger;
      for (const passive of [...this.passives]) {
        if (passive.trigger !== 'LAST_STAND') continue;
        if (passive.enabled && !passive.enabled(this, result)) continue;
        if (passive.action) passive.action(this, result, deferred);
      }
      result.damage = Math.max(0, Math.floor(result.damage));
    }
    if (result.damage === 0) {
      // 整擊被護盾吃掉要印碎盾、保命壓成 0 也有暫存的台詞；延後結算的呼叫端會自己呼叫 finishDamage。
      if ((result.shieldsBroken || result.pendingLogs) && !context.deferReactions) this.finishDamage(result, logger, context.engine);
      return result;
    }
    result.actualDamage = Math.min(this.stats.hp, result.damage);
    this.stats.hp -= result.damage;
    this.checkDeath();
    result.lethal = !this.isAlive;
    if (part) Object.assign(result, damageBodyPart(part, result.actualDamage, partMultiplier));
    if (!context.deferReactions) this.finishDamage(result, logger, context.engine);
    return result;
  }

  // 閃避風格：命中判定失敗時，讓防守方決定「這次是怎麼躲掉的」。
  //
  // 這條路跟 BEFORE_DAMAGE／blockMethod 是對稱的一對：那邊是「擋下」（攻擊命中了，
  // 傷害被防守方吃掉），這邊是「躲開」（攻擊根本沒碰到）。兩者原本只有前者能由
  // 防守方描述——因為落空發生在 takeDamage 之前，連 hit 物件都還沒有，戰報只能印
  // 攻擊方 action.text.miss 那句通用的「但是被 X 躲開了！」。結果是任何「我有自己的
  // 閃避方式」的單位（翻滾、分裂、殘影、瞬移）都只能靠遊戲層事後改寫字串，
  // 而那種改寫看不到戰鬥狀態，只能用日誌裡的標記硬猜視窗的起訖。
  //
  // evadeMethod 是片段，交給預設文案拼成「但是被 X 用某某躲開了！」，跟 blockMethod
  // 完全同型；evadeMessage 是整句覆寫，留給拼不出來的演出（例如身體散開飄在空中）。
  // 兩個都不設就維持原本的預設句，既有單位的戰報一字不變。
  //
  // 這條路只負責「怎麼描述」，所以刻意不收 logger 也不收 engine：它跑在 MISS 日誌
  // **之前**，在這裡送日誌會讓後果印在「被躲開了」那句話前面。要對躲掉這件事
  // 產生後果請用 AFTER_EVADE（見下）。
  resolveEvasion(context = {}) {
    const evasion = { ...context, target: this, evadeMethod: null, evadeMessage: null };
    for (const passive of [...this.passives]) {
      if (passive.trigger !== 'ON_EVADE') continue;
      if (passive.enabled && !passive.enabled(this, evasion)) continue;
      passive.action?.(this, evasion);
    }
    return evasion;
  }

  // 閃避的反應側（1.0.16）：在 MISS 日誌送出**之後**，對防守方跑一次。
  //
  // 為什麼要多一個觸發器，而不是把 logger 塞給 ON_EVADE：
  //
  // ON_EVADE 的契約是「描述一件已經發生完的事」，它必須跑在組句之前，
  // 所以它印的任何東西都會排在「但是被 X 躲開了！」前面——先講後果再講發生什麼，
  // 順序是反的。這不是加個參數能解決的，是兩件事該分兩個時點。
  //
  // 而「躲掉就回資源」這類設計在此之前**完全無處可掛**：落空不會進 takeDamage，
  // 傷害側從 BEFORE_DAMAGE 到 AFTER_ATTACK_RECEIVED 一個都不會響。
  // 舊文件叫人「改用傷害側的觸發器」，但那一側對落空是全啞的，等於沒有出路。
  //
  // 開放的是副作用，不是重新結算：這一擊已經確定落空，這裡做什麼都不會讓它命中。
  runEvadeReactions(evasion, logger, engine) {
    if (!this.isAlive) return;
    for (const passive of [...this.passives]) {
      if (engine?.result) break;
      if (passive.trigger !== 'AFTER_EVADE') continue;
      if (passive.enabled && !passive.enabled(this, evasion)) continue;
      passive.action?.(this, evasion, logger, engine);
    }
  }

  // Skill records the triggering hit first; direct damage callers settle immediately.
  finishDamage(hit, logger, engine) {
    if (this.settledDamage.has(hit)) return;
    this.settledDamage.add(hit);
    for (const buff of hit.shieldsBroken || []) {
      logger?.addLog({ type: 'SHIELD_BREAK', actorId: hit.caster?.id, targetId: this.id, buffId: buff.id,
        skillId: hit.skill?.id, message: `${this.name} 的${buff.name || '護盾'}碎掉了！` });
    }
    if (hit.brokePart) {
      logger?.addLog({ type: 'PART_BREAK', actorId: hit.caster?.id, targetId: this.id,
        skillId: hit.skill?.id, partId: hit.partId, partName: hit.partName,
        value: hit.partDamage, message: `${this.name} 的${hit.partName}被破壞了！` });
      this.runDamagePassives('ON_PART_BREAK', hit, logger, engine);
    }
    // LAST_STAND 暫存的日誌：排在這一擊本身（傷害行、碎盾、部位破壞）之後、受傷反應之前。
    for (const entry of hit.pendingLogs || []) logger?.addLog(entry);
    if (hit.actualDamage > 0) this.runDamagePassives('AFTER_DAMAGE_RECEIVED', hit, logger, engine);
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

  // New receive/break hooks also report lethal hits. Reactive skills should
  // guard self.isAlive; observers can still record the final actual HP loss.
  runDamagePassives(trigger, hit, logger, engine) {
    for (const passive of [...this.passives]) {
      if (engine?.result) break;
      if (passive.trigger !== trigger) continue;
      if (passive.enabled && !passive.enabled(this, hit)) continue;
      passive.action?.(this, hit, logger, engine);
    }
  }

  // 治療承受倍率（1.0.33）：身上所有 healTaken 相乘。沒有這種 buff 時原數奉還，連取整都不做。
  scaleHealing(amount) {
    const buffs = this.buffs.filter(buff => buff.healTaken);
    if (!buffs.length || !(amount > 0)) return amount;
    return Math.floor(buffs.reduce((value, buff) => value * buff.healTaken.multiplier, amount));
  }

  // scaled：呼叫端已經套過 scaleHealing（HOT 要先算出實際回復量才能印日誌）。
  heal(amount, logger, { engine, deferReactions = false, scaled = false } = {}) {
    if (!this.isAlive) return 0;
    if (!scaled) amount = this.scaleHealing(amount);
    const before = this.stats.hp;
    this.stats.hp = Math.min(this.stats.maxHp, this.stats.hp + amount);
    if (!deferReactions) this.checkPassives('ON_HP_CHANGE', logger, engine);
    return this.stats.hp - before;
  }

  getFatigueStage() {
    if (!this.fatigueEnabled || this.stats.maxSp <= 0) return 'NORMAL';
    const ratio = this.stats.sp / this.stats.maxSp;
    return ratio <= 0.1 ? 'EXHAUSTED' : ratio <= 0.5 ? 'TIRED' : 'NORMAL';
  }

  syncFatigue(logger) {
    const stage = this.getFatigueStage();
    if (!logger || stage === this.reportedFatigue) return;
    // 兩句台詞都在描述惡化，回復時播出來會變成「剛喘完就開始有點喘」。
    // 因此只在階段變嚴重時出字，變輕鬆只更新狀態，等體力再掉下去才重播。
    const worsened = FATIGUE_SEVERITY[stage] > FATIGUE_SEVERITY[this.reportedFatigue];
    this.reportedFatigue = stage;
    if (worsened) logger.addLog({ type: 'FATIGUE', actorId: this.id, stage,
      message: `${this.name} ${stage === 'TIRED' ? '開始有點喘' : '快累到不行了'}` });
  }

  getBasicAttackCost() {
    return this.stats.maxSp > 0 ? this.normalAttackSpCost : 0;
  }

  spendSp(amount, logger) {
    if (!Number.isFinite(amount) || amount < 0) throw new Error('SP cost must be finite and nonnegative');
    if (this.stats.sp < amount) return false;
    this.stats.sp -= amount;
    this.syncFatigue(logger);
    return true;
  }

  restoreSp(amount, logger) {
    if (!this.isAlive) return 0;
    const restored = Math.max(0, Math.min(this.stats.maxSp - this.stats.sp, Math.floor(amount)));
    this.stats.sp += restored;
    if (logger) this.syncFatigue(logger);
    else if (this.getFatigueStage() === 'NORMAL') this.reportedFatigue = 'NORMAL';
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

  removeBuffs(polarity) {
    if (!['positive', 'negative'].includes(polarity)) throw new Error('removeBuffs requires positive or negative');
    const removed = this.buffs.filter(buff => buff.dispellable && buff.polarity === polarity);
    this.buffs = this.buffs.filter(buff => !removed.includes(buff));
    return removed;
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
  // 只認「必定無法行動」的暈眩（chance 1）。機率型麻痺不在這裡擲骰：
  // canAct() 在一個行動槽裡會被呼叫不只一次（幸運事件、以及對手打過來時的反擊判定），
  // 擲骰放進來會在同一個槽裡擲出互相矛盾的結果。
  // 機率型的判定集中在 rollStun()，由 BattleEngine 在行動槽開頭呼叫剛好一次。
  // 代價是機率型麻痺不影響反擊與幸運事件，只擋主動行動——這是刻意的取捨。
  canAct() {
    if (!this.isAlive || this.isPanicked()) return false;
    return !this.buffs.some(b => b.type === 'STUN' && b.chance >= 1);
  }

  // 這個行動槽有沒有被麻痺擋下。回傳擋下它的 Buff（讓呼叫端取用自訂文案），沒有就是 null。
  rollStun() {
    if (!this.isAlive) return null;
    return this.buffs.find(b => b.type === 'STUN' && b.rollBlock()) || null;
  }

  // 這一招有沒有被沉默擋下。回傳擋下它的 Buff，沒有就是 null。見 docs/SILENCE.md。
  silencedBy(skill) {
    if (!skill) return null;
    return this.buffs.find(b => b.silence && b.silence.filter(skill, this)) || null;
  }

  // 取得加成後的能力值
  getEffectiveStats() {
    const effectiveStats = { ...this.stats };
    this.buffs.filter(b => b.type === 'STAT').forEach(b => {
      if (typeof b.effect === 'function') {
        b.effect(effectiveStats);
      }
    });
    // Apply every STAT effect before clamping, so opposing buffs can cancel.
    const stage = this.getFatigueStage();
    const multiplier = stage === 'TIRED' ? 0.8 : stage === 'EXHAUSTED' ? 0.6 : 1;
    for (const key of ['atk', 'def', 'int', 'spd', 'hit', 'eva', 'counter', 'luk', 'cri']) {
      if (typeof effectiveStats[key] === 'number') effectiveStats[key] *= multiplier;
    }
    if (multiplier !== 1) effectiveStats.criDmg = 1 + Math.max(0, (effectiveStats.criDmg || 1.5) - 1) * multiplier;
    // 施放率扣百分點而不是乘倍率，跟 Buff 調整施放率的慣例一致；
    // 在夾限之前扣，才能跟 Buff 的加減互相抵銷。
    effectiveStats.skillCastRate -= FATIGUE_CAST_PENALTY[stage] || 0;
    if (this.sanity) effectiveStats.skillCastRate += this.sanity.castRateModifier(this);
    if (!Number.isFinite(effectiveStats.skillCastRate)) {
      throw new Error('Effective skillCastRate must be finite');
    }
    effectiveStats.skillCastRate = Math.max(0, Math.min(1, effectiveStats.skillCastRate));
    for (const key of this.lockedStats) effectiveStats[key] = 0;
    return effectiveStats;
  }
}

module.exports = Entity;
