# Mercado Pago Email Parser - Complete Documentation

## Overview

This system automatically tracks user finances by parsing Mercado Pago email notifications. Users forward their MP emails to a unique address, and the system extracts transaction data and categorizes expenses using AI.

---

## Architecture

```
┌─────────────────┐     ┌─────────────────────┐     ┌─────────────────┐
│  User forwards  │     │  Cloudflare Worker  │     │  Your Backend   │
│  MP email to    │────▶│  (Edge Function)    │────▶│  (Express API)  │
│  user_xxx@      │     │                     │     │                 │
│  jamty.xyz      │     │  • Parses email     │     │  • Auth (JWT)   │
│                 │     │  • Extracts data    │     │  • Saves to DB  │
└─────────────────┘     │  • AI categorizes   │     │  • Updates      │
                        └─────────────────────┘     │    balance      │
                                                    └────────┬────────┘
                                                             │
                        ┌─────────────────────┐              │
                        │     Supabase        │◀─────────────┘
                        │   (PostgreSQL DB)   │
                        │                     │
                        │  • users            │
                        │  • transactions     │
                        │  • expenses         │
                        └─────────────────────┘
                                  ▲
                                  │
                        ┌─────────┴─────────┐
                        │    Frontend App   │
                        │                   │
                        │  • Shows balance  │
                        │  • Shows expenses │
                        │  • Shows unique   │
                        │    forwarding     │
                        │    email          │
                        └───────────────────┘
```

---

## How User Identification Works

Each user gets a **unique forwarding email** with their ID embedded:

```
user_a8f3k2b1@jamty.xyz
      ↑
      └── This is the user's external_id in the database
```

### Flow

1. User registers → Backend generates `external_id` (e.g., `a8f3k2b1`)
2. Backend creates forwarding email: `user_a8f3k2b1@jamty.xyz`
3. Frontend displays this email to user
4. User forwards MP email to that address
5. Worker extracts `a8f3k2b1` from "To" address
6. Worker parses email, calls AI for category
7. Worker POSTs to backend webhook
8. Backend finds user by `external_id`, saves transaction

---

## Transaction Types Detected

| Type | Keywords | Direction |
|------|----------|-----------|
| `transfer_received` | recibiste, te transfirieron, te enviaron | IN (+) |
| `payment_received` | te pagaron, recibiste un pago | IN (+) |
| `refund_received` | te devolvieron, reembolso | IN (+) |
| `deposit` | ingreso, cargaste, cashback, bonificación | IN (+) |
| `transfer_sent` | transferiste, enviaste | OUT (-) |
| `payment_sent` | pagaste, compraste, qr, suscripción, cuota | OUT (-) |
| `refund_sent` | devolviste | OUT (-) |
| `withdrawal` | retiro, extracción | OUT (-) |

---

## AI Expense Categories

| Category ID | Examples |
|-------------|----------|
| `utilities-bills` | Electricity, gas, internet, phone |
| `food-dining` | Restaurants, supermarkets, delivery |
| `transportation` | Uber, fuel, parking, tolls |
| `shopping-clothing` | Clothes, electronics, retail |
| `health-wellness` | Pharmacy, gym, medical |
| `recreation-entertainment` | Netflix, Spotify, games, cinema |
| `financial-obligations` | Taxes, loans, insurance |
| `savings-investments` | Investments, crypto, stocks |
| `miscellaneous-other` | Everything else (default) |

---

## API Endpoints

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/auth/register` | POST | No | Create account |
| `/api/auth/login` | POST | No | Login |
| `/api/auth/me` | GET | JWT | Get current user |
| `/api/balance` | GET | JWT | Get balance + forwarding email |
| `/api/transactions` | GET | JWT | Get transaction history |
| `/api/summary` | GET | JWT | Dashboard data |
| `/webhook` | POST | Secret Key | Receives parsed emails |

**Response includes `forwardingEmail`:**

```json
{
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "forwardingEmail": "user_a8f3k2b1@jamty.xyz",
    "balance": 15000.50
  },
  "token": "jwt-token"
}
```

---

## Frontend Integration

### Get Forwarding Email

```javascript
// After login/register, or via GET /api/auth/me
const user = response.data.user;
console.log(user.forwardingEmail); // "user_xxx@jamty.xyz"
```

### Display Component (React)

```jsx
function ForwardingEmailCard({ user }) {
  const [copied, setCopied] = useState(false);

  const copyEmail = () => {
    navigator.clipboard.writeText(user.forwardingEmail);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="forwarding-card">
      <h3>📧 Track Your Finances Automatically</h3>
      <p>Forward your Mercado Pago emails to:</p>
      
      <div className="email-box">
        <code>{user.forwardingEmail}</code>
        <button onClick={copyEmail}>
          {copied ? '✓ Copied!' : '📋 Copy'}
        </button>
      </div>
      
      <p className="hint">
        We'll automatically extract and categorize your transactions!
      </p>
    </div>
  );
}
```

### CSS

```css
.forwarding-card {
  background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
  border-radius: 12px;
  padding: 24px;
}

.email-box {
  display: flex;
  align-items: center;
  gap: 12px;
  background: rgba(255,255,255,0.1);
  padding: 12px 16px;
  border-radius: 8px;
}

.email-box code {
  font-family: monospace;
  color: #00d9ff;
  flex: 1;
}

.email-box button {
  background: #00d9ff;
  color: #000;
  border: none;
  padding: 8px 16px;
  border-radius: 6px;
  cursor: pointer;
}
```

---

## Deployment

1. **Database:** Has `category` column ✓
2. **Worker:** `cd cloudflare-worker && npx wrangler deploy`
3. **Email Routing:** Catch-all → Worker ✓
4. **Backend:** `npm run dev` + ngrok tunnel
5. **Update WEBHOOK_URL** if ngrok URL changes, then redeploy worker
