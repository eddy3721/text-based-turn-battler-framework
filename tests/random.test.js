const test = require('node:test');
const assert = require('node:assert/strict');
const { BattleEngine, Entity, Skill, createSeededRandom, random } = require('../src');

function make(id, team, stats = {}) {
  return new Entity({
    id, name: id, team,
    stats: { hp: 400, atk: 40, def: 5, sta: 10, agi: 10, spd: 20, tec: 10, int: 10, luk: 10, sp: 100, cri: 0.2, counter: 10, ...stats },
    normalAttack: new Skill({ id: `${id}_attack`, name: '攻擊', actions: [{ type: 'DAMAGE' }] }),
    skills: [
      new Skill({ id: `${id}_sweep`, name: '橫掃', spCost: 5, actions: [{ type: 'DAMAGE', targetType: 'ENEMY_ALL', power: 0.8 }] }),
      new Skill({ id: `${id}_poison`, name: '毒霧', spCost: 5, actions: [{ type: 'BUFF', targetType: 'ENEMY_SINGLE',
        buff: { id: 'poison', name: '中毒', type: 'DOT', duration: 3, value: 15, chance: 0.5 } }] })
    ]
  });
}

// 每次都重新建單位：Entity 會在戰鬥中被改寫，不能跨場共用。
function battle(options) {
  const engine = new BattleEngine(
    [make('劍士', 'A'), make('法師', 'A', { spd: 35 })],
    [make('哥布林', 'B'), make('哥布林', 'B', { atk: 30 })],
    { maxTurns: 30, ...options });
  return engine.start();
}

const transcript = result => result.logs.map(log => log.message).join('\n');

test('the same seed replays the same battle', () => {
  const first = battle({ rng: createSeededRandom(42) });
  const second = battle({ rng: createSeededRandom(42) });
  assert.equal(transcript(first), transcript(second));
  assert.equal(first.winner, second.winner);
  assert.notEqual(transcript(battle({ rng: createSeededRandom(7) })), transcript(first), 'another seed is another battle');
});

test('a seeded battle never touches Math.random', () => {
  const original = Math.random;
  Math.random = () => { throw new Error('Math.random was called'); };
  try {
    battle({ rng: createSeededRandom(1) });
  } finally {
    Math.random = original;
  }
});

test('without rng the engine draws the same sequence as Math.random', () => {
  const original = Math.random;
  try {
    Math.random = createSeededRandom(99);
    const viaMath = transcript(battle());
    Math.random = () => { throw new Error('Math.random was called'); };
    const viaOption = transcript(battle({ rng: createSeededRandom(99) }));
    assert.equal(viaOption, viaMath);
  } finally {
    Math.random = original;
  }
});

test('the source is restored after start(), even when the battle throws', () => {
  const seeded = createSeededRandom(5);
  const boom = new BattleEngine([make('a', 'A')], [make('b', 'B')], {
    rng: seeded, maxTurns: 1, roundStart: () => { throw new Error('boom'); }
  });
  assert.throws(() => boom.start(), /boom/);

  const original = Math.random;
  let calls = 0;
  Math.random = () => { calls++; return 0.5; };
  try {
    random();
  } finally {
    Math.random = original;
  }
  assert.equal(calls, 1, 'random() is back on Math.random');
});

test('game hooks can draw from the battle seed through random()', () => {
  const rolls = seed => {
    const seen = [];
    battle({ rng: createSeededRandom(seed), roundStart: () => seen.push(random()) });
    return seen;
  };
  assert.deepEqual(rolls(3), rolls(3));
});

test('rng must be a function and seeds must be safe integers', () => {
  assert.throws(() => new BattleEngine([make('a', 'A')], [make('b', 'B')], { rng: 42 }), /rng must be a function/);
  assert.throws(() => createSeededRandom(1.5), /seed/);
  const rng = createSeededRandom(0);
  for (let i = 0; i < 1000; i++) {
    const value = rng();
    assert.ok(value >= 0 && value < 1);
  }
});
