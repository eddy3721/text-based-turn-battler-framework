const Formulas = require('../utils/Formulas');
const assignBattleNames = require('../utils/BattleNames');
const Skill = require('./Skill');
const { randomLuckMessage } = require('../utils/LuckEvents');
const basicCounter = new Skill({ id: 'basic_counter', name: '反擊', actions: [{ type: 'DAMAGE', power: 1 }] });
// 沉默擋到普攻、Buff 又沒給 fallback 時的替代攻擊。照普攻收費、吃速度連擊。
const silencedStrike = new Skill({ id: 'silenced_strike', name: '攻擊', actions: [{ type: 'DAMAGE', power: 1 }] });
// 喘息回體比例。必須明顯高於力竭門檻（10%），否則喘完仍在力竭區，
// 下一兩擊就把體力打回 0，戰報會卡在「喘息→力竭→喘息」的迴圈。
const REST_SP_RATIO = 0.4;

// actionTargetResolver 與 targetSelectionResolver 共用的回傳格式檢查。
function validateTargetResolution(resolution, name) {
  if (resolution == null || Array.isArray(resolution)) return;
  if (typeof resolution === 'object' && (resolution.swapSides === true || Array.isArray(resolution.targets))) return;
  throw new Error(`${name} must return an array, { targets[, uncounterable] }, { swapSides: true[, excludeSelf] }, null or undefined.`);
}

