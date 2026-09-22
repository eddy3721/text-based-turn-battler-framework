const Formulas = require('../utils/Formulas');
const assignBattleNames = require('../utils/BattleNames');
const Skill = require('./Skill');
const { randomLuckMessage } = require('../utils/LuckEvents');
const basicCounter = new Skill({ id: 'basic_counter', name: '反擊', actions: [{ type: 'DAMAGE', power: 1 }] });
// 喘息回體比例。必須明顯高於力竭門檻（10%），否則喘完仍在力竭區，
// 下一兩擊就把體力打回 0，戰報會卡在「喘息→力竭→喘息」的迴圈。
const REST_SP_RATIO = 0.4;

class Logger {
  constructor() {
    this.logs = [];
  }
  addLog(entry) {
    this.logs.push(entry);
  }
}

class BattleEngine {
  constructor(teamA, teamB, options = {}) {
    this.teamA = teamA;
    this.teamB = teamB;
    assignBattleNames([...teamA, ...teamB]);
    this.maxTurns = options.maxTurns || 100;
    this.logger = new Logger();
    this.currentTurn = 1;
    this.result = null;
    this.summonFactory = options.summonFactory;
    this.summonCounts = new Map();
    this.nextSummonId = 1;
    this.openingLogs = options.openingLogs || [];
    this.skillResolver = options.skillResolver;
    this.skillCallStack = [];
    this.deathLogged = new Set();
    this.dialogueLogged = new Set();
    this.counterSource = null;
    this.luckEventsEnabled = options.luckEvents?.enabled ?? true;
    this.hitResolver = options.hitResolver;
    this.roundStart = options.roundStart;
    this.actionTargetResolver = options.actionTargetResolver;
    this.skillSelectionResolver = options.skillSelectionResolver;
    this.actionTargetOverride = null;
  }

  // Resolve one action-slot redirect before the selected skill begins. An array preserves the
  // original fixed hostile-DAMAGE override. { swapSides: true } mirrors every non-SELF target
  // type for the whole cast, including damage, healing, recovery and buffs.
  withActionTargetOverride(caster, resolution, run) {
    const previous = this.actionTargetOverride;
    this.actionTargetOverride = Array.isArray(resolution) && resolution.length
      ? { caster, targets: resolution }
      : resolution?.swapSides === true ? { caster, swapSides: true } : null;
    try { return run(); }
    finally { this.actionTargetOverride = previous; }
  }

  resolveActionTargetType(caster, targetType) {
    const override = this.actionTargetOverride;
    if (!override || override.caster !== caster || !override.swapSides) return targetType;
    return ({
      ENEMY_SINGLE: 'ALLY_SINGLE', ENEMY_ALL: 'ALLY_ALL',
      ALLY_SINGLE: 'ENEMY_SINGLE', ALLY_ALL: 'ENEMY_ALL'
    })[targetType] || targetType;
  }

  resolveActionTargets(caster, action, targets) {
    const override = this.actionTargetOverride;
    const targetType = action.targetType || 'ENEMY_SINGLE';
    if (!override?.targets || override.caster !== caster || action.type !== 'DAMAGE' ||
        !['ENEMY_SINGLE', 'ENEMY_ALL'].includes(targetType)) return targets;
    return override.targets.filter(target => target.isAlive);
  }

  resolveHit(caster, target, skill, action, hitIndex) {
    const adjustment = this.hitResolver?.({ caster, target, skill, action, hitIndex,
      turn: this.currentTurn, engine: this }) || {};
    const hit = Formulas.isHit(caster, target, action.accuracy || 1,
      adjustment.hitRateModifier || 0);
    adjustment.afterRoll?.(hit);
    return { hit, evadeMessage: adjustment.evadeMessage, hitMessage: adjustment.hitMessage };
  }

