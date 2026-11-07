# m4 範囲取得と解放・保持期間・移行・#41・master への合流 — 台帳

- 計画: docs/superpowers/plans/2026-11-07-m4-range-release-migration.md（PR #98 で合流）
- 起点: vector-cache の f6189a0（m3 の完了）
- 事前点検: 第 1 回（Claude）直してから（S 4・M 15・L 18）→ cceee2c で反映。第 2 回（Claude・反映の範囲に絞る）直してから（S 1・M 5・L 5）→ b5ff39b で反映。m2 と同じ運用で合格とし、第 3 回は置かない
  - 第 1 回・第 2 回とも、Codex と Kimi が枠切れだったので Claude で行った（委任の順は Codex → Kimi → Claude）
- 委任の運用: Codex（cwd は ~/zcode/weiwudi-work・gpt-6-astra）→ Kimi（dsh・kimi-coding/k3・effort high。worktree では commit できない）→ Claude。並行は 2 まで
- 共通の規則: 判定のコマンドに rtk を使わない・手元で playwright install をしない・e2e は build の後・--ignore-workspace を付けない
