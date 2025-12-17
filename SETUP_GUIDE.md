# 🚀 Complete Setup Guide

This guide will get you from zero to a working Mercado Pago email parser.

---

## 📋 Prerequisites

- [Node.js 18+](https://nodejs.org/)
- [PostgreSQL](https://www.postgresql.org/) database
- [Cloudflare account](https://cloudflare.com/) with a domain
- [ngrok](https://ngrok.com/) (for local development)

---

## 🗂️ Step 1: Clone & Install

```bash
# Navigate to project
cd "back v3"

# Install dependencies
npm install
```

---

## 🗄️ Step 2: Database Setup

### Option A: Local PostgreSQL

```bash
# Create database
createdb mercadopago_parser

# Set connection string
export DATABASE_URL="postgresql://postgres:password@localhost:5432/mercadopago_parser"
```

### Option B: Cloud Database (Recommended)

Use one of these free services:
- [Supabase](https://supabase.com/) - 500MB free
- [Neon](https://neon.tech/) - 512MB free
- [Railway](https://railway.app/) - 1GB free

Copy the connection string they provide.

### Run Migrations

```bash
# Create tables
npm run db:migrate
```

You should see no errors. Verify with:
```bash
psql $DATABASE_URL -c "\dt"
```

Expected output:
```
         List of relations
 Schema |       Name        | Type  
--------+-------------------+-------
 public | parsing_failures  | table
 public | transactions      | table
 public | users             | table
```

---

## ⚙️ Step 3: Configure Environment

```bash
# Create .env file
cp env.example.txt .env
```

Edit `.env`:
```env
DATABASE_URL=postgresql://your-connection-string
JWT_SECRET=generate-a-random-32-character-string
WEBHOOK_SECRET=your-secret-key-here
EMAIL_DOMAIN=jamty.xyz
PORT=3000
```

**Generate a secure JWT secret:**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## 🖥️ Step 4: Start Backend

```bash
# Development (auto-reload)
npm run dev
```

You should see:
```
============================================================
🚀 Mercado Pago Email Parser - Backend Server
============================================================

📡 Server running on port 3000

🔐 Auth Endpoints:
   POST /api/auth/register  - Create account
   POST /api/auth/login     - Login
   GET  /api/auth/me        - Get current user

👤 User Endpoints (protected):
   GET  /api/balance        - Get balance
   GET  /api/transactions   - Get transactions
   GET  /api/summary        - Get dashboard data

📧 Webhook:
   POST /webhook            - From Cloudflare Worker

📬 Email domain: jamty.xyz
============================================================
```

---

## 🌐 Step 5: Expose Backend (Development)

In a **new terminal**:

```bash
npm run tunnel
# OR directly:
ngrok http 3000
```

Copy the HTTPS URL:
```
Forwarding    https://a1b2c3d4.ngrok-free.app -> http://localhost:3000
              ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
              Copy this URL!
```

---

## ☁️ Step 6: Configure Cloudflare Worker

### 6.1 Update Worker Code

Edit `cloudflare-worker/src/index.js`:

```javascript
// Line 15-16: Update these values
const WEBHOOK_URL = "https://a1b2c3d4.ngrok-free.app/webhook";  // Your ngrok URL
const SECRET_KEY = "your-secret-key-here";  // Must match .env WEBHOOK_SECRET
```

### 6.2 Deploy Worker

```bash
# Login to Cloudflare (first time only)
npx wrangler login

# Deploy
npm run worker:deploy
```

### 6.3 Configure Email Routing

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Select your domain (`jamty.xyz`)
3. Go to **Email** → **Email Routing**
4. Enable Email Routing if not already enabled
5. Go to **Routing Rules** tab
6. Find **Catch-all address**
7. Click **Edit**
8. Set action to: **Send to a Worker**
9. Select: `mercado-pago-scraper`
10. Save

---

## 🧪 Step 7: Test Everything!

### Test 1: API Registration

```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "password123",
    "name": "Test User"
  }'
```

Expected response:
```json
{
  "message": "Account created successfully",
  "user": {
    "id": "uuid-here",
    "email": "test@example.com",
    "name": "Test User",
    "balance": 0,
    "forwardingEmail": "user_a8f3k2b1@jamty.xyz"
  },
  "token": "eyJhbG..."
}
```

**Save the `forwardingEmail` - you'll need it!**

### Test 2: Webhook (Simulate Cloudflare)

```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -H "X-Secret-Key: your-secret-key-here" \
  -d '{
    "userId": "a8f3k2b1",
    "valid": true,
    "type": "transfer_received",
    "amount": 1500,
    "currency": "ARS",
    "counterparty": "Juan Pérez",
    "subject": "Recibiste una transferencia"
  }'
```

### Test 3: Check Balance

```bash
curl http://localhost:3000/api/balance \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

Expected:
```json
{
  "balance": 1500,
  "currency": "ARS",
  "forwardingEmail": "user_a8f3k2b1@jamty.xyz"
}
```

### Test 4: Real Email

Send an email to the forwarding address you got:
- **To:** `user_a8f3k2b1@jamty.xyz`
- **From:** Any email that looks like Mercado Pago (for testing, modify the `isFromMercadoPago` function)
- **Subject:** `Recibiste una transferencia`
- **Body:** `Te enviaron $2.500`

Check your backend terminal - you should see the webhook arrive!

---

## 🚀 Step 8: Production Deployment

### Backend (Railway/Render)

1. Push code to GitHub
2. Connect to Railway/Render
3. Set environment variables:
   - `DATABASE_URL`
   - `JWT_SECRET`
   - `WEBHOOK_SECRET`
   - `EMAIL_DOMAIN`
4. Deploy
5. Get your production URL

### Update Cloudflare Worker

1. Edit `cloudflare-worker/src/index.js`
2. Change `WEBHOOK_URL` to your production URL
3. Run `npm run worker:deploy`

---

## 📱 Frontend Integration

### Register User
```javascript
const response = await fetch('https://your-api.com/api/auth/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    email: 'user@example.com',
    password: 'securepassword',
    name: 'User Name'
  })
});

const { user, token } = await response.json();
// Save token in localStorage
localStorage.setItem('token', token);
// Show user their forwarding email
console.log('Forward MP emails to:', user.forwardingEmail);
```

### Login
```javascript
const response = await fetch('https://your-api.com/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    email: 'user@example.com',
    password: 'securepassword'
  })
});

const { user, token } = await response.json();
localStorage.setItem('token', token);
```

### Get Dashboard Data
```javascript
const token = localStorage.getItem('token');

const response = await fetch('https://your-api.com/api/summary', {
  headers: { 
    'Authorization': `Bearer ${token}` 
  }
});

const data = await response.json();
// data.balance - current balance
// data.recentTransactions - last 10 transactions
// data.stats.totalReceived - total income
// data.stats.totalSent - total expenses
```

---

## 🔧 Troubleshooting

### "User not found" on webhook
The user must register through `/api/auth/register` first. The system no longer auto-creates users.

### Emails not arriving
1. Check Cloudflare Email Routing is enabled
2. Verify catch-all points to your worker
3. Check worker logs: `npx wrangler tail`

### Invalid token
- Token expired (default 7 days)
- User needs to login again

### Parse failures
Check the `parsing_failures` table:
```sql
SELECT * FROM parsing_failures WHERE resolved = FALSE;
```

---

## 📊 API Reference

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/auth/register` | POST | No | Create account |
| `/api/auth/login` | POST | No | Login |
| `/api/auth/me` | GET | Yes | Get current user |
| `/api/balance` | GET | Yes | Get balance |
| `/api/transactions` | GET | Yes | Get transactions |
| `/api/summary` | GET | Yes | Get dashboard data |
| `/webhook` | POST | Secret | From Cloudflare Worker |
| `/health` | GET | No | Health check |

---

## ✅ Checklist

- [ ] PostgreSQL database created
- [ ] `.env` file configured
- [ ] Backend running (`npm run dev`)
- [ ] ngrok tunnel running (`npm run tunnel`)
- [ ] Cloudflare Worker deployed
- [ ] Email Routing catch-all configured
- [ ] Test registration works
- [ ] Test webhook works
- [ ] Test real email works

---

🎉 **You're done!** Your Mercado Pago email parser is ready to go!

