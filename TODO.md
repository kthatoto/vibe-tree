# TODO

## URL設計

- [ ] セッション選択をRESTfulなパスで表現する
  - 現状: `/projects/:pinId`
  - 目標: `/projects/:pinId/sessions/:sessionId`
  - 画面遷移なしでURLが更新され、リロード時に状態が復元される
