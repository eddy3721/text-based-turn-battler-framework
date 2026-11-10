const test = require('node:test');
const assert = require('node:assert/strict');
const { BattleEngine, Entity, Skill, Formulas } = require('../src');

function make(id, team, passives = []) {
  return new Entity({
    id, name: id, team,
    stats: { hp: 1000, atk: 100, def: 0, sta: 10, agi: 0, spd: 10, tec: 0, int: 10, luk: 0, sp: 100 },
    normalAttack: new Skill({ id: `${id}_attack`, name: 'attack', actions: [{ type: 'DAMAGE' }] }),
    passives
  });
}

function deterministic(t) {
  t.mock.method(Formulas, 'isHit', () => true);
  t.mock.method(Formulas, 'isCritical', () => false);
  t.mock.method(Formulas, 'isCounter', () => false);
}

const slash = new Skill({ id: 'slash', name: '斬擊', actions: [{ type: 'DAMAGE' }] });
const scripted = new Skill({ id: 'scripted', name: '整句', actions: [{ type: 'DAMAGE', message: () => '攻擊方的整句' }] });
const twice = new Skill({ id: 'twice', name: '二連', actions: [{ type: 'DAMAGE', hits: 2 }] });

function fight(passive, skill = slash) {
  const a = make('a', 'A');
  const b = make('b', 'B', passive ? [passive] : []);
  const engine = new BattleEngine([a], [b], { luckEvents: { enabled: false } });
  skill.execute(a, [a], [b], engine.logger, engine);
  return engine.logger.logs.filter(log => log.skillId === skill.id && ['DAMAGE', 'BLOCK'].includes(log.type));
}

test('without blockMessage the block sentence is unchanged', t => {
  deterministic(t);
  const [log] = fight({ trigger: 'BEFORE_DAMAGE', action: (self, hit) => { hit.damage = 0; hit.blocked = true; hit.blockMethod = '盾'; } });
  assert.equal(log.message, 'a 攻擊，但是被 b 用盾擋下了！');
});

test('a string blockMessage replaces the whole block line', t => {
  deterministic(t);
  const [log] = fight({ trigger: 'BEFORE_DAMAGE', action: (self, hit) => {
    hit.damage = 0; hit.blocked = true; hit.blockMessage = 'c 衝到 b 面前，用身體擋下了這一擊！';
  } });
  assert.equal(log.type, 'BLOCK');
  assert.equal(log.message, 'c 衝到 b 面前，用身體擋下了這一擊！');
});

test('a function blockMessage receives the attacker\'s lead and the final value', t => {
  deterministic(t);
  const [log] = fight({ trigger: 'BEFORE_DAMAGE', action: (self, hit) => {
    hit.damage = 30; hit.blocked = true;
    hit.blockMessage = ctx => `${ctx.lead}c 替 ${ctx.target.name} 挨了下來，只漏了 ${ctx.value} 點！`;
  } });
  assert.equal(log.message, 'a 攻擊，c 替 b 挨了下來，只漏了 30 點！');
  assert.equal(log.value, 30);
});

test('blockMessage set in LAST_STAND outranks the attacker\'s action.message', t => {
  deterministic(t);
  const a = make('a', 'A');
  const b = make('b', 'B', [{ trigger: 'LAST_STAND', action: (self, hit) => {
    hit.damage = 0; hit.blocked = true; hit.blockMessage = ctx => `${ctx.lead}c 擋下了。`;
  } }]);
  b.stats.hp = 1;
  const engine = new BattleEngine([a], [b], { luckEvents: { enabled: false } });
  scripted.execute(a, [a], [b], engine.logger, engine);
  const log = engine.logger.logs.find(entry => entry.skillId === 'scripted' && entry.type === 'BLOCK');
  assert.equal(log.message, 'a 使出了 整句，c 擋下了。', 'a whole-sentence attacker falls back to the narrative lead');
  assert.ok(b.isAlive);
});

test('the lead follows combo hits, and an unblocked hit ignores blockMessage', t => {
  deterministic(t);
  let calls = 0;
  const logs = fight({ trigger: 'BEFORE_DAMAGE', action: (self, hit) => {
    calls++;
    hit.blockMessage = ctx => `${ctx.lead}擋。`;
    if (calls === 2) { hit.damage = 0; hit.blocked = true; }
  } }, twice);
  assert.match(logs[0].message, /^a 攻擊，對 b 造成了 \d+ 點傷害！$/);
  assert.equal(logs[1].message, '第 2 擊，擋。');
});

test('a blockMessage of the wrong type throws', t => {
  deterministic(t);
  assert.throws(() => fight({ trigger: 'BEFORE_DAMAGE', action: (self, hit) => {
    hit.damage = 0; hit.blocked = true; hit.blockMessage = 42;
  } }), /blockMessage/);
});
