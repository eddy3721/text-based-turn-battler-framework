const Formulas = require('../utils/Formulas');
const { normalizeTags, mergeTags } = require('../utils/Tags');
const { random } = require('../utils/Random');

/**
 * 戰報文字。
 *
 * 所有訊息回呼——不論是片段（action.text.*）還是整句覆寫（action.message）——
 * 都只收「一個 context 物件」，四種 action type 的簽章完全一致：
 *
 *   {
 *     caster,    // 施放者
 *     target,    // 單一目標；TEXT 段為 null
 *     targets,   // 目標陣列；TEXT 段用這個
 *     value,     // 本段產生的數值：DAMAGE = 傷害、HEAL = 回復量；BUFF/TEXT 為 null
 *     isCrit,    // 僅 DAMAGE 有意義，其餘恆為 false
 *     hitIndex,  // 第幾擊，僅 DAMAGE 有意義，其餘恆為 1
 *     buff,      // 僅 BUFF：當下這一筆 buff 設定
 *     skill      // 技能本身，可取 skill.name
 *   }
 *
 * 之所以不用位置參數，是因為以前 message 在四種 type 下代表四組不同的參數
 * （DAMAGE 第三個是傷害、BUFF 第三個是 buff 物件、TEXT 第二個是「陣列」），
 * 從別的技能複製一段訊息過來就會印出 [object Object] 或 undefined。
 *
 * 傷害與回復量共用 value：對戰報而言兩者都只是「這段動作產生的數值」，
 * 分成兩個欄位只會逼每個回呼去記自己屬於哪一種。
 *
 * 各 type 的拼法：
 *   DAMAGE 命中   lead + (爆擊 ? crit : '') + hit      lead = 第一擊 action、連擊 combo
 *   DAMAGE 落空   lead + miss
 *   DAMAGE 格擋   lead + block（不拼接 crit / hit）
 *   HEAL         action + heal
 *   RESTORE_SP   action + recover
 *   SUMMON       action + summon
 *   BUFF         action + buff
 *   TEXT         action
 *
 * 只覆寫想改的片段即可，其餘沿用預設。片段可以是字串或函式。
 * 句型完全不同拼不出來時，用 action.message 整句覆寫（優先於片段）。
 *
 * 上面這些都是「攻擊方」在描述自己的招式。防守方也有兩個欄位可以插話，
 * 由它自己的被動填入，攻擊方不需要知道：
 *   blockMethod   BEFORE_DAMAGE 被動填，預設 block 片段拼成「用某某擋下了！」
 *   evadeMethod   ON_EVADE 被動填，預設 miss 片段拼成「用某某躲開了！」
 * 落空還可以用 evadeMessage 整句覆寫，且優先於攻擊方的 action.message——
 * 「對手是怎麼躲掉的」只有防守方知道。詳見 docs/EVASION.md。
 */
const DefaultText = {
  DAMAGE: {
    action: (ctx) => `${ctx.caster.name} 攻擊，`,
    combo: (ctx) => `第 ${ctx.hitIndex} 擊，`,
    crit: '會心一擊！',
    hit: (ctx) => `對 ${ctx.target.name}${ctx.partName ? ` 的${ctx.partName}` : ''} 造成了 ${ctx.value} 點傷害！`,
    // evadeMethod 由防守方的 ON_EVADE 被動填入（見 Entity.resolveEvasion），
    // 跟下面 block 讀 blockMethod 是同一種寫法：預設句留一個洞給防守方補。
    // 沒有 evadeMethod 時必須一字不差地還原成原本的「但是被 X 躲開了！」——
    // 名字後面那個空格是既有戰報的一部分，所以洞開在空格之後而不是之前。
    miss: (ctx) => `但是被 ${ctx.target.name} ${ctx.evadeMethod ? `用${ctx.evadeMethod}` : ''}躲開了！`,
    block: (ctx) => ctx.value === 0
      ? `但是被 ${ctx.target.name}${ctx.blockMethod ? ` 用${ctx.blockMethod}` : ''}擋下了！`
      : `但是被 ${ctx.target.name}${ctx.blockMethod ? ` 用${ctx.blockMethod}` : ''}抵擋，造成了 ${ctx.value} 點傷害！`
  },
  HEAL: {
    action: (ctx) => `${ctx.caster.name} 治療，`,
    heal: (ctx) => `使 ${ctx.target.name} 回復了 ${ctx.value} 點生命！`
  },
  RESTORE_SP: {
    action: (ctx) => `${ctx.caster.name} 的${ctx.skill.name}`,
    recover: (ctx) => `使 ${ctx.target.name} 回復了 ${ctx.value} SP！`
  },
  CHANGE_SANITY: {
    action: (ctx) => `${ctx.caster.name} 的${ctx.skill.name}，`,
    sanity: (ctx) => `使 ${ctx.target.name} 的理智 ${ctx.before} → ${ctx.after}！`
  },
  // SUMMON 的 target 是剛生出來的增援實體。
  // fail 是工廠沒有可用增援時的後半段，此時 target 為 null。
  SUMMON: {
    action: (ctx) => `${ctx.caster.name} `,
    summon: (ctx) => `召來了 ${ctx.target.name}！`,
    fail: () => '沒有得到任何回應。'
  },
  BUFF: {
    action: () => '',
    buff: (ctx) => `${ctx.target.name} 被附加了 ${ctx.buff.name} 狀態！`
  },
  TEXT: {
    action: (ctx) => `${ctx.caster.name} 使用了 ${ctx.skill.name}！`
  }
};

