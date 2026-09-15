const Formulas = require('../utils/Formulas');

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
 * 「對手是怎麼躲掉的」只有防守方知道。詳見 EVASION.md。
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
  // SUMMON 的 target 是剛生出來的增援實體。
  SUMMON: {
    action: (ctx) => `${ctx.caster.name} `,
    summon: (ctx) => `召來了 ${ctx.target.name}！`
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
  if (action.type === 'SUMMON') return part(text.action) + part(text.summon);
  if (action.type === 'BUFF') return part(text.action) + part(text.buff);
  if (action.type === 'TEXT') return part(text.action);

  const lead = part(isComboHit ? text.combo : text.action);
  if (!isHitLanded) return lead + part(text.miss);
  if (ctx.blocked) return lead + part(text.block);
  return lead + (ctx.isCrit ? part(text.crit) : '') + part(text.hit);
}

class Skill {
  constructor({ id, name, actions = [], tier = 'standard' }) {
    for (const action of actions) {
      if (action.partDamageMultiplier !== undefined &&
          (action.type !== 'DAMAGE' || !Number.isFinite(action.partDamageMultiplier) || action.partDamageMultiplier < 0)) {
        throw new Error('partDamageMultiplier requires a DAMAGE action and a finite nonnegative value');
      }
    }
    this.id = id;
    this.name = name;
    this.tier = tier; // standard / ultimate，提供戰報呈現使用
    this.actions = actions; // 多段動作陣列
  }

