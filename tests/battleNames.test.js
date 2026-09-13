const test = require('node:test');
const assert = require('node:assert/strict');
const { Entity, BattleEngine } = require('../src');

const unit = (name, id, team = 'A') => new Entity({
  id, name, team, stats: { hp: 100, maxHp: 100, spd: 1 }, skills: []
});

test('duplicate characters and monsters are numbered across both teams, without changing IDs', () => {
  const a = [unit('桐人', 'p1'), unit('桐人', 'p2'), unit('亞絲娜', 'p3')];
  const b = [unit('史萊姆', 'm1', 'B'), unit('史萊姆', 'm2', 'B'), unit('桐人', 'm3', 'B')];
  new BattleEngine(a, b);
  assert.deepEqual(a.map(e => e.name), ['桐人', '桐人2', '亞絲娜']);
  assert.deepEqual(b.map(e => e.name), ['史萊姆', '史萊姆2', '桐人3']);
  assert.deepEqual([...a, ...b].map(e => e.id), ['p1', 'p2', 'p3', 'm1', 'm2', 'm3']);
});

test('names already ending in numbers are preserved and cannot collide with generated names', () => {
  const team = ['桐人', '桐人', '桐人2', '桐人', '桐人2'].map((name, i) => unit(name, i));
  new BattleEngine(team, []);
  assert.deepEqual(team.map(e => e.name), ['桐人', '桐人3', '桐人2', '桐人4', '桐人22']);
  assert.equal(new Set(team.map(e => e.name)).size, team.length);
});

test('reusing entities resets automatic suffixes and respects explicit name changes', () => {
  const a = unit('桐人', 'a');
  const b = unit('桐人', 'b');
  new BattleEngine([a, b], []);
  new BattleEngine([a, b], []);
  assert.deepEqual([a.name, b.name], ['桐人', '桐人2']);
  new BattleEngine([b], []);
  assert.equal(b.name, '桐人');
  b.name = '亞絲娜';
  new BattleEngine([a, b], []);
  assert.deepEqual([a.name, b.name], ['桐人', '亞絲娜']);
});

test('numbering supports more than nine duplicates and leaves unique names unchanged', () => {
  const team = Array.from({ length: 12 }, (_, i) => unit('史萊姆', i));
  new BattleEngine(team, [unit('Boss', 'boss', 'B')]);
  assert.equal(team[0].name, '史萊姆');
  assert.equal(team[11].name, '史萊姆12');
});

test('skill callbacks, death messages and final teams use the same numbered names', () => {
  const a = unit('桐人', 'a');
  const b = unit('桐人', 'b', 'B');
  a.stats.spd = 100;
  a.normalAttack = {
    execute(caster, allies, enemies, logger) {
      logger.addLog({ type: 'TEXT', actorId: caster.id, message: `${caster.name} 攻擊 ${enemies[0].name}` });
      enemies[0].stats.hp = 0;
      enemies[0].isAlive = false;
    }
  };
  const result = new BattleEngine([a], [b]).start();
  assert.equal(result.winner, 'TEAM_A');
  assert.ok(result.logs.some(l => l.message === '桐人 攻擊 桐人2'));
  assert.ok(result.logs.some(l => l.type === 'DEATH' && l.actorId === 'b' && l.message === '桐人2 倒下了！'));
  assert.equal(result.finalTeamB[0].name, '桐人2');
});
