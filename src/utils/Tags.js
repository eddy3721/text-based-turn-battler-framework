/**
 * 標籤（tags）：技能、單一 action 與 Buff 上的自由字串，框架只負責驗證與傳遞，不解讀。
 *
 * 「火會燒營」「水會被泥偶吸收」這類規則屬於遊戲，框架不內建屬性表、也不做相剋。
 * 傷害結算時，攻擊的標籤＝技能標籤 ∪ 該段 action 標籤；DOT 的標籤＝該 Buff 的標籤。
 * 合併後放在 hit.tags，所有傷害側的觸發器（BEFORE_DAMAGE、AFTER_DAMAGE_RECEIVED……）
 * 都讀得到。沒有標籤時是空陣列，不是 undefined，讀取端不必判空。
 */
const EMPTY = Object.freeze([]);

function normalizeTags(tags, label) {
  if (tags === undefined) return EMPTY;
  // 打錯型別若安靜地變成「沒有標籤」，只會看到「這招怎麼沒觸發」，跟機率沒中長得一樣。
  if (!Array.isArray(tags) || tags.some(tag => typeof tag !== 'string' || !tag)) {
    throw new Error(`${label} tags must be an array of non-empty strings.`);
  }
  return tags.length ? Object.freeze([...new Set(tags)]) : EMPTY;
}

function mergeTags(...lists) {
  const present = lists.filter(list => list?.length);
  if (!present.length) return EMPTY;
  if (present.length === 1) return present[0];
  return Object.freeze([...new Set(present.flat())]);
}

module.exports = { EMPTY_TAGS: EMPTY, normalizeTags, mergeTags };