  // 判斷是否能發動此技能 (看總體力消耗)
  canCast(entity, context, { ignoreSp = false, callChain = [] } = {}) {
    const totalSpCost = this.actions.reduce((sum, action) => sum + (action.spCost || 0), 0);
    if (callChain.includes(this.id)) return false;
    return (ignoreSp || entity.stats.sp >= totalSpCost) && this.actions.every(action => {
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
    return composeMessage(action, makeContext(this, caster, { target: summoned, targets: [summoned] }));
  }

  // 選擇目標的輔助函式
  _selectTargets(targetType, caster, allies, enemies) {
    const aliveEnemies = enemies.filter(e => e.isAlive);
    const aliveAllies = allies.filter(e => e.isAlive);

    switch (targetType) {
      case 'ENEMY_SINGLE':
        if (aliveEnemies.length === 0) return [];
        return [aliveEnemies[Math.floor(Math.random() * aliveEnemies.length)]];
      case 'ENEMY_ALL':
        return aliveEnemies;
      case 'ALLY_SINGLE':
        if (aliveAllies.length === 0) return [];
        return [aliveAllies[Math.floor(Math.random() * aliveAllies.length)]];
      case 'ALLY_ALL':
        return aliveAllies;
      case 'SELF':
        return [caster];
      default:
        return [];
    }
  }

  // 執行技能
  execute(caster, allies, enemies, logger, context, options = {}) {
    const run = () => this._execute(caster, allies, enemies, logger, context, options);
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
      if (!caster.isAlive || context?.result) break;
      if (action.type === 'SUMMON' && !context?.canSummon(caster, action)) continue;
      // 1. 扣除該段 SP
      const cost = options.ignoreSp ? 0 : action.spCost || 0;
      if (caster.stats.sp < cost) {
        break; // 體力不足以執行後續段落，中斷
      }
      caster.stats.sp -= cost;
      if (action.type === 'CAST_SKILL') {
        if (!context) throw new Error(`CAST_SKILL in "${this.id}" requires a BattleEngine context.`);
        context.castSkill(caster, action.skillIds);
        continue;
      }
      if (action.type === 'SUMMON') {
        context.summon(caster, action, this);
        continue;
      }

      // 2. 決定目標 (是否延續上一段的目標)
      const inherit = action.inheritTarget !== false;
      if (action.type === 'DAMAGE' && forcedTargets) {
        currentTargets = forcedTargets.filter(target => target.isAlive);
        forcedTargets = null;
      } else if (!inherit || currentTargets.length === 0) {
        // 不延續，或是目前還沒有目標，就依照本段的 targetType 抓取
        currentTargets = this._selectTargets(action.targetType || 'ENEMY_SINGLE', caster, allies, enemies);
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

      currentTargets.forEach(target => {
        if (!target.isAlive || !caster.isAlive || context?.result) return;
        if (action.requiresDamage && !damagedTargets.has(target)) return;

        if (action.type === 'DAMAGE') {
          const isNormalAttack = options.basicCounter || (this === caster.normalAttack);
          let hits = action.hits || 1;
          
          if (!options.basicCounter && (isNormalAttack || action.combo)) {
            hits = Formulas.getCombos(caster, target);
          }

          for (let i = 0; i < hits; i++) {
            if (!target.isAlive || !caster.isAlive || context?.result) break;

            const hitIndex = i + 1;

            // A successful counter has already won its reaction check, so its reply cannot miss.
            if (!context?.counterSource && !Formulas.isHit(caster, target, action.accuracy || 1)) {
              // 落空先問防守方「你是怎麼躲的」，再組句；不答就維持原本的預設文案。
              const evasion = target.resolveEvasion({ caster, skill: this, action, hitIndex, hits, isNormalAttack });
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
                message: evasion.evadeMessage || composeMessage(
                  action,
                  makeContext(this, caster, { target, targets: [target], hitIndex, evadeMethod: evasion.evadeMethod }),
                  { isComboHit: hits > 1 && i > 0, isHitLanded: false }
                )
              });
              continue;
            }

            // 每一擊各自判定：多段技能挨的刀多，給對手的機會就該多。
            if (context?.tryCounter(caster, target, this,
              { action, hitIndex, isComboHit: hits > 1 && i > 0 })) continue;

            const isCrit = Formulas.isCritical(caster);
            // 傷害預設依賴 atk；action.stat 可讓法術等技能改用 int 或其他能力。
            // Formulas 會在欄位不存在時直接拋錯，避免拼錯後悄悄打成最低傷害。
            let damage = Formulas.calculateDamage(caster, target, action.power || 1, action.stat || 'atk');
            
            // 如果是普攻或指定連擊，後續打擊傷害遞減 (預設改為 40% 懲罰，避免敏捷過強)
            if ((isNormalAttack || action.combo) && i > 0) {
              const decay = action.damageDecay !== undefined ? action.damageDecay : 0.4;
              damage = Math.max(1, Math.floor(damage * Math.pow(1 - decay, i)));
            }

            if (isCrit) {
              damage = Math.floor(damage * Formulas.getCriticalMultiplier(caster));
            }

            const outcome = target.takeDamage(damage, logger, {
              caster, skill: this, action, hitIndex, hits, isCrit, isNormalAttack,
              isCounter: !!context?.counterSource, deferReactions: true
            });
            damage = outcome.damage;
            if (damage > 0) damagedTargets.add(target);

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
              message: composeMessage(
                action,
                makeContext(this, caster, { target, targets: [target], value: damage, isCrit, hitIndex,
                  blocked: outcome.blocked, blockMethod: outcome.blockMethod,
                  partId: outcome.partId, partName: outcome.partName, partDamage: outcome.partDamage }),
                { isComboHit: hits > 1 && i > 0, isHitLanded: true }
              )
            });
            target.finishDamage(outcome, logger, context);
          }
        } 
        else if (action.type === 'HEAL') {
          // 回復量預設綁施放者的 atk，action.stat 可以改綁任何一項能力值
          // （例如綁 int，讓輔助型角色的養成方向跟輸出型分開）。
          // 拼錯字若靜默退回 atk 或回 0，會變成「這招好像沒什麼用」這種
          // 得盯著戰報算數字才發現的問題，所以直接擋掉。
          const statKey = action.stat || 'atk';
          const scale = caster.stats[statKey];
          if (typeof scale !== 'number') {
            throw new Error(`HEAL action of skill "${this.id}" references unknown caster stat "${statKey}".`);
          }
          // 讀的是原始 stats 而不是生效值，所以同一次施放中前面幾段的 buff
          // 放大不了這裡的回復量，兩段的先後順序沒有差別。
          const healAmount = target.heal(Math.floor(scale * (action.power || 1)), logger, { deferReactions: true });
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
        else if (action.type === 'RESTORE_SP') {
          const value = target.restoreSp(action.amount || 0);
          logger.addLog({ type: 'SP_RECOVER', actorId: caster.id, targetId: target.id,
            skillId: this.id, skillTier: this.tier, isNormalAttack: this === caster.normalAttack,
            value, message: composeMessage(
              action,
              makeContext(this, caster, { target, targets: [target], value })
            ) });
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
