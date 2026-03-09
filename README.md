# Essential X

（概要）

## アイデア

- ~~@アカウント名にリンク埋込~~
- ~~アカウントのアイコン取得~~
- raspberry piで毎日決まった時間に実行して結果をgmailに送る
    - おすすめはservice worker + chrome.alarms で日次実行を組む方法
    1. 拡張機能内スケジューラを追加する
        - manifest.json に background.service_worker と permissions: ["alarms"] を追加。
        - background.js で毎日指定時刻の次回実行時刻を計算して chrome.alarms.create。
    1. アラーム発火時に自動実行
