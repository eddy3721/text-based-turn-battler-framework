// 範例是文件的一部分：每支都要跑得動，而且真的展示到它開頭註解列出的機制。
// 框架改動讓範例過時（例如某個機制不再出現在戰報裡）時，這裡會先紅。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const load = name => require(path.join('..', 'examples', name));
const has = (logs, predicate) => logs.some(predicate);
const said = (logs, text) => has(logs, log => typeof log.message === 'string' && log.message.includes(text));

test('quickstart finishes with a winner', () => {
  const result = load('quickstart.js');
  assert.ok(['TEAM_A', 'TEAM_B', 'DRAW'].includes(result.winner));
  assert.equal(result.logs[0].type, 'BATTLE_START');
  assert.equal(result.logs.at(-1).type, 'BATTLE_END');
});

test('boss-fight shows shield, enrage, inserted ultimate in waves and last stand', () => {
  const { logs } = load('boss-fight.js');
  assert.ok(has(logs, log => log.type === 'SHIELD_BREAK'), 'BATTLE_START shield breaks');
  assert.ok(said(logs, '怒吼'), 'HP_BELOW phase');
  assert.ok(said(logs, '第 3 陣隕石'), 'insertAction ultimate with hitOrder wave');
  const stand = logs.findIndex(log => log.message?.includes('撐住了最後一口氣'));
  assert.ok(stand > 0, 'LAST_STAND');
  assert.ok(['DAMAGE', 'BLOCK'].includes(logs[stand - 1].type), 'LAST_STAND line prints after the hit');
});

test('party-support shows taunt, guard, anthem, evasion style and anti-heal', () => {
  const { logs } = load('party-support.js');
  assert.ok(said(logs, '挑釁敵人'));
  assert.ok(said(logs, '舉盾擋在隊友身前'), 'BEFORE_SKILL_CAST');
  assert.ok(said(logs, '奏起戰歌'), 'AFTER_ACTION');
  assert.ok(said(logs, '用殘影躲開了'), 'ON_EVADE evadeMethod');
  assert.ok(said(logs, '鎖定了破綻'), 'AFTER_EVADE');
  assert.ok(said(logs, '腐朽'), 'healTaken debuff applied');
});

test('control shows silence, paralysis and confusion hitting its own side', () => {
  const { logs } = load('control.js');
  assert.ok(has(logs, log => log.type === 'SILENCED'));
  assert.ok(said(logs, '動彈不得'), 'STUN with chance');
  const enemyIds = new Set(['warlock', 'guard']);
  assert.ok(has(logs, log => log.type === 'DAMAGE' && enemyIds.has(log.actorId) && enemyIds.has(log.targetId)),
    'a confused unit hits its own side');
});

test('replay reproduces the battle and adds a highlight before BATTLE_END', () => {
  const { result, replayMatches } = load('replay.js');
  assert.equal(replayMatches, true);
  assert.ok(said(result.logs, '精彩重播'));
  assert.equal(result.logs.at(-1).type, 'BATTLE_END');
  assert.ok(said(result.logs, '舔舐傷口'), 'ROUND_START passive');
});

test('the older demos still run', () => {
  for (const name of ['basic.js', 'sanity.js']) {
    execFileSync(process.execPath, [path.join(__dirname, '..', 'examples', name)], { stdio: 'pipe' });
  }
});
