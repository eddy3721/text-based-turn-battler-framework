// 框架裡所有擲骰都經過 random()。
//
// 預設每次都去呼叫「當下的」Math.random，而不是在載入時把它存起來：
// 測試裡替換 Math.random 的寫法照常有效，沒有指定 rng 的戰鬥亂數序列也和舊版完全相同。
//
// BattleEngine 的 rng 選項只在 start() 執行期間換掉來源，跑完（含拋錯）就換回來。
// 戰鬥是同步一次跑完的，所以不會有兩場戰鬥同時共用來源的問題。
// 沒有指定 rng 的引擎沿用當下的來源：在某場戰鬥的鉤子裡再開一場，會跟著外層的種子走。
const defaultSource = () => Math.random();
let source = defaultSource;

function random() {
  return source();
}

function withRandom(rng, run) {
  if (rng == null) return run();
  if (typeof rng !== 'function') throw new Error('rng must be a function returning a number in [0, 1)');
  const previous = source;
  source = rng;
  try {
    return run();
  } finally {
    source = previous;
  }
}

// 可重現的亂數（mulberry32）：同一個整數種子永遠產生同一串數字。
// 給重播、平衡模擬與回歸測試用，不適合任何需要安全性的場合。
function createSeededRandom(seed) {
  if (!Number.isSafeInteger(seed)) throw new Error('seed must be a safe integer');
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = { random, withRandom, createSeededRandom };
