// Rules are stateless and may be shared; each Entity owns a separate Sanity instance.
function createSanityRules(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error('Sanity rule overrides must be an object');
  }
  const rules = {
    castRateModifier: ({ value, min, max, neutral }) =>
      0.1 * (value - neutral) / (value < neutral ? neutral - min : max - neutral),
    recoveryAmount: ({ min, max }) => (max - min) * 0.05,
    getState: ({ value, neutral }) => value < neutral ? 'SHAKEN' : value > neutral ? 'INSPIRED' : 'NEUTRAL',
    panicEnabled: true,
    ...overrides
  };
  for (const key of ['castRateModifier', 'recoveryAmount', 'getState']) {
    if (typeof rules[key] !== 'function') throw new Error(`Sanity ${key} must be a function`);
  }
  if (typeof rules.panicEnabled !== 'boolean') throw new Error('Sanity panicEnabled must be boolean');
  return Object.freeze(rules);
}

class Sanity {
  constructor(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('sanity must be false or a configuration object');
    const { min = -50, max = 50, neutral = 0, initial = neutral, rules } = config;
    if (![min, max, neutral, initial].every(Number.isFinite) ||
        !(min < neutral && neutral < max) || !Number.isFinite(max - min) || initial < min || initial > max) {
      throw new Error('Sanity requires finite min < neutral < max and initial within bounds');
    }
    if (rules !== undefined && rules !== false && (!rules || typeof rules !== 'object' || Array.isArray(rules))) {
      throw new Error('Sanity rules must be false or a rules object');
    }
    Object.assign(this, { min, max, neutral, value: initial, round: 0, panicUntil: null });
    this.rules = createSanityRules(rules === false
      ? { castRateModifier: () => 0, recoveryAmount: () => 0, panicEnabled: false } : rules);
    if (initial === min && this.rules.panicEnabled) this.panicUntil = 1;
    this.state = this.getState();
    this.initialPanicPending = this.isPanicked();
    this.lastSettledRound = -1;
    this.events = [];
    this.dispatching = false;
  }

  isPanicked() { return this.panicUntil !== null; }

  getState() {
    if (this.isPanicked()) return 'PANIC';
    const state = this.rules.getState(this);
    if (typeof state !== 'string' || !state || state === 'PANIC') throw new Error('Sanity getState must return a nonempty state other than PANIC');
    return state;
  }

  castRateModifier(entity) {
    const modifier = this.rules.castRateModifier(this, entity);
    if (!Number.isFinite(modifier)) throw new Error('Sanity castRateModifier must return a finite number');
    return modifier;
  }

  // Initialization is announced once, after BATTLE_START (or before a direct turn).
  announce(entity, logger, engine, round = 0) {
    this.round = round;
    if (!this.initialPanicPending || !entity.isAlive) return;
    this.initialPanicPending = false;
    this.panicUntil = round + 1;
    this.publish(entity, this.value, null, logger, { engine, source: 'INITIAL' });
  }

  change(entity, delta, logger, context = {}) {
    if (!Number.isFinite(delta)) throw new Error('Sanity delta must be finite');
    if (!entity.isAlive) return 0;
    if (this.initialPanicPending) this.announce(entity, logger, context.engine);
    const before = this.value;
    const after = Math.max(this.min, Math.min(this.max, before + delta));
    if (after === before) return 0;
    const previousState = this.state;
    this.value = after;
    if (after === this.min && this.rules.panicEnabled && !this.isPanicked()) {
      this.panicUntil = (context.engine?.currentTurn ?? this.round) + 1;
    }
    this.state = this.getState();
    this.publish(entity, before, previousState, logger, context);
    return after - before;
  }

  publish(entity, before, previousState, logger, context) {
    const event = Object.freeze({ before, after: this.value, value: this.value - before,
      previousState, state: this.state, source: context.source || 'DIRECT',
      actorId: context.caster?.id ?? entity.id, targetId: entity.id,
      skillId: context.skill?.id, skillTier: context.skill?.tier,
      isNormalAttack: context.skill ? context.skill === context.caster?.normalAttack : undefined,
      panicUntil: this.panicUntil });
    // Queue reactions so nested changes cannot interleave the two events of this change.
    this.events.push({ event, context, logger });
    if (this.dispatching) return;
    this.dispatching = true;
    let count = 0;
    try {
      while (this.events.length) {
        if (++count > 100) throw new Error('Sanity reaction cycle exceeded 100 changes');
        const { event: e, context: ctx, logger: out } = this.events.shift();
        if (e.value !== 0) out?.addLog({ ...e, type: 'SANITY_CHANGE',
          message: ctx.message ? ctx.message(e) : `${entity.name} 的理智 ${e.before} → ${e.after}。` });
        if (e.previousState !== e.state) {
          const type = e.state === 'PANIC' ? 'SANITY_PANIC'
            : e.previousState === 'PANIC' ? 'SANITY_RECOVER' : 'SANITY_STATE_CHANGE';
          const label = { SHAKEN: '動搖', INSPIRED: '振奮', NEUTRAL: '平穩' }[e.state] || e.state;
          out?.addLog({ ...e, type, message: e.state === 'PANIC' ? `${entity.name} 精神崩潰，暫時無法行動！`
            : e.previousState === 'PANIC' ? `${entity.name} 從崩潰中恢復。` : `${entity.name} 的精神狀態轉為${label}。` });
        }
        const reaction = { ...e, target: entity, caster: ctx.caster, skill: ctx.skill };
        for (const trigger of ['ON_SANITY_CHANGE', 'ON_SANITY_STATE_CHANGE']) {
          if (trigger === 'ON_SANITY_CHANGE' ? e.value === 0 : e.previousState === e.state) continue;
          for (const passive of [...entity.passives]) {
            if (!entity.isAlive || ctx.engine?.result) break;
            if (passive.trigger === trigger && (!passive.enabled || passive.enabled(entity, reaction))) {
              passive.action?.(entity, reaction, out, ctx.engine);
            }
          }
        }
      }
    } finally {
      this.dispatching = false;
      this.events.length = 0;
    }
  }

  endRound(entity, logger, engine) {
    if (!entity.isAlive || engine.result || this.lastSettledRound === engine.currentTurn) return;
    this.lastSettledRound = engine.currentTurn;
    if (this.isPanicked()) {
      if (engine.currentTurn < this.panicUntil) return;
      const before = this.value;
      const previousState = this.state;
      this.panicUntil = null;
      this.value = Math.max(this.neutral, this.value);
      this.state = this.getState();
      this.publish(entity, before, previousState, logger, { engine, source: 'PANIC_RECOVERY' });
      return;
    }
    const amount = this.rules.recoveryAmount(this, entity);
    if (!Number.isFinite(amount) || amount < 0) throw new Error('Sanity recoveryAmount must return a finite nonnegative number');
    const delta = Math.sign(this.neutral - this.value) * Math.min(amount, Math.abs(this.neutral - this.value));
    this.change(entity, delta, logger, { engine, source: 'ROUND_RECOVERY' });
  }
}

module.exports = { Sanity, createSanityRules };
