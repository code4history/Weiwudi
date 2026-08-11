# Weiwudi openspec 時代の開発履歴索引

> 本ファイルは openspec ワークフロー（〜2026年）時代に作成された開発提案・記録を、那由多開発サイクル形式の履歴として集約した索引です。
> 原文は `docs/history/openspec-legacy/<change-id>/` 配下にそのまま保存されています（内容は変更していません）。
> 那由多開発サイクルについては `docs/superpowers/`（存在する場合）を参照してください。
>
> 「推定時期」は、各 change の `proposal.md` に対して `git log --follow --diff-filter=A -1` を実行して得た**作成日**（そのファイルが最初にリポジトリへ追加されたコミットの日付）を記載しています。archive 化の際にディレクトリ名へ日付プレフィックスが付与される・リネームされるケースがあるため、ディレクトリ単位ではなくファイル単位で `--follow` を適用し、archive 日ではなく作成日を実測しています。

## 開発提案一覧（openspec/changes、archive済み + 未archive、計6件）

| change-id | 由来 | 推定時期 | 目的 | 実装状況 | 現在の扱い | 原文 |
|---|---|---|---|---|---|---|
| 2025-12-18-unify-libs-turf-vite | archive済み | 2025-12-18（1308232） | Issue #25「Lintインフラの欠如」対応。ESLint 9（Flat Config）による標準的なLint設定を導入する。 | 完了 | 完了・削除対象 | [原文](openspec-legacy/2025-12-18-unify-libs-turf-vite/) |
| 2025-12-18-weiwudi-vite-pnpm | archive済み | 2025-12-17（930db51） | Issue #23/#24対応。旧式のWebpack 4ビルドをViteへ移行し、pnpmによる効率的な依存管理へ刷新する。 | 完了 | 完了・削除対象 | [原文](openspec-legacy/2025-12-18-weiwudi-vite-pnpm/) |
| 2025-12-24-cicd-ready | archive済み | 2025-12-24（ce3bd03） | 自動テスト・デプロイ基盤が存在せず手動デプロイやレビューなしマージのリスクがあった状態を解消し、push毎のテスト・Lint・型チェック検証とGitHub Pages自動デプロイを整備する。 | 完了 | 完了・削除対象 | [原文](openspec-legacy/2025-12-24-cicd-ready/) |
| 2025-12-24-strict-typing | archive済み | 2025-12-24（5f8a0b1） | ビルド移行を早期に進めるため暫定導入した `// @ts-nocheck` を除去し、TypeScriptの型安全性を全面的に確保する。 | 完了 | 完了・削除対象 | [原文](openspec-legacy/2025-12-24-strict-typing/) |
| 2025-12-24-test-demo-creation | archive済み | 2025-12-24（990dd90） | タイルキャッシュService WorkerライブラリであるWeiwudiに自動テストとデモサイトが存在しなかった状態を解消し、コア機能の検証と利用者向けの可視化を整備する。 | 完了 | 完了・削除対象 | [原文](openspec-legacy/2025-12-24-test-demo-creation/) |
| 2025-12-24-typescriptize | archive済み | 2025-12-24（bd80157） | `weiwudi_gw_logic.js` 等の複雑なロジックを段階的にTypeScript化するため、まずビルドシステムをTS対応させ機能を壊さずに移行する。 | 完了 | 完了・削除対象 | [原文](openspec-legacy/2025-12-24-typescriptize/) |

## 当時のプロジェクト概要（参考・陳腐化済み）

| 項目 | 推定時期 | 目的 | 現状との乖離 | 原文 |
|---|---|---|---|---|
| project.md | 2025-12-17（930db51） | openspecワークフロー導入時点でのWeiwudiプロジェクト概要・規約を記述したもの。 | 那由多開発サイクル移行（本索引作成）により、開発プロセス・ドキュメント体系は本ファイル群へ置き換わっている。参考情報として保存。 | [原文](openspec-legacy/_project-snapshot/project.md) |
| specs/linting/spec.md | 2025-12-18（1308232） | Lint設定に関する仕様（unify-libs-turf-vite由来）。 | 完了済み変更の仕様記録として保存。 | [原文](openspec-legacy/_project-snapshot/specs/linting/spec.md) |
| specs/demo-site/spec.md | 2025-12-24（990dd90） | デモサイトに関する仕様（test-demo-creation由来）。 | 完了済み変更の仕様記録として保存。 | [原文](openspec-legacy/_project-snapshot/specs/demo-site/spec.md) |
| specs/typescript-support/spec.md | 2025-12-24（bd80157） | TypeScript対応に関する仕様（typescriptize由来）。 | 完了済み変更の仕様記録として保存。 | [原文](openspec-legacy/_project-snapshot/specs/typescript-support/spec.md) |
| specs/e2e-testing/spec.md | 2025-12-24（990dd90） | E2Eテストに関する仕様（test-demo-creation由来）。 | 完了済み変更の仕様記録として保存。 | [原文](openspec-legacy/_project-snapshot/specs/e2e-testing/spec.md) |
| specs/package-management/spec.md | 2025-12-17（930db51） | pnpm移行に関する仕様（weiwudi-vite-pnpm由来）。 | 完了済み変更の仕様記録として保存。 | [原文](openspec-legacy/_project-snapshot/specs/package-management/spec.md) |
| specs/ci-pipeline/spec.md | 2025-12-24（ce3bd03） | CI/CDパイプラインに関する仕様（cicd-ready由来）。 | 完了済み変更の仕様記録として保存。 | [原文](openspec-legacy/_project-snapshot/specs/ci-pipeline/spec.md) |
| specs/build-system/spec.md | 2025-12-17（930db51） | ビルドシステムに関する仕様（weiwudi-vite-pnpm由来）。 | 完了済み変更の仕様記録として保存。 | [原文](openspec-legacy/_project-snapshot/specs/build-system/spec.md) |
| specs/demo-deployment/spec.md | 2025-12-24（ce3bd03） | GitHub Pagesデモデプロイに関する仕様（cicd-ready由来）。 | 完了済み変更の仕様記録として保存。 | [原文](openspec-legacy/_project-snapshot/specs/demo-deployment/spec.md) |
