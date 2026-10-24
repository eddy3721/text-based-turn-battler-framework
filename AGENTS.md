# 修改這個框架時的規則

給要改框架本身的人與 AI。只是**使用**框架的話，請看 [llms.txt](llms.txt) 與 [docs/REFERENCE.md](docs/REFERENCE.md)。

## 指令

```bash
npm test                      # 全部測試，含 tests/examples.test.js 的範例檢查
node --test tests/xxx.test.js # 單一檔案
node examples/boss-fight.js   # 看某個範例的戰報
```

## 不能破壞的事

1. **亂數序列不變。** 既有的戰鬥在同一串亂數下要跑出一字不差的戰報；下游遊戲的平衡測試靠這個。
   - 新機制一律可選（opt-in），沒用到時不能多擲或少擲一次骰。
   - 擲骰一律呼叫 `src/utils/Random.js` 的 `random()`，不要直接用 `Math.random()`。
   - 改了擲骰路徑，就用同一串亂數比對改動前後的示範戰鬥戰報。
2. **戰報文字不變。** 下游會比對戰報字串，預設句連空格都不能改。新的文案用新的片段或選項提供。
3. **零依賴。** `dependencies` 保持空的，測試只用 `node:test`。

## 加一個機制的流程

1. 程式寫在 `src/`，註解說明「為什麼」，延續既有中文註解的寫法。
2. 在 `tests/` 加測試，涵蓋預設行為不變與新行為。
3. 更新文件：
   - 主題文件放在 `docs/`，可以新開一份，也可以補進既有的。
   - `docs/REFERENCE.md` 的對應表格要補上新欄位或觸發器。
   - 機制值得示範的話，補進 `examples/` 的範例，並在 `tests/examples.test.js` 檢查它有出現。
4. `package.json` 的版本號 +1，在 `CHANGELOG.md` 最上面寫一條。**已經發出去的版本號不能重用。**
5. commit 後打 tag：`git tag -a v1.0.N -m v1.0.N`，然後 push main 和 tag。

## 程式慣例

- CommonJS，`require` / `module.exports`。
- 設定錯誤要在建構時直接拋錯，不要默默退回預設值。
- 被動的 `action` 一律收 `(self, ctx, logger, engine)`。只有既有的幾個例外（`BEFORE_DAMAGE`、`LAST_STAND`、`ON_EVADE`、`HP_BELOW`）維持原簽名。
- 文件寫繁體中文。
