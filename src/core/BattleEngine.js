const Formulas = require('../utils/Formulas');
const assignBattleNames = require('../utils/BattleNames');
const Skill = require('./Skill');
const { randomLuckMessage } = require('../utils/LuckEvents');
const basicCounter = new Skill({ id: 'basic_counter', name: '反擊', actions: [{ type: 'DAMAGE', power: 1 }] });

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
    const damage = Formulas.applyDamageVariance(tier === 'RED' ? profile.redDamage : profile.purpleDamage);
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

  tryCounter(caster, target, skill, { action, hitIndex = 1, isComboHit = false } = {}) {
    if (this.counterSource || this.result || !caster.isAlive || !target.canAct()) return false;
    if (!Formulas.isCounter(target)) return false;
    const callChain = this.skillCallStack.filter(call => call.caster === target).map(call => call.skillId);
    const reply = target.counterSkill?.canCast(target, this, { callChain }) ? target.counterSkill : basicCounter;
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
    let resultText;
    if (value > 0) resultText = `${isCrit ? '會心一擊！' : ''}受到 ${value} 點傷害！`;
    else if (replyHits.some(log => log.type === 'BLOCK')) resultText = `反擊被${caster.name}擋下了！`;
    else if (replyHits.some(log => log.type === 'MISS')) resultText = '反擊落空了！';
    else resultText = '反擊成功！';
    battleLogger.addLog({ type: 'COUNTER', actorId: target.id, targetId: caster.id,
      skillId: reply.id, skillTier: reply.tier, isNormalAttack: reply === basicCounter,
      incomingSkillId: skill.id, value, isCrit,
      message: `${incoming}但是遭${counterBy}反擊，${resultText}` });
    // The reply's damage is represented by the COUNTER line. Keep status, death and dialogue logs.
    buffered.filter(log => !replyHits.includes(log) && log.type !== 'SKILL_TEXT')
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
    const team = caster.team === 'A' ? this.teamA : this.teamB;
    return caster.isAlive && typeof this.summonFactory === 'function' &&
      (this.summonCounts.get(caster.id) || 0) < (action.maxTotal ?? 4) &&
      team.filter(e => e.isAlive && e.summonerId === caster.id).length < (action.maxAlive ?? 2);
  }

  summon(caster, action, skill) {
    if (!this.canSummon(caster, action)) return;
    let id;
    do { id = `summon_${this.nextSummonId++}`; }
    while ([...this.teamA, ...this.teamB].some(e => e.id === id));
    const pool = action.monsterIds;
    const monsterId = pool?.length ? pool[Math.floor(Math.random() * pool.length)] : action.monsterId;
    const entity = this.summonFactory(monsterId, { entityId: id });
    entity.team = caster.team;
    entity.summonerId = caster.id;
    const count = (this.summonCounts.get(caster.id) || 0) + 1;
    this.summonCounts.set(caster.id, count);
    (caster.team === 'A' ? this.teamA : this.teamB).push(entity);
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

    const allEntities = [...this.teamA, ...this.teamB];
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
      if (!entity.canAct()) {
        this.logger.addLog({ type: 'TEXT', actorId: entity.id, message: `${entity.name} 無法行動！` });
      } else {
        this.triggerBuffs(entity, 'BEFORE_ACTION');
        if (this.result) break;
        if (!entity.isAlive) continue;
        if (this.tryLuckEvent(entity)) {
          entity.tickBuffs();
          continue;
        }
        // 3. 行動：選擇技能與目標
        const allies = entity.team === 'A' ? this.teamA : this.teamB;
        const enemies = entity.team === 'A' ? this.teamB : this.teamA;

        // 技能選擇邏輯：預設40%機率釋放技能，否則普通攻擊
        let selectedSkill = null;
        if (!entity.hasActed && entity.openingSkill?.canCast(entity, this)) selectedSkill = entity.openingSkill;
        entity.hasActed = true;
        const skillCastChance = 0.4;

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
          selectedSkill = entity.normalAttack;
        }

        if (selectedSkill) {
          selectedSkill.execute(entity, allies, enemies, this.logger, this);
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