  // Living enemy auras affect only the ordinary active-skill lottery. Equal ids
  // apply once (strongest wins); distinct ids multiply. No state survives death.
  getSkillCastChance(actor) {
    const modifiers = new Map();
    for (const source of [...this.teamA, ...this.teamB]) {
      if (!source.isAlive || source.team === actor.team) continue;
      for (const passive of source.passives) {
        const multiplier = passive.enemySkillCastMultiplier;
        if (multiplier === undefined) continue;
        if (typeof passive.id !== 'string' || !passive.id ||
            !Number.isFinite(multiplier) || multiplier < 0 || multiplier > 1) {
          throw new Error('enemySkillCastMultiplier requires a passive id and a number in [0, 1]');
        }
        modifiers.set(passive.id, Math.min(modifiers.get(passive.id) ?? 1, multiplier));
      }
    }
    return [...modifiers.values()].reduce((chance, multiplier) => chance * multiplier,
      actor.getEffectiveStats().skillCastRate);
  }

  tryLuckEvent(actor) {
    if (!this.luckEventsEnabled || this.result || !actor.canAct()) return false;
    const enemies = (actor.team === 'A' ? this.teamB : this.teamA).filter(e => e.isAlive);
    if (!enemies.length) return false;
    const opponent = enemies.length === 1 ? enemies[0] : enemies[Math.floor(Math.random() * enemies.length)];
    const profile = Formulas.luckEventProfile(actor, opponent);
    if (profile.gap <= 0) return false;
    const tier = Formulas.rollLuckEvent(profile);
    if (!tier) return false;
    const damage = Formulas.softenLuckDamage(
      Formulas.applyDamageVariance(tier === 'RED' ? profile.redDamage : profile.purpleDamage), tier);
    const hit = actor.takeDamage(damage, this.logger,
      { source: 'LUCK_EVENT', tier, engine: this, deferReactions: true });
    this.logger.addLog({ type: 'LUCK_EVENT', tier, actorId: actor.id, targetId: actor.id,
      opponentId: opponent.id, value: hit.damage, actionCancelled: true,
      ...randomLuckMessage(tier, actor.name, hit.damage) });
    actor.finishDamage(hit, this.logger, this);
    return true;
  }

  withSkill(caster, skill, run) {
    if (this.result || this.skillCallStack.some(call => call.caster === caster && call.skillId === skill.id)) return;
    this.skillCallStack.push({ caster, skillId: skill.id });
    try { return run(); }
    finally { this.skillCallStack.pop(); }
  }

  // Broadcast completed casts to living opponents. This is deliberately a
  // battle-level event instead of skill metadata: observers can react to old
  // and newly-added skills without every skill author opting in.
  notifySkillCast(caster, skill) {
    const observers = caster.team === 'A' ? this.teamB : this.teamA;
    const cast = { caster, skill };
    for (const observer of [...observers]) {
      if (!observer.isAlive) continue;
      observer.runDamagePassives('AFTER_SKILL_CAST', cast, this.logger, this);
    }
  }

