# 🌐 Delentia MCP Ecosystem

[![Model Context Protocol](https://img.shields.io/badge/MCP-Server-blue.svg)](https://modelcontextprotocol.io)
[![Runtime](https://img.shields.io/badge/Runtime-Cloudflare%20Workers%20%2B%20Durable%20Objects-orange.svg)](https://workers.cloudflare.com)
[![Language](https://img.shields.io/badge/Language-TypeScript-blue.svg)](https://www.typescriptlang.org)

**A policy gate and signed audit trail for AI agents.** Put it in front of the tools your agent can call: before a risky action runs, the agent asks the gate, and the gate answers with a deterministic allow/deny (no second LLM judging the first) plus a SHA-256 audit digest. Actions that aren't registered in your policy are denied by default. It also includes a context compressor for large logs/code, a structured reasoning checklist, and Ed25519-signed task packets — all exposed as standard MCP tools.

**ด่านตรวจนโยบายและ audit log ที่ลงลายเซ็นได้ สำหรับ AI agent** — วางไว้หน้าเครื่องมือที่ agent ของคุณเรียกใช้ได้ ก่อนที่คำสั่งเสี่ยงจะถูกรัน agent ต้องถามด่านนี้ก่อน ด่านจะตอบ อนุญาต/ปฏิเสธ แบบกำหนดผลได้แน่นอน (ไม่ได้ใช้ LLM อีกตัวมาตัดสิน) พร้อม audit digest ทุกครั้ง คำสั่งที่ไม่ได้ลงทะเบียนไว้ใน policy จะถูกปฏิเสธโดยอัตโนมัติ

👉 **เริ่มใช้งานใน 5 นาที: [docs/QUICKSTART.md](docs/QUICKSTART.md)**

---

## เครื่องมือ (MCP tools)

| Tool | ทำอะไร | หมายเหตุตามจริง |
| :--- | :--- | :--- |
| `evaluate_fdia` | ให้คะแนนความปลอดภัยของคำสั่งก่อนรัน `F = (D^I) × A` ถ้าไม่มีสิทธิ์ (A = 0) → F = 0 และปฏิเสธทันที | สูตรเป็น deterministic scoring ไม่ใช่การพิสูจน์ทางคณิตศาสตร์ คุณภาพขึ้นกับค่า D/I/A และ policy ที่ตั้งไว้ |
| `configure_policy` | ตั้ง/ดู policy (บทบาท, action ที่อนุญาต, threshold) แยกตาม session | state ถูกแยกต่อ tenant ด้วย Durable Objects |
| `rct_think` | checklist การคิด 7 ขั้น + คะแนน alignment | คะแนนเป็น heuristic (Jaccard + ความเจาะจงของโจทย์) ไม่ได้รับประกันว่าไม่หลอน |
| `compress_context` | ตัดบรรทัดซ้ำ และ (โหมด aggressive) กรองเฉพาะบรรทัดที่เกี่ยวกับคำถาม | ผลวัดจริงดู [benchmark](benchmarks/compression-real/REPORT.md): ลด token ~70–76% บนโค้ด/log/เอกสารจริง เมื่อคำถามใช้คำเดียวกับข้อมูล; ถ้าถามแบบถอดความ อาจทำคำตอบหาย |
| `orchestrate_swarm` | แตกงานเป็น packet ที่ลงลายเซ็น Ed25519 ตรวจสอบย้อนหลังได้ว่าถูกแก้ไขหรือไม่ | |

Endpoint แบบรวมทุก tool (แนะนำ): `https://delentia-sovereign-mcp.delentia.workers.dev/mcp`
Endpoint แยกรายตัว: `delentia-fdia-mcp`, `delentia-rct7-mcp`, `delentia-delta-mcp`, `delentia-jitna-mcp` (`.delentia.workers.dev/mcp`)

Transports: Streamable HTTP (`/mcp`) และ SSE (`/sse`) สำหรับ client รุ่นเก่า

---

## สถาปัตยกรรม

```
 Agent / IDE ──MCP──► Cloudflare Worker (sovereign)
                        │  CORD: entropy + prompt-injection scan ของ input
                        │  FDIA gate: F = (D^I) × A  ← policy ต่อ tenant (Durable Object)
                        │  Tools: rct_think / compress_context / orchestrate_swarm
                        ▼
                     ผลลัพธ์ + audit digest (SHA-256) / packet ลงลายเซ็น Ed25519
```

- **Cloudflare Durable Objects:** เก็บ session/policy state แยกต่อ tenant
- **Dual transport:** Streamable HTTP (`/mcp`) และ SSE (`/sse`)
- **Python kernel bridge (ทางเลือก):** `evaluate_fdia` cross-check กับ Delentia-OS ได้ถ้าตั้ง `PYTHON_KERNEL_URL` — ยังไม่เปิดใช้ใน production

---

## 🛠️ พัฒนาและทดสอบในเครื่อง

```bash
npm install
npm run build
npm run typecheck
npm run test:all          # ชุดเดียวกับที่ CI รัน
npm run bench:compression # benchmark การบีบอัดแบบ deterministic (ต้องมี Python + tiktoken)
```

ทดสอบ server ในเครื่อง:
```bash
npm run dev:fdia
npx @modelcontextprotocol/inspector   # แล้วเชื่อมไปที่ http://localhost:8787/mcp
```

Deploy (ทีละ worker, ต้อง `npx wrangler login` ก่อน):
```bash
npm run deploy:sovereign
```

---

## 💳 แผนเชิงพาณิชย์ (ยังไม่เปิดให้บริการ)

มีแผนทำ API gateway แบบเสียเงินผ่าน Zuplo + Stripe (ไฟล์ `docs/openapi.yaml`) แต่ **ยังไม่ได้เปิดใช้งาน** — `api.delentialabs.com` ยังไม่ resolve ณ 2026-09-27 ตอนนี้ใช้ได้เฉพาะ endpoint `*.delentia.workers.dev` ด้านบน

---

## 📄 ลิขสิทธิ์
สงวนลิขสิทธิ์ (c) 2026 **Delentia Labs**
สถาปนิกและผู้สร้างสรรค์: **อิทธิฤทธิ์ แซ่โง้ว (Ittirit Saengow)**
ข้อมูลอ้างอิง: [https://delentia.com](https://delentia.com)
