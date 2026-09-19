# 疲勞與普攻體力

有體力資源（maxSp > 0）的單位預設啟用疲勞。SP ≤ 50% 時戰鬥能力乘 0.8；
SP ≤ 10% 時乘 0.6，兩階段不疊加。作用於 Buff 加成後的 atk、def、int、spd、
hit、eva、counter、luk、cri；criDmg 只縮減超出 1 的加成。HP/SP 上限不變。
lockedStats 仍最後歸零。設定 Entity 的 fatigueEnabled: false 可豁免能力懲罰及跳過行動。
maxSp 為 0 的無資源單位自動豁免疲勞與普攻費用。

疲勞同時扣技能施放率：疲勞 −10 個百分點、力竭 −15 個百分點（預設 35% → 25% / 20%）。
在所有 STAT Buff 之後、夾限到 [0, 1] 之前扣，所以能跟 Buff 的加減互相抵銷；
敵方光環的倍率仍在這之後才乘上去（見 SKILL_MODIFIERS.md）。fatigueEnabled: false 一併豁免。

Entity.normalAttackSpCost 預設 1，可設為非負數（0 表示免費）。普攻與一般反擊每擊
在命中／反擊判定前付款，落空也耗體。連擊逐擊支付、不預扣；不足即停止。
原有 action.spCost 仍為額外動作費用，普攻設定時應避免重複收費。

逐擊收費看的是「這個行動槽是不是普攻」，不是「執行中的物件是不是 normalAttack」。
派發型普攻（自身 actions 為空，execute 時轉發給別的 Skill）必須覆寫 Skill 的
`dealsBasicAttackDamage` 回 true，引擎才知道它會打出傷害、體力見底時該改為喘息
而不是空轉掉行動槽；轉發出去的子技能由 Entity.inBasicAttackSlot 接手收費，
子技能本身不必改。CAST_SKILL 產生的子技能不繼承這個身分，與
AFTER_ATTACK_RECEIVED 把子技能分開計算的切分一致。
主動技能及技能反擊維持既有 action.spCost；ignoreSp 只免該動作費用，不免普攻逐擊費用。

每個行動槽先結算 DOT/HOT，再判定暈眩，再於力竭時擲一次 20% 跳過行動。
疲勞失敗不耗 SP、不觸發 BEFORE_ACTION，Buff 仍扣時間。反擊不擲疲勞失敗。
準備普攻卻無法支付時改為喘息，消耗行動槽，回復 ceil(maxSp * 0.4)，至少 1 點。
比例需明顯高於力竭門檻，否則喘完仍在力竭區，會卡在喘息與力竭之間來回。
力竭仍可能擋下喘息。行動順序本回合不重排，降速下回合影響抽選；連擊數在出手時抽取。

遊戲端扣體應用 spendSp(amount, logger)，回體用 restoreSp(amount, logger)，
由 getEffectiveStats() 即時計算懲罰。syncFatigue(logger) 同步狀態戰報。
新日誌：FATIGUE（stage: TIRED/EXHAUSTED）、FATIGUE_SKIP、REST（value 為實際回體量）。
只在階段變嚴重時播報，直接進入力竭不補播疲勞；回復到較輕階段（含回到正常）
只更新狀態不出字，體力再掉回該階段會重新播報。兩句台詞都在描述惡化，
回復時播出來會變成「剛喘完就開始有點喘」。
消耗跨門檻當下生效，包含支付費用後的那一擊。