const resolvePart = (part, ctx) => (typeof part === 'function' ? part(ctx) : part);

/**
 * 建立訊息用的 context，把各 type 缺席的欄位補成一致的預設值，
 * 這樣回呼永遠拿得到同一組鍵，不必判斷自己身處哪一種 action。
 */
const makeContext = (skill, caster, overrides) => ({
  caster,
  target: null,
  targets: [],
  value: null,
  isCrit: false,
  blocked: false,
  blockMethod: null,
  evadeMethod: null,
  // 僅 SUMMON：這次招來的是不是站在對面的敵對增援。
  hostile: false,
  hitIndex: 1,
  buff: null,
  skill,
  ...overrides
});

/**
 * 依 action type 把片段拼成一句戰報。action.message 存在時直接整句覆寫。
 * @param {Object} action 該段動作定義
 * @param {Object} ctx makeContext 產生的 context
 * @param {Object} [flags]
 * @param {Boolean} [flags.isComboHit] DAMAGE：是否為連擊的第 2 擊之後
 * @param {Boolean} [flags.isHitLanded] DAMAGE：命中或落空
 */
function composeMessage(action, ctx, { isComboHit = false, isHitLanded = true } = {}) {
  if (action.message) return action.message(ctx);

  const text = { ...DefaultText[action.type], ...(action.text || {}) };
  const part = (p) => resolvePart(p, ctx);

  if (action.type === 'HEAL') return part(text.action) + part(text.heal);
  if (action.type === 'RESTORE_SP') return part(text.action) + part(text.recover);
  if (action.type === 'CHANGE_SANITY') return part(text.action) + part(text.sanity);
  if (action.type === 'SUMMON') return part(text.action) + part(text.summon);
  if (action.type === 'BUFF') return part(text.action) + part(text.buff);
  if (action.type === 'TEXT') return part(text.action);

  const lead = part(isComboHit ? text.combo : text.action);
  if (!isHitLanded) return lead + part(text.miss);
  if (ctx.blocked) return lead + part(text.block);
  return lead + (ctx.isCrit ? part(text.crit) : '') + part(text.hit);
}

/**
 * 一次施放的結果（CastReport，1.0.47）：execute 的回傳值。
 *
 * 給「打中才觸發」的附帶效果用：昏迷、流血、感染該掛在**實際被打的人**身上，
 * 而不是呼叫端原本想打的那個人。以前拿不到這份資料，遊戲層只能翻 logger.logs 找 MISS、
 * 或在打之前記下血量再比較，兩種都會在目標被換掉（混亂反轉）、護盾吸收、同時被治療時判錯。
 *
 * 範圍是這一次 execute 的傷害段，跟 AFTER_ATTACK_DEALT 同一條界線：
 * 別人的反擊、CAST_SKILL 叫出來的子技能各有自己的結果，不算在這裡。
 * 覆寫了 execute 的技能不一定會把結果往上傳，只有直接走基底 Skill 的呼叫保證拿得到。
 *
 * targets 每個目標一筆，依第一次出手的順序：
 *   attempts 出手幾擊（含落空、被反擊截下的）；missed 落空；countered 被反擊截下；
 *   landed 真的打到身上的擊數（含被格擋、被護盾吃掉）；blocked 其中被格擋的；crits 爆擊；
 *   damage 戰報上的傷害合計；actualDamage 實際扣掉的 HP；shieldAbsorbed 護盾吸收；defeated 施放結束時已倒下。
 * landed（陣列）是至少打到一擊的目標，給最常見的「打中的人身上掛效果」用。
 */
function createCastReport(skill, caster) {
  return { skill, caster, targets: [], landed: [] };
}

function castEntry(report, target) {
  if (!report) return null;
  let entry = report.targets.find(item => item.target === target);
  if (!entry) {
    entry = { target, attempts: 0, landed: 0, missed: 0, countered: 0, blocked: 0, crits: 0,
      damage: 0, actualDamage: 0, shieldAbsorbed: 0, defeated: false };
    report.targets.push(entry);
  }
  return entry;
}

