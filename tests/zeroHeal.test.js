const test = require('node:test');
const assert = require('node:assert/strict');
const { Entity, Skill } = require('../src');

const unit = (id, hp, maxHp = 1000) => {
  const e = new Entity({ id, name: id, team: 'A', stats: { hp: maxHp, maxHp, sp: 100, atk: 10, def: 10, sta: 100, agi: 10, spd: 10, tec: 10, int: 100, luk: 10 } });
  e.stats.hp = hp;
  return e;
};
const logger = () => ({ logs: [], addLog(entry) { this.logs.push(entry); } });

test('a group heal skips the zero lines for members already at full HP', () => {
  const caster = unit('caster', 1000);
  const hurt = unit('hurt', 500);
  const full = unit('full', 1000);
  const skill = new Skill({ id: 'group_heal', name: '群體治療', actions: [{ type: 'HEAL', targetType: 'ALLY_ALL', stat: 'int', power: 1 }] });
  const log = logger();
  skill.execute(caster, [caster, hurt, full], [], log);
  const heals = log.logs.filter(entry => entry.type === 'HEAL');
  assert.deepEqual(heals.map(entry => entry.targetId), ['hurt']);
  assert.equal(hurt.stats.hp, 600);
});

test('a single-target heal still reports zero so the cast stays visible', () => {
  const caster = unit('caster', 1000);
  const full = unit('full', 1000);
  const skill = new Skill({ id: 'single_heal', name: '單體治療', actions: [{ type: 'HEAL', targetType: 'SELF', stat: 'int', power: 1 }] });
  const log = logger();
  skill.execute(full, [full], [], log);
  assert.deepEqual(log.logs.filter(entry => entry.type === 'HEAL').map(entry => entry.value), [0]);
});