const sideOf = targetType => targetType.startsWith('ENEMY_') ? 'ENEMY'
  : targetType.startsWith('ALLY_') ? 'ALLY' : null;

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
    // 延後的目標判定（1.0.41）：同一個行動槽第一次挑「不是自己」的目標時才問，見 docs/ACTIONS.md。
    this.targetSelectionResolver = options.targetSelectionResolver;
    this.skillSelectionResolver = options.skillSelectionResolver;
    this.battleEnd = options.battleEnd;
    this.actionTargetOverride = null;
    // 每個真的出手的行動槽一筆：{ actor, skill, turn, start, end }，start／end 是 logger.logs 的索引
    // （含 start、不含 end）。反擊、觸發技能與 AFTER_ACTION 的後果都算在該槽裡。見 docs/ACTIONS.md。
    this.actionSlots = [];
    // 插隊行動（1.0.38）：insertAction 排進來的 { entity, skill, onSkip }，在目前這個行動槽結束後依序執行。
    this.insertedActions = [];
  }

  // 插隊（1.0.38）：讓 entity 在目前這個行動槽結束、下一個行動槽開始之前，額外執行一次 skill。
  // 給「能量滿了隨時可以放」的終結技、追加攻擊這類不照速度排隊的行動用。見 docs/ACTIONS.md。
  //
  // 插隊的那一槽是完整的行動槽：通知 AFTER_ACTION、記進 actionSlots（帶 inserted: true）。
  // 但它不是速度排出來的那一槽，所以不擲麻痺、不跑幸運事件與疲勞、不扣 Buff 的持續時間。
  // 輪到它時 entity 已經倒下或被必定暈眩擋住（canAct() 為 false），這次插隊就取消，並呼叫 onSkip(entity, skill)。
  insertAction(entity, skill, { onSkip } = {}) {
    if (!entity || typeof skill?.execute !== 'function') throw new Error('insertAction needs an entity and a skill.');
    if (onSkip !== undefined && typeof onSkip !== 'function') throw new Error('insertAction onSkip must be a function.');
    this.insertedActions.push({ entity, skill, onSkip });
  }

  runInsertedActions() {
    while (this.insertedActions.length && !this.result) {
      const { entity, skill, onSkip } = this.insertedActions.shift();
      if (!entity.canAct()) { onSkip?.(entity, skill); continue; }
      const allies = entity.team === 'A' ? this.teamA : this.teamB;
      const enemies = entity.team === 'A' ? this.teamB : this.teamA;
      const slotStart = this.logger.logs.length;
      const slot = entity.inBasicAttackSlot;
      entity.inBasicAttackSlot = false;
      try {
        // 插隊行動也是完整的行動槽，延後的目標判定照樣適用（1.0.41）。
        // 出手前就決定的 actionTargetResolver 維持原樣不介入，免得改掉既有消費者的行為。
        this.withActionTargetOverride(entity, this.pendingTargetResolution(entity, skill),
          () => skill.execute(entity, allies, enemies, this.logger, this));
      } finally {
        entity.inBasicAttackSlot = slot;
      }
      this.settleDeaths();
      this.checkWinCondition();
      this.notifyAction(entity, skill);
      this.actionSlots.push({ actor: entity, skill, turn: this.currentTurn,
        start: slotStart, end: this.logger.logs.length, inserted: true });
    }
    // 戰鬥結束時沒輪到的插隊直接作廢。
    if (this.result) this.insertedActions.length = 0;
  }

  // Resolve one action-slot redirect before the selected skill begins. An array preserves the
  // original fixed hostile-DAMAGE override. { swapSides: true } mirrors every non-SELF target
  // type for the whole cast, including damage, healing, recovery and buffs.
  // { targets: [...], uncounterable: true } (1.0.37) is the array form whose redirected hits
  // cannot be countered: the recipient never chose to fight the caster.
  withActionTargetOverride(caster, resolution, run) {
    const previous = this.actionTargetOverride;
    this.actionTargetOverride = resolution?.pending === true
      ? { caster, pending: true, skill: resolution.skill }
      : this.normalizeTargetResolution(caster, resolution);
    try { return run(); }
    finally { this.actionTargetOverride = previous; }
  }

  normalizeTargetResolution(caster, resolution) {
    const targets = Array.isArray(resolution) ? resolution
      : Array.isArray(resolution?.targets) ? resolution.targets : null;
    return targets?.length
      ? { caster, targets, uncounterable: !Array.isArray(resolution) && resolution.uncounterable === true }
      : resolution?.swapSides === true
        ? { caster, swapSides: true, excludeSelf: resolution.excludeSelf === true } : null;
  }

  // 有 targetSelectionResolver 時，行動槽先掛一個「還沒問」的標記，等第一次挑目標才問。
  pendingTargetResolution(caster, skill) {
    return this.targetSelectionResolver ? { pending: true, skill } : null;
  }

  // 延後的目標判定（1.0.41）。同一個行動槽裡，施放者第一次挑「不是自己」的目標時問一次
  // targetSelectionResolver，答案沿用到這個行動槽結束：後面的段落、子技能、CAST_SKILL 都吃同一個結果。
  // 只作用在自己身上的招式從頭到尾不會問，所以不會出現「判定了卻什麼都沒變」的戰報。
  // 框架不知道問的是混亂、附身還是別的東西，只負責時機與套用。
  settleTargetResolution(caster, targetType) {
    const override = this.actionTargetOverride;
    if (!override?.pending || override.caster !== caster || !sideOf(targetType)) return;
    // 先拿掉標記再問：resolver 裡要是又挑目標，不會遞迴回來重問。
    this.actionTargetOverride = null;
    const resolution = this.targetSelectionResolver({ caster, skill: override.skill, targetType, engine: this });
    validateTargetResolution(resolution, 'targetSelectionResolver');
    this.actionTargetOverride = this.normalizeTargetResolution(caster, resolution);
  }

  // 施放者這次挑 targetType 時實際可選的人（還活著）。會先觸發延後的目標判定，
  // 敵我反轉時 ENEMY_* 給的是我方、ALLY_* 給的是敵方。固定改向（{ targets }）只改 ENEMY_*。
  // 自己挑目標的招式（挑血最少的、挑層數最多的……）一律從這裡拿候選，不要直接讀 enemies：
  // 直接讀的話混亂、附身這類效果就碰不到那一招。見 docs/ACTIONS.md。
  targetPool(caster, targetType) {
    if (targetType === 'SELF') return caster.isAlive ? [caster] : [];
    const side = sideOf(targetType);
    if (!side) throw new Error(`targetPool needs ENEMY_*, ALLY_* or SELF, got "${targetType}".`);
    this.settleTargetResolution(caster, targetType);
    const override = this.actionTargetOverride?.caster === caster ? this.actionTargetOverride : null;
    if (override?.targets && side === 'ENEMY') return override.targets.filter(unit => unit.isAlive);
    const resolved = sideOf(this.resolveActionTargetType(caster, targetType));
    const own = caster.team === 'A' ? this.teamA : this.teamB;
    const other = caster.team === 'A' ? this.teamB : this.teamA;
    const excludeSelf = resolved !== side && this.swapExcludesSelf(caster);
    return (resolved === 'ENEMY' ? other : own)
      .filter(unit => unit.isAlive && !(excludeSelf && unit === caster));
  }

  // 照框架的預設規則從 targetPool 挑：單體敵人吃仇恨，單體隊友均勻抽，全體就是整個候選。
  selectTargets(caster, targetType) {
    const pool = this.targetPool(caster, targetType);
    if (!pool.length || targetType === 'SELF' || targetType.endsWith('_ALL')) return pool;
    const resolved = this.resolveActionTargetType(caster, targetType);
    const fixed = this.actionTargetOverride?.caster === caster && this.actionTargetOverride.targets;
    return [resolved === 'ENEMY_SINGLE' && !fixed ? Formulas.pickByAggro(pool)
      : pool[Math.floor(Math.random() * pool.length)]];
  }

  // 指定目標（options.targets）在敵我反轉下還算不算數：全都站在反轉後那一邊才算，
  // 也就是透過 targetPool／selectTargets 挑出來的。直接從 enemies 挑的照舊作廢、重抽。
  forcedTargetsFollowSwap(caster, targetType, targets) {
    const side = sideOf(this.resolveActionTargetType(caster, targetType));
    if (!side || !targets.length) return false;
    return targets.every(unit => (unit.team === caster.team) === (side === 'ALLY'));
  }

  resolveActionTargetType(caster, targetType, { settle = true } = {}) {
    if (settle) this.settleTargetResolution(caster, targetType);
    const override = this.actionTargetOverride;
    if (!override || override.caster !== caster || !override.swapSides) return targetType;
    return ({
      ENEMY_SINGLE: 'ALLY_SINGLE', ENEMY_ALL: 'ALLY_ALL',
      ALLY_SINGLE: 'ENEMY_SINGLE', ALLY_ALL: 'ENEMY_ALL'
    })[targetType] || targetType;
  }

  // { swapSides: true, excludeSelf: true }：反轉後的 ALLY_* 不含施放者自己。
  // 混亂是「分不清敵我」，打到自己合理；被操控（附身、催眠）是「換了一邊」，
  // 操控者不會拿宿主的拳頭揍宿主。只影響反轉後選出來的我方目標。
  swapExcludesSelf(caster) {
    const override = this.actionTargetOverride;
    return Boolean(override?.swapSides && override.excludeSelf && override.caster === caster);
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
    // forceMiss（1.0.42）：這一擊必定落空，而且不擲命中骰。hitRateModifier 有 10% 的保底命中，
    // 表達不了「這一下根本碰不到」；而 untouchable 是掛在防守方身上的狀態，要先知道
    // 被打的是誰、打的是哪一招才能決定時（同一槽的第二段起才看穿），只有這裡拿得到。
    if (adjustment.forceMiss === true) {
      return { hit: false, forced: true, evadeMessage: adjustment.evadeMessage, hitMessage: adjustment.hitMessage };
    }
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
    if (caster.isPanicked?.() || this.result || this.skillCallStack.some(call => call.caster === caster && call.skillId === skill.id)) return;
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

  // 出招之前（1.0.35）：施放者的敵方可以先對這一招做手腳。cast.damageMultiplier 會乘進
  // 這次 execute 每一擊的傷害（action.damageMultiplier 之後、takeDamage 之前）。
  // 範圍與 AFTER_SKILL_CAST 相同：每次 execute 一次，含子技能、反擊技能、普攻。
  notifySkillCasting(caster, skill) {
    const cast = {
      caster, skill, damageMultiplier: 1,
      isCounter: Boolean(this.counterSource),
      isNormalAttack: skill === caster.normalAttack || caster.inBasicAttackSlot === true
    };
    if (this.result) return cast;
    const observers = caster.team === 'A' ? this.teamB : this.teamA;
    for (const observer of [...observers]) {
      if (this.result) break;
      if (!observer.isAlive) continue;
      observer.runDamagePassives('BEFORE_SKILL_CAST', cast, this.logger, this);
    }
    if (!Number.isFinite(cast.damageMultiplier) || cast.damageMultiplier < 0) {
      throw new Error('BEFORE_SKILL_CAST damageMultiplier must be a finite nonnegative number');
    }
    return cast;
  }

  // 一個行動槽真的出手之後（普攻或技能，死亡已結算），通知場上所有存活單位，
  // 包含出手者自己與隊友。暈眩、喘息、恐慌、略過都不算出手；反擊與
  // CAST_SKILL 觸發的技能屬於同一個行動槽，不另外通知。見 docs/ACTIONS.md。
  notifyAction(actor, skill) {
    if (this.result) return;
    const action = { actor, skill };
    for (const observer of [...this.teamA, ...this.teamB]) {
      if (this.result) break;
      if (!observer.isAlive) continue;
      observer.runDamagePassives('AFTER_ACTION', action, this.logger, this);
    }
    this.settleDeaths();
    this.checkWinCondition();
  }

  // 回合開始時（遭遇戰的 roundStart 之後、疲勞與 ROUND_START Buff 之前）
  // 對每個存活單位執行 trigger: 'ROUND_START' 的被動。見 docs/ACTIONS.md。
  notifyRoundStart() {
    if (this.result) return;
    const round = { round: this.currentTurn };
    for (const entity of [...this.teamA, ...this.teamB]) {
      if (this.result) break;
      if (entity.isAlive) {
        entity.runDamagePassives('ROUND_START', round, this.logger, this);
        continue;
      }
      // 倒下的單位只跑標了 whileDead 的（1.0.43）：等著重生、倒數計時這類「人不在場也要數」的被動。
      for (const passive of [...entity.passives]) {
        if (this.result || entity.isAlive) break;
        if (passive.trigger !== 'ROUND_START' || !passive.whileDead) continue;
        if (passive.enabled && !passive.enabled(entity, round)) continue;
        passive.action?.(entity, round, this.logger, this);
      }
    }
    this.settleDeaths();
    this.checkWinCondition();
  }

  // 讓倒下的單位站回來（1.0.43）：HP 照給的值（至少 1、不超過上限），清掉死亡紀錄，之後再倒下會照常印「倒下了」。
  // 身上的東西不動：倒下時框架已經清掉觸發型 Buff，其他的留給呼叫端決定。站回來的單位這一回合還沒排進行動順序的話，
  // 照常行動；在回合開始時呼叫最自然。回傳是否真的復活了。
  revive(entity, hp) {
    if (!entity || entity.isAlive) return false;
    entity.stats.hp = Math.max(1, Math.min(entity.stats.maxHp ?? Infinity, Math.floor(hp)));
    entity.isAlive = true;
    this.deathLogged.delete(entity.id);
    return true;
  }

  // 戰鬥開場（openingLogs 與開場台詞之後、第 1 回合之前）對每個存活單位執行
  // trigger: 'BATTLE_START' 的被動，各一次。被動可以直接分出勝負：有結果就不進回合迴圈。見 docs/ACTIONS.md。
  notifyBattleStart() {
    if (this.result) return;
    const battle = { maxTurns: this.maxTurns };
    for (const entity of [...this.teamA, ...this.teamB]) {
      if (this.result) break;
      if (!entity.isAlive) continue;
      entity.runDamagePassives('BATTLE_START', battle, this.logger, this);
    }
    this.settleDeaths();
    this.checkWinCondition();
  }

  tryCounter(caster, target, skill, { action, hitIndex = 1, isComboHit = false } = {}) {
    // 宣告不可反擊的招式或擊在擲骰前就排除，不消耗判定。
    if (skill?.uncounterable || action?.uncounterable) return false;
    if (target.actionDisabled || this.counterSource || this.result || !caster.isAlive || !target.canAct()) return false;
    const override = this.actionTargetOverride;
    if (override?.uncounterable && override.caster === caster) return false;
    if (!Formulas.isCounter(caster, target, skill?.counterChanceMultiplier ?? 1)) return false;
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
    // 反擊技能可以宣告 counterStyle: 'detailed' 換掉呈現方式（見 docs/COUNTERS.md）：
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
    // 只丟還擊招式自己的開場白：還擊者以還擊招式（或它帶出的子招式）id 記下的 SKILL_TEXT。
    // 其他 SKILL_TEXT 照常保留——原攻擊者被打到觸發的鎖血台詞、旁觀者的被動、
    // 還擊者自己在還擊途中觸發的被動台詞，都跟還擊招式的文案無關。
    const replySkillIds = new Set([reply.id, ...buffered
      .filter(log => log.actorId === target.id && ['DAMAGE', 'BLOCK', 'MISS'].includes(log.type) && log.skillId)
      .map(log => log.skillId)]);
    (detailed ? buffered : buffered.filter(log => !replyHits.includes(log) &&
      !(log.type === 'SKILL_TEXT' && log.actorId === target.id && replySkillIds.has(log.skillId))))
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
    if (!caster.isAlive || caster.isPanicked?.() || this.result) return;
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
      if (!entity.isAlive || (event === 'BEFORE_ACTION' && entity.isPanicked?.()) || this.result) break;
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
    entity.sanity?.announce(entity, this.logger, this, this.currentTurn);
  }

  // 一次性跑完戰鬥
  start() {
    this.logger.addLog({ type: 'BATTLE_START', message: '戰鬥開始！' });
    this.openingLogs.forEach(log => this.logger.addLog(log));
    [...this.teamA, ...this.teamB].filter(e => e.isAlive).forEach(e => this.dialogue(e, 'opening'));
    this.checkWinCondition();
    this.notifyBattleStart();

    while (this.currentTurn <= this.maxTurns && !this.result) {
      this.executeTurn();
      this.checkWinCondition();
      this.currentTurn++;
    }

    if (!this.result) {
      this.result = 'DRAW'; // 達到最大回合數平手
      this.logger.addLog({ type: 'TEXT', message: `雙方大戰300回合，沒有分出勝負` });
    }

    // 勝負已定、BATTLE_END 之前：遭遇戰可以在這裡補上結尾演出（例如回顧 actionSlots 的精彩重播）。
    // 這時已經不能改變結果，回傳值不使用。
    this.battleEnd?.(this);

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
    for (const entity of [...this.teamA, ...this.teamB]) {
      if (!entity.sanity) continue;
      if (entity.sanity.initialPanicPending) entity.sanity.announce(entity, this.logger, this);
      entity.sanity.round = this.currentTurn;
      if (this.result) return;
    }
    this.roundStart?.(this);
    this.notifyRoundStart();
    if (this.result) return;

    const allEntities = [...this.teamA, ...this.teamB];
    for (const entity of allEntities) if (entity.isAlive) entity.syncFatigue(this.logger);
    for (const entity of allEntities) this.triggerBuffs(entity, 'ROUND_START');
    if (this.result) return;
    const turnOrder = Formulas.determineActionOrder(allEntities);

    for (const entity of turnOrder) {
      // 上一個行動槽（不論它怎麼結束）排進來的插隊，在下一個行動槽開始前執行。
      this.runInsertedActions();
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

      if (entity.isPanicked()) {
        entity.tickBuffs();
        continue;
      }

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
        if (entity.isPanicked()) {
          entity.tickBuffs();
          continue;
        }
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
        // 被沉默擋下的那一招與擋下它的 Buff。一個行動槽最多印一行沉默，
        // 指的是原本想用的那一招（技能被擋、改用的普攻也被擋時，仍寫原本的技能）。
        let silenced = null;
        const checkSilence = () => {
          const buff = entity.silencedBy(selectedSkill);
          if (buff && !silenced) silenced = { buff, skill: selectedSkill };
          return buff;
        };
        if (!entity.hasActed && entity.openingSkill?.canCast(entity, this)) selectedSkill = entity.openingSkill;
        if (selectedSkill && checkSilence()) selectedSkill = null;
        entity.hasActed = true;
        const skillCastChance = this.getSkillCastChance(entity);

        if (!selectedSkill && entity.skills && entity.skills.length > 0 && Math.random() < skillCastChance) {
          // 若決定使用技能，從擁有的技能中隨機抽取一個「可施放」的技能
          const castableSkills = entity.skills.filter(s => s.canCast(entity, this));
          if (castableSkills.length > 0) {
            const randomIndex = Math.floor(Math.random() * castableSkills.length);
            selectedSkill = castableSkills[randomIndex];
            // 抽選照舊從可施放的技能裡抽，抽到被沉默的招才退回普攻。
            // 先過濾再抽會改變沒被沉默的招的機率，也會多吃或少吃亂數。
            if (checkSilence()) selectedSkill = null;
          }
        }

        // 若機率未觸發，或技能皆無法施放，則使用普通攻擊
        if (!selectedSkill && entity.normalAttack) {
          const needsHitCost = entity.normalAttack.dealsBasicAttackDamage;
          if ((needsHitCost && entity.stats.sp < entity.getBasicAttackCost()) || entity.normalAttack.canCast?.(entity, this) === false) {
            const value = entity.restoreSp(Math.max(1, Math.ceil(entity.stats.maxSp * REST_SP_RATIO)));
            // 喘息的文案與後果交給 AFTER_REST 被動（1.0.34）：第一個提供 restMessage 的啟用中被動換掉預設句，
            // 全部啟用中的被動在喘息日誌之後執行。見 docs/ACTIONS.md。
            const rest = { value };
            const restPassives = entity.passives.filter(passive => passive.trigger === 'AFTER_REST' &&
              (!passive.enabled || passive.enabled(entity, rest)));
            const custom = restPassives.find(passive => typeof passive.restMessage === 'function');
            this.logger.addLog({ type: 'REST', actorId: entity.id, value,
              message: custom ? custom.restMessage(entity, rest) : `${entity.name} 暫時停下攻勢，調整呼吸` });
            if (restPassives.length) {
              entity.runDamagePassives('AFTER_REST', rest, this.logger, this);
              this.settleDeaths();
              this.checkWinCondition();
            }
            entity.syncFatigue(this.logger);
            entity.tickBuffs();
            continue;
          }
          selectedSkill = entity.normalAttack;
          const blocker = checkSilence();
          if (blocker) selectedSkill = blocker.silence.fallback || silencedStrike;
        }
        if (silenced) {
          this.logger.addLog({ type: 'SILENCED', actorId: entity.id, buffId: silenced.buff.id,
            skillId: silenced.skill.id, message: silenced.buff.silenceMessage(entity, silenced.skill) });
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

        if (selectedSkill && !entity.isPanicked()) {
          // 標記「這個行動槽是普攻」，派發型普攻轉發給子技能後仍收得到逐擊費用。
          // 一併看 dealsBasicAttackDamage：沒表態的普攻維持原本行為，這個旗標
          // 才真的是選擇加入的，不會默默改掉既有 Boss 的收費。
          // 沉默的替代攻擊頂的是普攻的位置，一樣逐擊收費、吃速度連擊。
          const replacesNormalAttack = silenced && selectedSkill === (silenced.buff.silence.fallback || silencedStrike);
          entity.inBasicAttackSlot = (selectedSkill === entity.normalAttack || replacesNormalAttack)
            && selectedSkill.dealsBasicAttackDamage === true;
          const slotStart = this.logger.logs.length;
          try {
            const redirected = this.actionTargetResolver?.({
              caster: entity, skill: selectedSkill, allies, enemies, engine: this
            });
            validateTargetResolution(redirected, 'actionTargetResolver');
            this.withActionTargetOverride(entity, redirected ?? this.pendingTargetResolution(entity, selectedSkill),
              () => { if (!entity.isPanicked()) selectedSkill.execute(entity, allies, enemies, this.logger, this); });
          } finally {
            entity.inBasicAttackSlot = false;
          }
          this.settleDeaths();
          this.checkWinCondition();
          this.notifyAction(entity, selectedSkill);
          // 分出勝負的那一槽也要記，notifyAction 在有結果時不通知，但這一槽確實出手了。
          this.actionSlots.push({ actor: entity, skill: selectedSkill, turn: this.currentTurn,
            start: slotStart, end: this.logger.logs.length });
        } else if (!entity.isPanicked()) {
          this.logger.addLog({ type: 'TEXT', actorId: entity.id, message: `${entity.name} 略過了行動 (無技能且無普通攻擊可用)。` });
        }
      }

      // 4. Post-turn (減少 Buff 回合數)
      entity.tickBuffs();
    }
    this.runInsertedActions();
    const sanityEntities = [...this.teamA, ...this.teamB].filter(entity => entity.sanity);
    if (sanityEntities.length) this.checkWinCondition();
    if (!this.result) {
      for (const entity of sanityEntities) {
        if (this.result) break;
        entity.sanity?.endRound(entity, this.logger, this);
        this.settleDeaths();
        this.checkWinCondition();
      }
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
