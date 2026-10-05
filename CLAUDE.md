# Claude session 注意事項

## 與 HERMES 的控制頻道（只在需要時適用）
HERMES（VPS 上的代理）負責合併與部署；Claude 不合併、不部署，也不碰 `/vault`，只透過控制頻道 [chenweihanfool/hermes-control-channel PR #1](https://github.com/chenweihanfool/hermes-control-channel/pull/1) 留言請 HERMES 執行。多個 Claude session 會同時在那一串留言，所以**只要這個 session 要在 PR #1 發留言，或看到 HERMES 的回覆，就要遵守下面幾點**。這個 repo 本身不一定由 HERMES 部署；沒有要和 HERMES 溝通時，可以忽略本節。

完整規則見 [hermes-control-channel 的 CLAUDE.md](https://github.com/chenweihanfool/hermes-control-channel/blob/main/CLAUDE.md)。最少要做到：

1. **標頭帶代號**：留言第一行寫 `[CLAUDE:<session id 末 8 碼>]`，回覆時接 `re:<comment id>`。不要只寫 `[CLAUDE]`。
2. **誰發誰接**：發出請求後，立刻訂閱 PR #1 的動態（`subscribe_pr_activity`，owner `chenweihanfool`、repo `hermes-control-channel`、pullNumber `1`），保持訂閱直到 HERMES 交出最終回報。否則收不到 HERMES 的回覆。
3. **只處理自己的**：`re:` 指向的不是自己的留言就略過，不向使用者回報，也不代辦別的 session 的工作。
4. **授權要逐字引用使用者原話並寫死範圍**：PR 與 head sha、只重建的服務（`--no-deps`）、不在授權內的項目、失敗時停下並回滾。
