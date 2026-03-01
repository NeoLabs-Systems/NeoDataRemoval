<div align="center">

# NeoDataRemoval

**Your data. Your server. Your rules.**

[![Node](https://img.shields.io/badge/Node.js-18+-5fa04e?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![SQLite](https://img.shields.io/badge/SQLite-WAL-003b57?style=flat-square&logo=sqlite&logoColor=white)](https://sqlite.org)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ed?style=flat-square&logo=docker&logoColor=white)](docker-compose.yml)
[![License](https://img.shields.io/badge/License-MIT-a855f7?style=flat-square)](LICENSE)

A self-hosted data broker scanner and opt-out manager.  
Scan 937+ data brokers for your personal info and send GDPR/CCPA removal requests automatically.  
No cloud. No subscriptions. No tracking. Just your privacy.

---

*Made with ❤️ by [Neo](https://github.com/neooriginal) · [NeoLabs Systems](https://github.com/NeoLabs-Systems)*

</div>

## Quick Start

### Docker (recommended)

```bash
cp .env.example .env
# Edit .env — set JWT_SECRET, OPENAI_API_KEY (optional), SMTP settings (optional)
docker compose up -d
```

Open [http://localhost:3000](http://localhost:3000) and register the first account (admin).