  tryCounter(caster, target, skill, { action, hitIndex = 1, isComboHit = false } = {}) {
    // 宣告不可反擊的招式或擊在擲骰前就排除，不消耗判定。
    if (skill?.uncounterable || action?.uncounterable) return false;
    if (target.actionDisabled || this.counterSource || this.result || !caster.isAlive || !target.canAct()) return false;
    if (!Formulas.isCounter(caster, target)) return false;
    const callChain = this.skillCallStack.filter(call => call.caster === target).map(call => call.skillId);
    const reply = target.counterSkill?.canCast(target, this, { callChain }) ? target.counterSkill : basicCounter;
    if (reply === basicCounter && target.stats.sp < target.getBasicAttackCost()) return false;
    const source = { actorId: target.id, targetId: caster.id, incomingSkillId: skill.id };
    const buffered = [];
    const counterLogger = {
      addLog: entry => buffered.push({ ...entry, isCounter: true, counterSource: source })
    };
    const battleLogger = this.logger;
    // Death, dialogue and triggered effects log through engine.logger, so temporarily route
    // all reply output into the same buffer. This lets the summary precede consequences.
    this.logger = counterLogger;
    try {
      this.withCounterSource(source, () => {
        reply.execute(target, target.team === 'A' ? this.teamA : this.teamB,
          target.team === 'A' ? this.teamB : this.teamA, counterLogger, this,
          { targets: [caster], basicCounter: reply === basicCounter });
      });
    } finally {
      this.logger = battleLogger;
    }

    const replyHits = buffered.filter(log =>
      log.targetId === caster.id && ['DAMAGE', 'BLOCK', 'MISS'].includes(log.type));
    const value = replyHits.reduce((sum, log) => sum + (log.value || 0), 0);
    const isCrit = replyHits.some(log => log.isCrit && (log.value || 0) > 0);
    const counterBy = `${target.name}${reply === basicCounter ? '' : `以${reply.name}`}`;
    // 開頭沿用被反制那一擊自己的文案，單段是「A 使出了 X，」、多段是「第 N 擊，」。
    const incoming = Skill.composeLead(skill, action, caster, target, { hitIndex, isComboHit });
    // 反擊技能可以宣告 counterStyle: 'detailed' 換掉呈現方式（見 COUNTERS.md）：
    // 濃縮版把結果塞進 COUNTER 那一句，還擊自己的傷害行會被丟掉；詳細版只讓
    // COUNTER 宣告「被反擊了」，接著原封不動放行還擊自己的文案。
    // 預設仍是濃縮：一般還擊沒有自訂文案，放行只會得到「X 攻擊，造成 N 點傷害！」
    // 這種與上一行重複的廢話。有自己演出的招式才值得多佔一行。
    const detailed = reply.counterStyle === 'detailed';
    let resultText;
    if (value > 0) resultText = `${isCrit ? '會心一擊！' : ''}受到 ${value} 點傷害！`;
    else if (replyHits.some(log => log.type === 'BLOCK')) resultText = `反擊被${caster.name}擋下了！`;
    else if (replyHits.some(log => log.type === 'MISS')) resultText = '反擊落空了！';
    else resultText = '反擊成功！';
    battleLogger.addLog({ type: 'COUNTER', actorId: target.id, targetId: caster.id,
      skillId: reply.id, skillTier: reply.tier, isNormalAttack: reply === basicCounter,
      incomingSkillId: skill.id, value, isCrit,
      ...(replyHits.some(log => log.partId) ? { partHits: replyHits.filter(log => log.partId).map(log => ({
        partId: log.partId, partName: log.partName, partDamage: log.partDamage, actualDamage: log.actualDamage
      })) } : {}),
      // 詳細版的 value／isCrit 仍然照舊寫進紀錄，換掉的只有句子——
      // 統計與 UI 讀的是欄位，不該因為換了呈現方式就少一筆數字。
      message: `${incoming}但是遭${counterBy}反擊${detailed ? '！' : `，${resultText}`}` });
    // The reply's damage is represented by the COUNTER line. Keep status, death and dialogue logs.
    (detailed ? buffered : buffered.filter(log => !replyHits.includes(log) && log.type !== 'SKILL_TEXT'))
      .forEach(log => battleLogger.addLog(log));
    return true;
  }

  withCounterSource(source, run) {
    const previous = this.counterSource;
    this.counterSource = previous || source || null;
    try { return run(); }
    finally { this.counterSource = previous; }
  }

  getCastableSkills(caster, skillIds, callChain = this.skillCallStack
    .filter(call => call.caster === caster).map(call => call.skillId)) {
    if (typeof this.skillResolver !== 'function') throw new Error('CAST_SKILL requires skillResolver(id).');
    if (!Array.isArray(skillIds) || !skillIds.length || skillIds.some(id => typeof id !== 'string' || !id)) {
      throw new Error('CAST_SKILL requires a non-empty skillIds array.');
    }
    return [...new Set(skillIds)].map(id => {
      const skill = this.skillResolver(id);
      if (!skill || typeof skill.execute !== 'function' || typeof skill.canCast !== 'function') {
        throw new Error(`Unknown or invalid skill "${id}".`);
      }
      return skill;
    }).filter(skill => skill.canCast(caster, this, { ignoreSp: true, callChain }));
  }

