const test = require('node:test');
const assert = require('node:assert/strict');
const { BattleEngine, Entity, Skill } = require('../src');

function make(id, team, { skills = [], passives = [] } = {}) {
  return new Entity({
    id, name: id, team,
    stats: { hp: 100, atk: 10, def: 5, sta: 10, agi: 10, spd: 10, tec: 10, int: 10, luk: 0, sp: 100 },
    normalAttack: new Skill({ id: `${id}_attack`, name: 'attack', actions: [{ type: 'DAMAGE' }] }),
    skills, passives
  });
}

test('AFTER_SKILL_CAST observes a hostile skill once even when it causes no damage', () => {
  const seen = [];
  const observer = make('observer', 'A', { passives: [{
    trigger: 'AFTER_SKILL_CAST',
    action: (_self, cast) => seen.push([cast.caster.id, cast.skill.id])
  }] });
  const support = new Skill({ id: 'support', name: 'support', actions: [{
    type: 'BUFF', targetType: 'SELF', buffs: [{ id: 'focus', name: 'focus', type: 'STAT', duration: 2 }]
  }] });
  const caster = make('caster', 'B', { skills: [support] });
  const engine = new BattleEngine([observer], [caster], { luckEvents: { enabled: false } });

  support.execute(caster, [caster], [observer], engine.logger, engine);

  assert.deepEqual(seen, [['caster', 'support']]);
});

test('AFTER_SKILL_CAST is only broadcast to opponents', () => {
  let allyObservations = 0;
  const ally = make('ally', 'B', { passives: [{
    trigger: 'AFTER_SKILL_CAST', action: () => { allyObservations++; }
  }] });
  const observer = make('observer', 'A');
  const skill = new Skill({ id: 'spell', name: 'spell', actions: [{ type: 'DAMAGE', stat: 'int' }] });
  const caster = make('caster', 'B', { skills: [skill] });
  const engine = new BattleEngine([observer], [caster, ally], { luckEvents: { enabled: false } });

  skill.execute(caster, [caster, ally], [observer], engine.logger, engine);

  assert.equal(allyObservations, 0);
});
