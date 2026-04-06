# 本米麵包 Dashboard — CLAUDE.md

## 語言
所有回應與 commit message 一律繁體中文

## 專案說明
本米麵包（土城）營運報表系統
- Dashboard: https://holaadam-tw.github.io/benmi-dashboard/
- GAS Bot: deploymentId AKfycby2jXOcndmV6xsbhTSEGweLduhNY_6V4cgmIUxMaUfHbmuGni6hHpS93W-cLzofLoW8AQ
- Supabase: https://nssuisyvlrqnqfxupklb.supabase.co

## 允許操作
- 修改 index.html、gas/Code.gs
- clasp push + deploy
- git add + commit + push

## 禁止操作
- 不得修改 Supabase RLS（需人工確認）
- 不得 DROP TABLE 或刪除任何資料庫欄位
- 不得 git push --force
- 不得在 index.html 新增第二個同名函式（會覆蓋舊的）

## 重要限制
- loadInvoices 只能有一個，不能重複定義
- _invRows 一律用 window._invRows
- 每次部署後必須更新 deploy 版本號 @XX

## 完成後輸出
每次任務完成輸出：修改了什麼檔案、新增/刪除幾行、deploy 版本號