function finishCastReport(report) {
  for (const entry of report.targets) entry.defeated = !entry.target.isAlive;
  report.landed = report.targets.filter(entry => entry.landed > 0).map(entry => entry.target);
  return report;
}

class Skill {
  constructor({ id, name, actions = [], tier = 'standard', counterStyle = 'summary',
    uncounterable = false, counterChanceMultiplier = 1, tags }) {
    // 打錯字若安靜地退回 summary，就只會看到「反擊怎麼沒照我寫的演出」，
    // 而那跟「這場剛好沒反擊」在戰報上長得一樣。
    if (!['summary', 'detailed'].includes(counterStyle)) {
      throw new Error(`Skill "${id}" has unknown counterStyle "${counterStyle}".`);
    }
    if (typeof uncounterable !== 'boolean') {
      throw new Error(`Skill "${id}" uncounterable must be a boolean.`);
    }
    if (!Number.isFinite(counterChanceMultiplier) ||
        counterChanceMultiplier < 0 || counterChanceMultiplier > 1) {
      throw new Error(`Skill "${id}" counterChanceMultiplier must be between 0 and 1.`);
    }
    for (const action of actions) {
      if (action.type === 'CHANGE_SANITY' && !Number.isFinite(action.amount)) {
        throw new Error('CHANGE_SANITY requires a finite amount');
      }
      if (action.ignoreInvincible !== undefined && (action.type !== 'DAMAGE' || typeof action.ignoreInvincible !== 'boolean')) {
        throw new Error('ignoreInvincible requires a DAMAGE action and a boolean');
      }
      if (action.damageMultiplier !== undefined && (action.type !== 'DAMAGE' || !Number.isFinite(action.damageMultiplier) || action.damageMultiplier < 0)) {
        throw new Error('damageMultiplier requires a DAMAGE action and a finite nonnegative value');
      }
      if (action.ignoreDefense !== undefined &&
          (action.type !== 'DAMAGE' || typeof action.ignoreDefense !== 'boolean')) {
        throw new Error('ignoreDefense requires a DAMAGE action and a boolean');
      }
      if (action.partDamageMultiplier !== undefined &&
          (action.type !== 'DAMAGE' || !Number.isFinite(action.partDamageMultiplier) || action.partDamageMultiplier < 0)) {
        throw new Error('partDamageMultiplier requires a DAMAGE action and a finite nonnegative value');
      }
      if (action.uncounterable !== undefined &&
          (action.type !== 'DAMAGE' || typeof action.uncounterable !== 'boolean')) {
        throw new Error('uncounterable requires a DAMAGE action and a boolean');
      }
      // 段落標籤只給傷害段：BUFF 段的標籤寫在各筆 buff 設定上，由 DOT 自己帶著走。
      if (action.hitOrder !== undefined && (action.type !== 'DAMAGE' || !['target', 'wave'].includes(action.hitOrder) ||
        (action.hitOrder === 'wave' && action.combo))) {
        throw new Error(`Skill "${id}" hitOrder must be 'target' or 'wave' on a DAMAGE action without combo.`);
      }
      if (action.tags !== undefined && action.type !== 'DAMAGE') {
        throw new Error('action tags require a DAMAGE action');
      }
      normalizeTags(action.tags, `Skill "${id}" action`);
    }
    this.id = id;
    this.name = name;
    this.tier = tier; // standard / ultimate，提供戰報呈現使用
    // 這招被當成 counterSkill 時的戰報呈現方式，見 docs/COUNTERS.md。
    this.counterStyle = counterStyle;
    // 整招不進入反擊判定（例如延遲引爆的陷阱），見 docs/COUNTERS.md。
    this.uncounterable = uncounterable;
    // 每一擊的被反擊機率倍率；1 維持原率，0 仍保留判定語意但不會成功。
    this.counterChanceMultiplier = counterChanceMultiplier;
    // 自由標籤，框架不解讀，見 docs/TAGS.md。
    this.tags = normalizeTags(tags, `Skill "${id}"`);
    this.actions = actions; // 多段動作陣列
  }

  /**
   * 這招當普攻用時，是否真的會打出傷害段——也就是該不該收普攻的逐擊費用。
   *
   * 預設看 actions，這對資料驅動的技能是對的。但派發型普攻（自身 actions 為空，
   * execute 裡轉發給子技能）會被判成 false，於是整套體力機制對它靜靜失效：
   * 不收費、體力見底也不改為喘息，只會空轉掉一個行動槽。
   * 這種技能必須覆寫這個 getter 回 true。
   */
  get dealsBasicAttackDamage() {
    return this.actions.some(action => action.type === 'DAMAGE');
  }