  // Calls use the skill's own targeting and metadata, without an action slot or child SP cost.
  castSkill(caster, skillIds, options = {}) {
    if (!caster.isAlive || this.result) return;
    const pool = this.getCastableSkills(caster, skillIds);
    if (!pool.length) return;
    const skill = pool[Math.floor(Math.random() * pool.length)];
    const allies = caster.team === 'A' ? this.teamA : this.teamB;
    const enemies = caster.team === 'A' ? this.teamB : this.teamA;
    skill.execute(caster, allies, enemies, this.logger, this, { ...options, ignoreSp: true });
    return skill;
  }

  dialogue(entity, event) {
    const text = entity.dialogues?.[event];
    const key = `${entity.id}:${event}`;
    if (!text || this.dialogueLogged.has(key)) return;
    this.dialogueLogged.add(key);
    this.logger.addLog({ type: 'BOSS_DIALOGUE', actorId: entity.id,
      message: `${entity.name}：「${text}」` });
  }

  settleDeaths() {
    for (const entity of [...this.teamA, ...this.teamB]) {
      if (entity.isAlive || this.deathLogged.has(entity.id)) continue;
      this.deathLogged.add(entity.id);
      entity.buffs = entity.buffs.filter(buff => !buff.trigger);
      this.logger.addLog({ type: 'DEATH', actorId: entity.id, message: `${entity.name} 倒下了！` });
      this.dialogue(entity, 'death');
    }
  }

  triggerBuffs(entity, event) {
    for (const buff of [...entity.buffs]) {
      if (!entity.isAlive || this.result) break;
      if (!entity.buffs.includes(buff) || buff.trigger !== event || buff.remainingTriggers <= 0) continue;
      if (event === 'ROUND_START') {
        if (buff.appliedRound === this.currentTurn || buff.lastTriggeredRound === this.currentTurn) continue;
        buff.lastTriggeredRound = this.currentTurn;
      }
      // Consume before invoking: refreshed/reentrant effects cannot fire twice in this pass.
      buff.remainingTriggers--;
      if (!buff.remainingTriggers) entity.buffs = entity.buffs.filter(b => b !== buff);
      this.withCounterSource(buff.counterSource, () => this.castSkill(entity, buff.skillIds));
    }
  }

  canSummon(caster, action) {
    // maxAlive 掃兩邊陣營：敵對的增援（summonHostile）站在對面，只看自己這隊會漏算，
    // 變成「召出來的是敵人就不佔名額」。
    const summoned = [...this.teamA, ...this.teamB]
      .filter(e => e.isAlive && e.summonerId === caster.id).length;
    return caster.isAlive && typeof this.summonFactory === 'function' &&
      (this.summonCounts.get(caster.id) || 0) < (action.maxTotal ?? 4) &&
      summoned < (action.maxAlive ?? 2);
  }

  summon(caster, action, skill) {
    if (!this.canSummon(caster, action)) return;
    let id;
    do { id = `summon_${this.nextSummonId++}`; }
    while ([...this.teamA, ...this.teamB].some(e => e.id === id));
    const pool = action.monsterIds;
    const monsterId = pool?.length ? pool[Math.floor(Math.random() * pool.length)] : action.monsterId;
    const entity = this.summonFactory(monsterId, { entityId: id });
    // 計數的是「嘗試」而不是「成功」：招不到人也用掉了這次機會。
    // 只算成功的話，maxTotal 就從「一場只能召喚一次」變成「一場只能成功一次」，
    // 招不到人的技能會在之後每個行動槽重試並把戰報洗滿失敗訊息。
    const count = (this.summonCounts.get(caster.id) || 0) + 1;
    this.summonCounts.set(caster.id, count);
    // 工廠回傳 null／undefined 代表「這次沒有可用的增援」——素材耗盡、
    // 牢籠已空、放下的印記沒人回應。這是遊戲層才知道的事，框架只負責不要炸掉，
    // 並讓技能用 text.fail 決定這一行怎麼寫。
    if (!entity) {
      this.logger.addLog({ type: 'SUMMON_FAILED', actorId: caster.id,
        skillId: skill.id, skillTier: skill.tier, isNormalAttack: false,
        message: skill.summonFailMessage(action, caster) });
      return;
    }
    // 增援預設加入召喚者的陣營，但工廠可以把實體標成 summonHostile 讓它站到對面。
    // 召喚不保證是幫手——儀式失控、信號引來了入侵者、牢籠裡放出來的東西不認主人。
    // summonerId 照樣記，敵對的增援也追得回是誰招來的。
    const hostile = entity.summonHostile === true;
    entity.team = hostile ? (caster.team === 'A' ? 'B' : 'A') : caster.team;
    entity.summonerId = caster.id;
    (entity.team === 'A' ? this.teamA : this.teamB).push(entity);
    this.logger.addLog({ type: 'SUMMON', actorId: caster.id, targetId: id,
      skillId: skill.id, isNormalAttack: false,
      message: skill.summonMessage(action, caster, entity) });
  }

