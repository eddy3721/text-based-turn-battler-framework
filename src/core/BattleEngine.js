const Formulas = require('../utils/Formulas');
const assignBattleNames = require('../utils/BattleNames');

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
    this.logger.addLog({ type: 'TURN_START', turn: this.currentTurn, message: `--- 第 ${this.currentTurn} 回合 ---` });

    const allEntities = [...this.teamA, ...this.teamB];
    const turnOrder = Formulas.determineActionOrder(allEntities);

    for (const entity of turnOrder) {
      if (!entity.isAlive) continue;
      if (this.result) break; // 戰鬥已結束

      // 1. Pre-turn (Buffs DOT/HOT)
      entity.buffs.forEach(buff => buff.onPreTurn(entity, this.logger));
      if (!entity.isAlive) {
        this.logger.addLog({ type: 'DEATH', actorId: entity.id, message: `${entity.name} 倒下了！` });
        this.checkWinCondition();
        continue;
      }

      // 2. 判斷是否能行動
      if (!entity.canAct()) {
        this.logger.addLog({ type: 'TEXT', actorId: entity.id, message: `${entity.name} 無法行動！` });
      } else {
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
          // 紀錄施放技能前的存活狀態
          const allEntitiesList = [...allies, ...enemies];
          const aliveBefore = new Map(allEntitiesList.map(e => [e.id, e.isAlive]));
          
          selectedSkill.execute(entity, allies, enemies, this.logger, this);

          // 檢查是否有剛才死亡的單位並加入戰報
          allEntitiesList.forEach(t => {
            if (!t.isAlive && aliveBefore.get(t.id)) {
              this.logger.addLog({ type: 'DEATH', actorId: t.id, message: `${t.name} 倒下了！` });
            }
          });
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
  }
}

module.exports = BattleEngine;