  // 判斷是否能發動此技能 (看總體力消耗)
  canCast(entity, context, { ignoreSp = false, callChain = [] } = {}) {
    if (entity.actionDisabled || entity.isPanicked?.()) return false;
    const totalSpCost = this.actions.reduce((sum, action) => sum + (action.spCost || 0), 0);
    const basicCost = this === entity.normalAttack && this.dealsBasicAttackDamage
      ? entity.getBasicAttackCost() : 0;
    if (callChain.includes(this.id)) return false;
    return entity.stats.sp >= basicCost && (ignoreSp || entity.stats.sp >= totalSpCost + basicCost) && this.actions.every(action => {
      if (action.type === 'SUMMON') return context?.canSummon(entity, action);
      if (action.type === 'CAST_SKILL') {
        return (context?.getCastableSkills(entity, action.skillIds, [...callChain, this.id]).length || 0) > 0;
      }
      return true;
    });
  }

  // 增援實體由 BattleEngine 生成，日誌也在那邊寫，但文案仍走這裡的片段拼裝，
  // 技能才能用 text.action / text.summon 或 action.message 覆寫召喚台詞。
  summonMessage(action, caster, summoned) {
    return composeMessage(action, makeContext(this, caster,
      { target: summoned, targets: [summoned], hostile: summoned.summonHostile === true }));
  }

  // 工廠沒有可用增援時的那一行。沿用 SUMMON 的 action 前綴，只換後半段，
  // 這樣「X 召來了 Y！」與「X 沒有得到任何回應。」共用同一個開頭。
  // 目標不存在，所以 ctx.target 是 null——text.fail 不該去讀它。
  summonFailMessage(action, caster) {
    const ctx = makeContext(this, caster, {});
    if (action.failMessage) return action.failMessage(ctx);
    const text = { ...DefaultText.SUMMON, ...(action.text || {}) };
    return resolvePart(text.action, ctx) + resolvePart(text.fail, ctx);
  }

  // 選擇目標的輔助函式
  _selectTargets(targetType, caster, allies, enemies, { excludeSelf = false } = {}) {
    const aliveEnemies = enemies.filter(e => e.isAlive);
    // excludeSelf 只在被操控的反轉下開啟（見 BattleEngine.swapExcludesSelf）。
    // 隊上只剩自己時就沒有目標，這一段跳過，不會改打自己。
    const aliveAllies = allies.filter(e => e.isAlive && !(excludeSelf && e === caster));

    switch (targetType) {
      case 'ENEMY_SINGLE':
        if (aliveEnemies.length === 0) return [];
        // 仇恨值只作用在這裡。ALLY_SINGLE 維持均勻抽：仇恨的語意是「敵人想打誰」，
        // 拿它決定補師補誰會讓嘲諷坦克順便變成補血磁鐵，那是另一條權重。
        return [Formulas.pickByAggro(aliveEnemies)];
      case 'ENEMY_ALL':
        return aliveEnemies;
      case 'ALLY_SINGLE':
        if (aliveAllies.length === 0) return [];
        return [aliveAllies[Math.floor(random() * aliveAllies.length)]];
      case 'ALLY_ALL':
        return aliveAllies;
      case 'SELF':
        return [caster];
      default:
        return [];
    }
  }

  // 執行技能。回傳這一次施放的結果（CastReport，1.0.47），見 createCastReport。
  execute(caster, allies, enemies, logger, context, options = {}) {
    const report = createCastReport(this, caster);
    if (caster.actionDisabled || caster.isPanicked?.()) return finishCastReport(report);
    // Aggregate actual HP loss across every hit of this cast, separately per target.
    const receivedAttacks = new Map();
    const run = () => {
      // 出招前問一次敵方（BEFORE_SKILL_CAST，1.0.35），他們可以壓低這一招所有傷害段的傷害。
      const cast = context?.notifySkillCasting?.(caster, this);
      const castDamageMultiplier = cast?.damageMultiplier ?? 1;
      this._execute(caster, allies, enemies, logger, context,
        { ...options, receivedAttacks, castDamageMultiplier, report });
      for (const [target, hit] of receivedAttacks) {
        target.runDamagePassives('AFTER_ATTACK_RECEIVED', hit, logger, context);
        context?.settleDeaths();
        context?.checkWinCondition();
        // Attacker-side mirror of the same aggregate. Without it, "react once per
        // attack" was only expressible by the defender: an attacker passive had to
        // use the per-hit AFTER_DAMAGE_DEALT and re-derive the end of the attack
        // from hitIndex === hits, which silently miscounts multi-action skills
        // (each action restarts the index) and forces every consumer to rebuild
        // the aggregation the framework already did here.
        // Ordering follows finishDamage: the receiver reacts before the dealer.
        if (!caster.isAlive) continue;
        caster.runDamagePassives('AFTER_ATTACK_DEALT', hit, logger, context);
        context?.settleDeaths();
        context?.checkWinCondition();
      }
      context?.notifySkillCast?.(caster, this);
      return finishCastReport(report);
    };
    return context ? context.withSkill(caster, this, run) : run();
  }

