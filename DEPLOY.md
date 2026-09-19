# IGG VIP Studio — Server (GitHub → Render)

## Bảo mật

- Token license: AES-256-GCM + HMAC, gắn Device ID, hết hạn 12 giờ.
- Catalog ID trên Client là HMAC, ID thật chỉ trên Server.
- Decrypt / encrypt / Unban / FetchCity chỉ chạy Server.
- Client EXE không chứa thuật toán save.

Env bắt buộc trên Render:

| Key | Ý nghĩa |
|---|---|
| `IGG_VIP_MASTER` | Chuỗi ≥ 16 ký tự — khóa AES/HMAC |
| `IGG_VIP_OWNER` | Owner key ≥ 12 ký tự — vào Control |
| `NITRO_PRESET` | `node-server` |
| `NODE_VERSION` | `22` |

Owner mặc định nếu chưa set env: `IGG-OWNER-PREVIEW`

## Render

1. Đẩy zip Server lên GitHub.
2. Web Service, Node, Singapore.
3. Build: `NPM_CONFIG_PRODUCTION=false npm install && npm run build`
4. Start: `node .output/server/index.mjs`
5. Điền env trên rồi Redeploy.

FetchCity cần Python — `nixpacks.toml` đã xin python311.

Ngôn ngữ Client: VI / EN / PT / ID / ZH / ES / TH / JP (góc trên).
