# IGG VIP Studio

Server (GitHub → Render) + Client EXE. Tool gốc chỉ có **VI / EN**. Client này thêm **PT · ID · 中文 · ES · TH · JP** (góc trên).

## Bảo mật

| Lớp | Cách |
|---|---|
| License | AES-256-GCM + HMAC, gắn Device ID dài `VIP-XXXX-…`, token 12 giờ |
| Owner | `IGG_VIP_OWNER` ≥ 12 ký tự trên Render — không hard-code `1234` |
| Master | `IGG_VIP_MASTER` ≥ 16 ký tự — khóa niêm phong |
| Catalog | ID trên Client là HMAC, ID XML thật chỉ Server |
| Save | Decrypt / encrypt / Unban / FetchCity **chỉ Server** |
| EXE | Chỉ ADB + mở web. Không chứa thuật toán |

Env Render bắt buộc: `IGG_VIP_MASTER`, `IGG_VIP_OWNER`, `NITRO_PRESET=node-server`, `NODE_VERSION=22`.

Owner khi chưa set env: `IGG-OWNER-PREVIEW` (đổi ngay trên Render).

Chi tiết deploy: [DEPLOY.md](./DEPLOY.md).

### v1.15 save format behavior
The editor follows the original v1.15 workflow: the server decodes a loaded save for editing, then returns **plain XML**. The desktop Client writes that plain XML directly to `mGameInfo.xml` and `mGameInfo.bak` in the Township save directory. It does not re-encrypt the edited XML before push.


## Unified save workflow
All editable features are now staged in the UI and committed together only when "Lưu & đẩy" is pressed. Item, Sticker, Decor, Regatta, Season and Unban no longer push immediately from their feature controls.
