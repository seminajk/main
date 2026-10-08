# 영어 회화 30분 (계정 없이 쓰는 버전)

- 앱: `english/index.html` — GitHub Pages 로 열면 로그인 없이 쓸 수 있다. 진행 중인 레슨과 복습 카드는 브라우저에 저장된다.
- 결과 전송: 레슨을 끝내면 결과가 ntfy 토픽(`config.json`)으로 간다. 아직 반영되지 않은 결과는 앱을 열 때 10시간 간격으로 다시 보낸다.
- 매일 밤 11시(KST) 자동화: `NIGHTLY.md` 절차대로 결과를 채점하고(`tools/nightly.mjs`), 레벨·코치 메모를 갱신하고, 다음 레슨을 2개까지 채워 `data/` 에 커밋한다.
- 데이터: `data/profile.json`(레벨·기록·리포트), `data/index.json`(레슨 목록), `data/lessons/`, `data/results/`.

저장소가 공개라서 `data/` 의 학습 기록과 ntfy 토픽 이름은 누구나 볼 수 있다.
