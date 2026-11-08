const test = require('node:test');
const assert = require('node:assert/strict');
const { BattleEngine, Entity, Skill } = require('../src');
const { createSeededRandom } = require('../src/utils/Random');

function make(id, team, { passives = [], stats = {} } = {}) {
  return new Entity({
    id, name: id, team,
    stats: { hp: 1000, atk: 10, def: 5, sta: 10, agi: 10, spd: 10, tec: 10, int: 10, luk: 0, sp: 100, ...stats },
    normalAttack: new Skill({ id: `${id}_attack`, name: 'attack', dealsBasicAttackDamage: true, actions: [{ type: 'DAMAGE' }] }),
    passives
  });
}

class Marker extends Skill {
  constructor(id, seen) { super({ id, name: id, actions: [] }); this.seen = seen; }
  execute(caster) { this.seen.push(`${caster.id}:${this.id}`); }
}

const options = { luckEvents: { enabled: false }, maxTurns: 1 };

test('ALLY_SKILL_SELECT on a teammate replaces the chosen skill; the caster\'s own passive is not asked', () => {
  const seen = [];
  const wake = new Marker('wake', seen);
  const own = new Marker('own', seen);
  const helper = make('helper', 'A', { stats: { spd: 100 },
    passives: [{ trigger: 'ALLY_SKILL_SELECT', selectSkill: () => own }] });
  const downed = make('downed', 'A', { stats: { spd: 1 },
    passives: [{ trigger: 'ALLY_SKILL_SELECT', whileDead: true,
      enabled: (self, ctx) => ctx.caster === helper, selectSkill: (self, ctx, engine) => {
        assert.ok(engine instanceof BattleEngine);
        assert.equal(ctx.skill, helper.normalAttack);
        return wake;
      } }] });
  downed.stats.hp = 0;
  downed.isAlive = false;
  const foe = make('foe', 'B', { stats: { spd: 1 } });
  foe.actionDisabled = true;
  const engine = new BattleEngine([helper, downed], [foe], options);
  engine.executeTurn();
  assert.deepEqual([...new Set(seen)], ['helper:wake'], '每一動都換成打醒');
});

test('a dead teammate is only asked when the passive is whileDead', () => {
  const seen = [];
  const helper = make('helper', 'A', { stats: { spd: 100 } });
  const downed = make('downed', 'A', {
    passives: [{ trigger: 'ALLY_SKILL_SELECT', selectSkill: () => new Marker('wake', seen) }] });
  downed.stats.hp = 0;
  downed.isAlive = false;
  const foe = make('foe', 'B', { stats: { spd: 1 } });
  const engine = new BattleEngine([helper, downed], [foe], options);
  engine.executeTurn();
  assert.deepEqual(seen, []);
  assert.ok(engine.logger.logs.some(log => log.type === 'DAMAGE' && log.actorId === 'helper'), '照原本的普攻');
});

test('the encounter skillSelectionResolver wins over ALLY_SKILL_SELECT', () => {
  const seen = [];
  const helper = make('helper', 'A', { stats: { spd: 100 } });
  const ally = make('ally', 'A', { stats: { spd: 1 },
    passives: [{ trigger: 'ALLY_SKILL_SELECT', selectSkill: () => new Marker('ally', seen) }] });
  ally.actionDisabled = true;
  const foe = make('foe', 'B', { stats: { spd: 1 } });
  foe.actionDisabled = true;
  const floor = new Marker('floor', seen);
  const engine = new BattleEngine([helper, ally], [foe], {
    ...options, skillSelectionResolver: ({ caster }) => caster === helper ? floor : undefined });
  engine.executeTurn();
  assert.deepEqual([...new Set(seen)], ['helper:floor']);
});

test('selectSkill must return a skill or undefined', () => {
  const helper = make('helper', 'A', { stats: { spd: 100 } });
  const ally = make('ally', 'A', { passives: [{ trigger: 'ALLY_SKILL_SELECT', selectSkill: () => null }] });
  const foe = make('foe', 'B', { stats: { spd: 1 } });
  const engine = new BattleEngine([helper, ally], [foe], options);
  assert.throws(() => engine.executeTurn(), /ALLY_SKILL_SELECT/);
});

test('battles without ALLY_SKILL_SELECT keep the same log', () => {
  const run = extra => {
    const a = make('a', 'A', { stats: { spd: 30 }, passives: extra });
    const b = make('b', 'A');
    const foe = make('foe', 'B', { stats: { spd: 20 } });
    const engine = new BattleEngine([a, b], [foe], { luckEvents: { enabled: false }, maxTurns: 5, rng: createSeededRandom(7) });
    engine.start();
    return engine.logger.logs.map(log => log.message).join('\n');
  };
  assert.equal(run([{ trigger: 'ALLY_SKILL_SELECT', selectSkill: () => undefined }]), run([]));
});
