# Hearth (사내 채널)

내부 직원만 쓰는 팀 메신저입니다. 공개 가입, 과금, AI, MCP, 슬랙 가져오기는 넣지 않았습니다.

제품 이름은 **Hearth**입니다. 한국어 화면 문구는 「사내 채널」입니다.

## 1단계 범위

- 허용된 회사 메일만 입장 (로컬용 스텁 SSO, 세션 쿠키)
- 워크스페이스 하나
- 공개/비공개 채널, 멤버십, 스레드, 쪽지, 반응, 언급, 로컬 파일 첨부
- SSE로 새 메시지 수신
- 지금 멤버인 채널만 키워드 검색
- 기록 유지, 관리자 JSON/ZIP 내보내기
- 로그인·멤버십·내보내기 감사 로그
- ACL: 비멤버는 채널·검색·첨부에서 내용을 볼 수 없음

## 로컬 실행

Node 22 이상이 필요합니다 (`node:sqlite`).

```bash
cd internal-chat
cp .env.example .env
pnpm install
pnpm test
pnpm dev
```

브라우저에서 [http://127.0.0.1:3847](http://127.0.0.1:3847) 을 엽니다.

`.env` 기본 허용 메일:

| 메일 | 역할 |
| --- | --- |
| `ada@hearth.local` | 직원 |
| `beom@hearth.local` | 직원 |
| `admin@hearth.local` | 관리자 (내보내기·감사 기록) |

표시 이름은 아무 값이나 넣으면 됩니다. 허용 목록에 없는 메일은 거절됩니다.

데이터는 `internal-chat/data/hearth.sqlite` 와 `internal-chat/data/files/` 에 남습니다.

`npm` 으로도 같습니다: `npm install && npm test && npm run dev`.

## ACL 테스트

`pnpm test` 가 확인하는 것:

- 허용 목록 밖 로그인 거부, 공개 가입 라우트 없음
- 사용자 A는 B의 비공개 채널·B↔C 쪽지를 읽거나 검색하지 못함
- 공개 채널도 들어가기 전에는 검색에 안 잡힘
- 비멤버는 첨부를 받지 못함
- 내보내기·감사 로그는 관리자만

## API 요약

세션 쿠키 `hearth_session` (HttpOnly).

- `POST /api/auth/login` `{ email, displayName }`
- `POST /api/auth/logout`
- `GET /api/me` `GET /api/users` `GET /api/channels`
- `POST /api/channels` `{ name, type: "public" \| "private" }`
- `POST /api/channels/:id/join` (공개만)
- `POST /api/channels/:id/members` `{ userId }`
- `POST /api/dms` `{ userId }`
- `GET|POST /api/channels/:id/messages`
- `POST /api/messages/:id/reactions` `{ emoji }`
- `POST /api/channels/:id/files` multipart `file`
- `GET /api/search?q=`
- `GET /api/events` (SSE)
- `GET /api/audit` `GET /api/export` (관리자)

## 일부러 안 넣은 것

AI 동료, 의미 검색, MCP, 슬랙 ZIP 임포트, 결제, 공개 매직 링크, 멀티 워크스페이스.