  _execute(caster, allies, enemies, logger, context, options) {
    let currentTargets = [];
    let forcedTargets = options.targets;
    const damagedTargets = new Set();
    if (context?.counterSource) {
      const parentLogger = logger;
      const source = { ...context.counterSource };
      logger = { addLog: entry => parentLogger.addLog({ ...entry, isCounter: true, counterSource: source }) };
    }

    for (const action of this.actions) {
      if (!caster.isAlive || caster.isPanicked?.() || context?.result) break;
      if (action.type === 'SUMMON' && !context?.canSummon(caster, action)) continue;
      // 1. 扣除該段 SP
      const cost = options.ignoreSp ? 0 : action.spCost || 0;
      if (caster.stats.sp < cost) {
        break; // 體力不足以執行後續段落，中斷
      }
      if (caster.spendSp) caster.spendSp(cost, logger);
      else caster.stats.sp -= cost; // Legacy plain-object skill callers.
      if (action.type === 'CAST_SKILL') {
        if (!context) throw new Error(`CAST_SKILL in "${this.id}" requires a BattleEngine context.`);
        // 子技能是獨立的一招，不繼承普攻的逐擊費用——這跟 AFTER_ATTACK_RECEIVED
        // 把 CAST_SKILL 分開計算是同一條界線（見 docs/INANIMATE.md）。
        // 派發型普攻是直接呼叫子技能的 execute，不走這裡，所以仍然收得到。
        const slot = caster.inBasicAttackSlot;
        caster.inBasicAttackSlot = false;
        try { context.castSkill(caster, action.skillIds); }
        finally { caster.inBasicAttackSlot = slot; }
        continue;
      }
      if (action.type === 'SUMMON') {
        context.summon(caster, action, this);
        continue;
      }

      // 2. 決定目標 (是否延續上一段的目標)
      const inherit = action.inheritTarget !== false;
      const baseTargetType = action.targetType || 'ENEMY_SINGLE';
      // 沒寫 targetType 的 TEXT 只是扣 SP、印開場白，不算「挑目標」，不觸發延後的目標判定。
      const settles = action.type !== 'TEXT' || action.targetType !== undefined;
      const pending = context?.actionTargetOverride?.pending === true && context.actionTargetOverride.caster === caster;
      const targetType = context?.resolveActionTargetType
        ? context.resolveActionTargetType(caster, baseTargetType, { settle: settles })
        : baseTargetType;
      const swappedSides = targetType !== baseTargetType;
      // 反轉下的指定目標：透過 engine.targetPool／selectTargets 挑的已經站在反轉後那一邊，照用；
      // 直接從 enemies 挑的會打錯邊，作廢後照反轉後的 targetType 重抽（1.0.41 之前一律作廢）。
      const forcedFollows = !swappedSides || Boolean(forcedTargets &&
        context?.forcedTargetsFollowSwap?.(caster, baseTargetType, forcedTargets));
      // 嚴格模式（strictTargeting，1.0.47）：不靜默重抽，直接拋錯。重抽讓傷害照樣打得出去、戰報也正常，
      // 但呼叫端還以為打的是自己挑的那個人，後面的附帶效果就會掛錯人（打了自己，昏迷卻落在對面）。
      if (action.type === 'DAMAGE' && forcedTargets && !forcedFollows && context?.strictTargeting) {
        throw new Error(`Skill "${this.id}": options.targets were picked from the original side, but this cast is ` +
          'side-swapped (confusion or control). Pick them with engine.targetPool() or engine.selectTargets() ' +
          'so they follow the swap. (strictTargeting)');
      }
      if (action.type === 'DAMAGE' && forcedTargets && forcedFollows) {
        currentTargets = forcedTargets.filter(target => target.isAlive);
        forcedTargets = null;
      } else if (!inherit || currentTargets.length === 0 || (pending && swappedSides)) {
        // 第三個條件：反轉是這一段才判定出來的，前面沒寫 targetType 的 TEXT 抓到的還是反轉前那一邊，不能延續。
        // 不延續，或是目前還沒有目標，就依照本段（可能經敵我反轉）的 targetType 抓取。
        currentTargets = this._selectTargets(targetType, caster, allies, enemies,
          { excludeSelf: swappedSides && Boolean(context?.swapExcludesSelf?.(caster)) });
      }
      // A legacy fixed-target redirect replaces hostile damage targets after ordinary and
      // explicitly-forced targeting. Side swaps were already applied to targetType above.
      if (action.type === 'DAMAGE' && context?.resolveActionTargets) {
        currentTargets = context.resolveActionTargets(caster, action, currentTargets);
      }

      // 如果本段依然找不到目標，就跳過本段效果
      if (currentTargets.length === 0) continue;

      // 3. 執行本段效果
      if (action.type === 'TEXT') {
        logger.addLog({
          type: 'SKILL_TEXT',
          actorId: caster.id,
          skillId: this.id,
          skillTier: this.tier,
          isNormalAttack: this === caster.normalAttack,
          // 帶上 targets 讓文字可以根據目標改變；單一目標的場合 target 也一併給
          message: composeMessage(
            action,
            makeContext(this, caster, {
              targets: currentTargets,
              target: currentTargets[0] || null
            })
          )
        });
        continue;
      }

      // 一擊的完整判定（扣費、命中、反擊、傷害、日誌）。回傳 false 代表這個目標的後續段數不必再打。
      // isComboHit 決定開頭用 combo 還是 action 片段：逐波順序下每個目標在每一波都是第一行。
      const strikeOnce = (target, i, hits, isNormalAttack, tags, isComboHit) => {
        if (!target.isAlive || !caster.isAlive || caster.isPanicked?.() || context?.result) return false;
        // Pay for the attempt, including misses and attacks intercepted by counters.
        if (isNormalAttack && !caster.spendSp(caster.getBasicAttackCost(), logger)) return false;

        const hitIndex = i + 1;
        const record = castEntry(options.report, target);
        if (record) record.attempts++;

        // A successful counter has already won its reaction check, so its reply cannot miss.
        const rolls = !context?.counterSource && !action.ignoreInvincible;
        // 打不到的目標不擲骰：沒有 untouchable 的戰鬥 RNG 序列一步都不會變。
        const untouchable = rolls ? target.buffs.find(buff => buff.untouchable) || null : null;
        const hitRoll = untouchable ? { hit: false }
          : rolls ? (context?.resolveHit?.(caster, target, this, action, hitIndex)
            || { hit: Formulas.isHit(caster, target, action.accuracy || 1) })
          : { hit: true };
        if (!hitRoll.hit) {
          // 落空先問防守方「你是怎麼躲的」，再組句；不答就維持原本的預設文案。
          const evasion = target.resolveEvasion(
            { caster, skill: this, action, hitIndex, hits, isNormalAttack, tags, untouchable,
              forcedMiss: hitRoll.forced === true });
          logger.addLog({
            type: 'MISS',
            actorId: caster.id,
      skillId: this.id,
      skillTier: this.tier,
      isNormalAttack,
            targetId: target.id,
            ...(evasion.evadeMethod ? { evadeMethod: evasion.evadeMethod } : {}),
            // 防守方的整句覆寫排在攻擊方 action.message 之前：閃避方式是只有
            // 防守方知道的事，攻擊方的技能文案寫不出「對手是怎麼躲掉的」。
            message: hitRoll.evadeMessage || evasion.evadeMessage || composeMessage(
              action,
              makeContext(this, caster, { target, targets: [target], hitIndex, evadeMethod: evasion.evadeMethod }),
              { isComboHit, isHitLanded: false }
            )
          });
          if (record) record.missed++;
          // 反應側排在 MISS 之後：先讓戰報說「躲掉了」，後果才接在下一行。
          target.runEvadeReactions(evasion, logger, context);
          return true;
        }

        if (hitRoll.hitMessage) logger.addLog({ type: 'BOSS_DIALOGUE',
          actorId: target.id, skillId: this.id, message: hitRoll.hitMessage });

        // 每一擊各自判定：多段技能挨的刀多，給對手的機會就該多。
        if (context?.tryCounter(caster, target, this,
          { action, hitIndex, isComboHit })) {
          if (record) record.countered++;
          return true;
        }

        const isCrit = Formulas.isCritical(caster);
        // 傷害預設依賴 atk；action.stat 可讓法術等技能改用 int 或其他能力。
        // Formulas 會在欄位不存在時直接拋錯，避免拼錯後悄悄打成最低傷害。
        let damage = Formulas.calculateDamage(caster, target, action.power || 1, action.stat || 'atk',
          { ignoreDefense: action.ignoreDefense === true });
        
        // 如果是普攻或指定連擊，後續打擊傷害遞減 (預設改為 40% 懲罰，避免敏捷過強)
        if ((isNormalAttack || action.combo) && i > 0) {
          const decay = action.damageDecay !== undefined ? action.damageDecay : 0.4;
          damage = Math.max(1, Math.floor(damage * Math.pow(1 - decay, i)));
        }

        if (isCrit) {
          damage = Math.floor(damage * Formulas.getCriticalMultiplier(caster));
        }

        if (action.damageMultiplier !== undefined) damage = Math.floor(damage * action.damageMultiplier);
        if (options.castDamageMultiplier !== undefined && options.castDamageMultiplier !== 1) {
          damage = Math.floor(damage * options.castDamageMultiplier);
        }
        const outcome = target.takeDamage(damage, logger, {
          caster, skill: this, action, hitIndex, hits, isCrit, isNormalAttack, tags,
          isCounter: !!context?.counterSource, deferReactions: true
        });
        // 被護盾吃掉的也算打中（1.0.38）：攻擊確實落在對方身上，只是血沒少。
        if ((outcome.actualDamage > 0 || outcome.shieldAbsorbed > 0) && !outcome.isCounter && caster.team !== target.team) {
          const summary = options.receivedAttacks.get(target) || { ...outcome, actualDamage: 0, shieldAbsorbed: 0 };
          summary.actualDamage += outcome.actualDamage;
          summary.shieldAbsorbed += outcome.shieldAbsorbed || 0;
          options.receivedAttacks.set(target, summary);
        }
        damage = outcome.damage;
        if (damage > 0) damagedTargets.add(target);
        if (record) {
          record.landed++;
          if (outcome.blocked) record.blocked++;
          if (isCrit) record.crits++;
          record.damage += damage;
          record.actualDamage += outcome.actualDamage || 0;
          record.shieldAbsorbed += outcome.shieldAbsorbed || 0;
        }

        logger.addLog({
          type: outcome.blocked ? 'BLOCK' : 'DAMAGE',
          actorId: caster.id,
      skillId: this.id,
      skillTier: this.tier,
      isNormalAttack,
          targetId: target.id,
          value: damage,
          actualDamage: outcome.actualDamage,
          ...(outcome.partId ? { partId: outcome.partId, partName: outcome.partName,
            partDamage: outcome.partDamage || 0, partDurability: outcome.partDurability } : {}),
          isCrit,
          blocked: outcome.blocked,
          ...(outcome.shieldAbsorbed ? { shieldAbsorbed: outcome.shieldAbsorbed } : {}),
          message: composeMessage(
            action,
            makeContext(this, caster, { target, targets: [target], value: damage, isCrit, hitIndex,
              blocked: outcome.blocked, blockMethod: outcome.blockMethod,
              partId: outcome.partId, partName: outcome.partName, partDamage: outcome.partDamage }),
            { isComboHit, isHitLanded: true }
          )
        });
        target.finishDamage(outcome, logger, context);
        return true;
      };

      // 逐波（hitOrder: 'wave'，1.0.31）：多段的全體攻擊一段打完所有目標才換下一段，
      // 第 2 段起先印 text.wave 當過場。固定段數才有「一波」可言，普攻與速度連擊照舊逐目標打完。
      const isWaveDamage = action.type === 'DAMAGE' && action.hitOrder === 'wave' && !options.basicCounter
        && this !== caster.normalAttack && caster.inBasicAttackSlot !== true;
      if (isWaveDamage) {
        const hits = action.hits || 1;
        const tags = mergeTags(this.tags, normalizeTags(action.tags, `Skill "${this.id}" action`));
        const done = new Set();
        for (let i = 0; i < hits; i++) {
          if (!caster.isAlive || caster.isPanicked?.() || context?.result) break;
          const wave = currentTargets.filter(target => target.isAlive && !done.has(target));
          if (!wave.length) break;
          if (i > 0 && action.text?.wave !== undefined) {
            const message = resolvePart(action.text.wave,
              makeContext(this, caster, { targets: wave, target: wave[0], hitIndex: i + 1 }));
            if (message) logger.addLog({ type: 'SKILL_TEXT', actorId: caster.id, skillId: this.id,
              skillTier: this.tier, isNormalAttack: false, message });
          }
          for (const target of wave) {
            if (!strikeOnce(target, i, hits, false, tags, false)) done.add(target);
          }
        }
        continue;
      }

      currentTargets.forEach(target => {
        if (!target.isAlive || !caster.isAlive || caster.isPanicked?.() || context?.result) return;
        if (action.requiresDamage && !damagedTargets.has(target)) return;

        if (action.type === 'DAMAGE') {
          // inBasicAttackSlot 讓派發型普攻轉發出去的子技能也照樣逐擊收費：
          // 子技能的 this 不是 caster.normalAttack，只比對 this 會整套漏收。
          const isNormalAttack = options.basicCounter
            || this === caster.normalAttack || caster.inBasicAttackSlot === true;
          let hits = action.hits || 1;
          const tags = mergeTags(this.tags, normalizeTags(action.tags, `Skill "${this.id}" action`));
          
          if (!options.basicCounter && (isNormalAttack || action.combo)) {
            hits = Formulas.getCombos(caster, target);
          }

          for (let i = 0; i < hits; i++) {
            if (!strikeOnce(target, i, hits, isNormalAttack, tags, hits > 1 && i > 0)) break;
          }
        } 
        else if (action.type === 'HEAL') {
          // 回復量預設綁施放者的 atk，action.stat 可以改綁任何一項能力值
          // （例如綁 int，讓輔助型角色的養成方向跟輸出型分開）。
          // 拼錯字若靜默退回 atk 或回 0，會變成「這招好像沒什麼用」這種
          // 得盯著戰報算數字才發現的問題，所以直接擋掉。
          // action.stat 也可以是 { atk: 1, int: 1 } 這種權重表：回復量同時吃好幾項能力值，
          // 讓「打得動的補師」不必在輸出與回復之間二選一（最終值 = Σ 能力值 × 權重 × power）。
          const weights = typeof action.stat === 'object' && action.stat !== null
            ? action.stat : { [action.stat || 'atk']: 1 };
          let scale = 0;
          for (const [statKey, weight] of Object.entries(weights)) {
            if (typeof caster.stats[statKey] !== 'number') {
              throw new Error(`HEAL action of skill "${this.id}" references unknown caster stat "${statKey}".`);
            }
            if (!Number.isFinite(weight)) {
              throw new Error(`HEAL action of skill "${this.id}" has a non-numeric weight for stat "${statKey}".`);
            }
            scale += caster.stats[statKey] * weight;
          }
          // 讀的是原始 stats 而不是生效值，所以同一次施放中前面幾段的 buff
          // 放大不了這裡的回復量，兩段的先後順序沒有差別。
          const healAmount = target.heal(Math.floor(scale * (action.power || 1)), logger, { deferReactions: true });
          // 群體治療（1.0.44）：滿血或回不到血的目標不印「恢復了 0」。二十人的隊伍一次全體治療，
          // 光是滿血的人就能洗掉半面戰報。單體治療照印，否則看不出施放者這一動做了什麼。
          if (healAmount === 0 && currentTargets.length > 1) {
            target.checkPassives('ON_HP_CHANGE', logger, context);
            return;
          }
          logger.addLog({
            type: 'HEAL',
            actorId: caster.id,
          skillId: this.id,
          skillTier: this.tier,
          isNormalAttack: this === caster.normalAttack,
            targetId: target.id,
            value: healAmount,
            message: composeMessage(
              action,
              makeContext(this, caster, { target, targets: [target], value: healAmount })
            )
          });
          target.checkPassives('ON_HP_CHANGE', logger, context);
        }
        else if (action.type === 'CHANGE_SANITY') {
          target.changeSanity(action.amount, logger, { engine: context, caster, skill: this, source: 'SKILL',
            message: event => composeMessage(action, makeContext(this, caster,
              { ...event, target, targets: [target] })) });
        }
        else if (action.type === 'RESTORE_SP') {
          const value = target.restoreSp(action.amount || 0);
          logger.addLog({ type: 'SP_RECOVER', actorId: caster.id, targetId: target.id,
            skillId: this.id, skillTier: this.tier, isNormalAttack: this === caster.normalAttack,
            value, message: composeMessage(
              action,
              makeContext(this, caster, { target, targets: [target], value })
            ) });
          target.syncFatigue(logger);
        }
        else if (action.type === 'BUFF') {
          const buffs = action.buffs || [];
          buffs.forEach(buffConfig => {
            target.addBuff(buffConfig, context);
            logger.addLog({
              type: 'BUFF_APPLY',
              actorId: caster.id,
          skillId: this.id,
          skillTier: this.tier,
          isNormalAttack: this === caster.normalAttack,
              targetId: target.id,
              message: composeMessage(
                action,
                makeContext(this, caster, { target, targets: [target], buff: buffConfig })
              )
            });
          });
        }
      });
    }
  }
}

/**
 * 只拼出 DAMAGE 那行的開頭（lead），給 BattleEngine 組反擊訊息用。
 *
 * 反擊取代的是「原本該擊的傷害行」，所以 COUNTER 的開頭必須跟那行一字不差：
 * 單段技能的開頭是「A 使出了 技能名，」，濃縮成一行剛好；多段技能的開頭是
 * 「第 N 擊，」，技能名早就由前面那行獨立宣告過了。引擎自己造句的話，多段技能
 * 就會宣告一次、反擊再複述一次。
 */
Skill.composeLead = function (skill, action, caster, target, { hitIndex = 1, isComboHit = false } = {}) {
  // 整句覆寫的技能沒有可用的片段，退回敘述式開頭。
  if (action.message) return `${caster.name} 使出了 ${skill.name}，`;
  const text = { ...DefaultText[action.type], ...(action.text || {}) };
  const ctx = makeContext(skill, caster, { target, targets: [target], hitIndex });
  return resolvePart(isComboHit ? text.combo : text.action, ctx);
};

module.exports = Skill;