  // 一次性跑完戰鬥
  start() {
    this.logger.addLog({ type: 'BATTLE_START', message: '戰鬥開始！' });
    this.openingLogs.forEach(log => this.logger.addLog(log));
    [...this.teamA, ...this.teamB].filter(e => e.isAlive).forEach(e => this.dialogue(e, 'opening'));
    this.checkWinCondition();

    while (this.currentTurn <= this.maxTurns && !this.result) {
      this.executeTurn();
      this.checkWinCondition();
      this.currentTurn++;
    }

    if (!this.result) {
      this.result = 'DRAW'; // 達到最大回合數平手
      this.logger.addLog({ type: 'TEXT', message: `雙方大戰300回合，沒有分出勝負` });
    }

    this.logger.addLog({ type: 'BATTLE_END', message: `戰鬥結束，獲勝方: ${this.result}` });

    return {
      winner: this.result,
      logs: this.logger.logs,
      finalTeamA: this.teamA,
      finalTeamB: this.teamB
    };
  }

  executeTurn() {
    if (this.result) return;
    this.logger.addLog({ type: 'TURN_START', turn: this.currentTurn, message: `--- 第 ${this.currentTurn} 回合 ---` });
    this.roundStart?.(this);

    const allEntities = [...this.teamA, ...this.teamB];
    for (const entity of allEntities) if (entity.isAlive) entity.syncFatigue(this.logger);
    for (const entity of allEntities) this.triggerBuffs(entity, 'ROUND_START');
    if (this.result) return;
    const turnOrder = Formulas.determineActionOrder(allEntities);

    for (const entity of turnOrder) {
      if (!entity.isAlive) continue;
      if (this.result) break; // 戰鬥已結束

      // 1. Pre-turn (Buffs DOT/HOT)
      for (const buff of [...entity.buffs]) {
        if (!entity.isAlive || this.result) break;
        this.withCounterSource(buff.counterSource, () => buff.onPreTurn(entity, this.logger, this));
      }
      if (!entity.isAlive) {
        this.settleDeaths();
        this.checkWinCondition();
        continue;
      }
      if (this.result) break;

      // 2. 判斷是否能行動
      // 這是每個行動槽唯一一次 STUN 擲骰的地方；必定暈眩與機率型麻痺都走這條。
      const stun = entity.rollStun();
      if (stun) {
        this.logger.addLog({
          type: 'TEXT', actorId: entity.id, buffId: stun.id, message: stun.blockMessage(entity)
        });
      } else if (!entity.actionDisabled && entity.getFatigueStage() === 'EXHAUSTED' && Math.random() < 0.2) {
        this.logger.addLog({ type: 'FATIGUE_SKIP', actorId: entity.id, message: `${entity.name} 累得無法動彈` });
      } else {
        this.triggerBuffs(entity, 'BEFORE_ACTION');
        if (this.result) break;
        if (!entity.isAlive) continue;
        if (this.tryLuckEvent(entity)) {
          entity.tickBuffs();
          continue;
        }
        if (entity.actionDisabled) {
          this.logger.addLog({ type: 'TEXT', actorId: entity.id, message: `${entity.name}沒有動。` });
          entity.tickBuffs();
          continue;
        }
        // 3. 行動：選擇技能與目標
        const allies = entity.team === 'A' ? this.teamA : this.teamB;
        const enemies = entity.team === 'A' ? this.teamB : this.teamA;

        // 技能選擇邏輯：預設 35% 機率釋放技能，否則普通攻擊
        let selectedSkill = null;
        if (!entity.hasActed && entity.openingSkill?.canCast(entity, this)) selectedSkill = entity.openingSkill;
        entity.hasActed = true;
        const skillCastChance = this.getSkillCastChance(entity);

        if (!selectedSkill && entity.skills && entity.skills.length > 0 && Math.random() < skillCastChance) {
          // 若決定使用技能，從擁有的技能中隨機抽取一個「可施放」的技能
          const castableSkills = entity.skills.filter(s => s.canCast(entity, this));
          if (castableSkills.length > 0) {
            const randomIndex = Math.floor(Math.random() * castableSkills.length);
            selectedSkill = castableSkills[randomIndex];
          }
        }

        // 若機率未觸發，或技能皆無法施放，則使用普通攻擊
        if (!selectedSkill && entity.normalAttack) {
          const needsHitCost = entity.normalAttack.dealsBasicAttackDamage;
          if ((needsHitCost && entity.stats.sp < entity.getBasicAttackCost()) || entity.normalAttack.canCast?.(entity, this) === false) {
            const value = entity.restoreSp(Math.max(1, Math.ceil(entity.stats.maxSp * REST_SP_RATIO)));
            this.logger.addLog({ type: 'REST', actorId: entity.id, value,
              message: `${entity.name} 暫時停下攻勢，調整呼吸` });
            entity.syncFatigue(this.logger);
            entity.tickBuffs();
            continue;
          }
          selectedSkill = entity.normalAttack;
        }

        if (selectedSkill && this.skillSelectionResolver) {
          const replacement = this.skillSelectionResolver({
            caster: entity, skill: selectedSkill, allies, enemies, engine: this
          });
          if (replacement !== undefined) {
            if (!replacement || typeof replacement.execute !== 'function') {
              throw new Error('skillSelectionResolver must return a skill or undefined.');
            }
            selectedSkill = replacement;
          }
        }

        if (selectedSkill) {
          // 標記「這個行動槽是普攻」，派發型普攻轉發給子技能後仍收得到逐擊費用。
          // 一併看 dealsBasicAttackDamage：沒表態的普攻維持原本行為，這個旗標
          // 才真的是選擇加入的，不會默默改掉既有 Boss 的收費。
          entity.inBasicAttackSlot = selectedSkill === entity.normalAttack
            && selectedSkill.dealsBasicAttackDamage === true;
          try {
            const redirected = this.actionTargetResolver?.({
              caster: entity, skill: selectedSkill, allies, enemies, engine: this
            });
            const swapsSides = redirected && !Array.isArray(redirected) &&
              typeof redirected === 'object' && redirected.swapSides === true;
            if (redirected != null && !Array.isArray(redirected) && !swapsSides) {
              throw new Error('actionTargetResolver must return an array, { swapSides: true }, null or undefined.');
            }
            this.withActionTargetOverride(entity, redirected,
              () => selectedSkill.execute(entity, allies, enemies, this.logger, this));
          } finally {
            entity.inBasicAttackSlot = false;
          }
          this.settleDeaths();
          this.checkWinCondition();
        } else {
          this.logger.addLog({ type: 'TEXT', actorId: entity.id, message: `${entity.name} 略過了行動 (無技能且無普通攻擊可用)。` });
        }
      }

      // 4. Post-turn (減少 Buff 回合數)
      entity.tickBuffs();
    }
  }

  checkWinCondition() {
    if (this.result) return;

    const teamAAlive = this.teamA.some(e => e.isAlive);
    const teamBAlive = this.teamB.some(e => e.isAlive);

    if (!teamAAlive && !teamBAlive) {
      this.result = 'DRAW';
    } else if (!teamAAlive) {
      this.result = 'TEAM_B';
    } else if (!teamBAlive) {
      this.result = 'TEAM_A';
    }
    if (this.result === 'TEAM_A' || this.result === 'TEAM_B') {
      const winners = this.result === 'TEAM_A' ? this.teamA : this.teamB;
      winners.filter(e => e.isAlive).forEach(e => this.dialogue(e, 'victory'));
    }
  }
}

module.exports = BattleEngine;
