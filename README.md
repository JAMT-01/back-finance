# Mercado Pago Email Parser

Automatically credit user accounts when they forward Mercado Pago payment emails.

## 🎯 How It Works

```
┌─────────────────────────────────────────────────────────────────────────┐
│  1. User registers on your app → gets unique email:                     │
│     user_a8f3k2b1@jamty.xyz                                             │
│                         ↓                                               │
│  2. User forwards their MP emails to that address                       │
│                         ↓                                               │
│  3. Cloudflare Email Routing → Catch-All → Worker                       │
│                         ↓                                               │
│  4. Worker parses email, extracts: user_id, amount, type                │
│                         ↓                                               │
│  5. Worker POSTs to Backend → Updates user balance                      │
│                         ↓                                               │
│  6. User sees updated balance in your app!                              │
└─────────────────────────────────────────────────────────────────────────┘
```

## 📁 Project Structure

```
├── backend_server.js           # Express API (auth + webhook + user data)
├── cloudflare-worker/
│   ├── src/index.js            # Email parser (runs on Cloudflare Edge)
│   └── wrangler.toml           # Worker config
├── src/db/schema.sql           # PostgreSQL schema
├── package.json
├── SETUP_GUIDE.md              # Complete step-by-step setup
└── README.md
```

## 🚀 Quick Start

```bash
# 1. Install
npm install

# 2. Configure database
cp env.example.txt .env
# Edit .env with your DATABASE_URL

# 3. Run migrations
npm run db:migrate

# 4. Start server
npm run dev

# 5. Expose with ngrok (new terminal)
npm run tunnel

# 6. Deploy Cloudflare Worker (update WEBHOOK_URL first)
npm run worker:deploy
```

**See [SETUP_GUIDE.md](./SETUP_GUIDE.md) for complete instructions.**

## 📡 API Endpoints

### Authentication

```bash
# Register
POST /api/auth/register
Body: { "email": "...", "password": "...", "name": "..." }
Returns: { user, token }

# Login
POST /api/auth/login
Body: { "email": "...", "password": "..." }
Returns: { user, token }

# Get current user
GET /api/auth/me
Headers: Authorization: Bearer <token>
```

### User Data (Protected)

```bash
# Get balance
GET /api/balance
Headers: Authorization: Bearer <token>
Returns: { balance, currency, forwardingEmail }

# Get transactions
GET /api/transactions?limit=50&offset=0
Headers: Authorization: Bearer <token>

# Get dashboard summary
GET /api/summary
Headers: Authorization: Bearer <token>
Returns: { user, balance, stats, recentTransactions }
```

### Webhook (from Cloudflare)

```bash
POST /webhook
Headers: X-Secret-Key: <secret>
Body: { userId, type, amount, ... }
```

## 🔐 Security

| Setting | Development | Production |
|---------|-------------|------------|
| `JWT_SECRET` | Any string | Random 32+ chars |
| `WEBHOOK_SECRET` | `super_secret_password` | Strong UUID |
| Backend URL | ngrok | Static HTTPS URL |

## 📊 Transaction Types

| Type | Description | Balance |
|------|-------------|---------|
| `transfer_received` | Money received | ➕ |
| `transfer_sent` | Money sent | ➖ |
| `payment_received` | Sale/service income | ➕ |
| `payment_sent` | Purchase made | ➖ |
| `deposit` | Added money to MP | ➕ |
| `withdrawal` | Withdrew to bank | ➖ |

## 📈 Scalability

- **Users:** Unlimited (database rows)
- **Emails/day (free):** 100,000
- **Workers/day (free):** 100,000

## 📝 License

MIT
