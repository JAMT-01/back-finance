/**
 * Mercado Pago Email Parser - Backend Server
 * Using Supabase REST API for database operations
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
require('dotenv').config();

// Email service for forwarding verification emails
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// CONFIGURATION
// ============================================

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'super_secret_password';
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_jwt_secret_in_production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const EMAIL_DOMAIN = process.env.EMAIL_DOMAIN || 'jamty.xyz';

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ============================================
// MIDDLEWARE
// ============================================

app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', process.env.FRONTEND_URL || '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ============================================
// AUTH MIDDLEWARE
// ============================================

async function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', decoded.userId)
      .single();

    if (error || !user) {
      return res.status(401).json({ error: 'User not found' });
    }

    req.user = user;
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    return res.status(500).json({ error: 'Authentication error' });
  }
}

// ============================================
// AUTH ENDPOINTS
// ============================================

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Check if email exists
    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .eq('email', email.toLowerCase())
      .single();

    if (existing) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    // Generate unique external_id
    const externalId = crypto.randomBytes(4).toString('hex');
    const passwordHash = await bcrypt.hash(password, 10);

    // Create user
    const { data: user, error } = await supabase
      .from('users')
      .insert({
        external_id: externalId,
        email: email.toLowerCase(),
        password_hash: passwordHash,
        name: name || null,
        balance: 0
      })
      .select()
      .single();

    if (error) {
      console.error('Supabase error:', error);
      return res.status(500).json({ error: 'Registration failed' });
    }

    const forwardingEmail = `user_${user.external_id}@${EMAIL_DOMAIN}`;
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

    console.log(`👤 New user registered: ${email} → ${forwardingEmail}`);

    res.status(201).json({
      message: 'Account created successfully',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        balance: parseFloat(user.balance),
        forwardingEmail,
        createdAt: user.created_at,
      },
      token,
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email.toLowerCase())
      .single();

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
    const forwardingEmail = `user_${user.external_id}@${EMAIL_DOMAIN}`;

    console.log(`🔓 User logged in: ${email}`);

    res.json({
      message: 'Login successful',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        balance: parseFloat(user.balance),
        forwardingEmail,
        createdAt: user.created_at,
      },
      token,
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  const forwardingEmail = `user_${req.user.external_id}@${EMAIL_DOMAIN}`;
  res.json({
    user: {
      id: req.user.id,
      email: req.user.email,
      name: req.user.name,
      balance: parseFloat(req.user.balance),
      forwardingEmail,
      createdAt: req.user.created_at,
    },
  });
});

// ============================================
// PROTECTED USER ENDPOINTS
// ============================================

app.get('/api/balance', authMiddleware, async (req, res) => {
  res.json({
    balance: parseFloat(req.user.balance),
    currency: 'ARS',
    forwardingEmail: `user_${req.user.external_id}@${EMAIL_DOMAIN}`,
  });
});

app.get('/api/transactions', authMiddleware, async (req, res) => {
  try {
    const { limit = 50, offset = 0, type } = req.query;

    let query = supabase
      .from('transactions')
      .select('*', { count: 'exact' })
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (type) {
      query = query.eq('type', type);
    }

    const { data: transactions, count, error } = await query;

    if (error) throw error;

    res.json({
      transactions: transactions.map(formatTransaction),
      total: count,
      limit: parseInt(limit),
      offset: parseInt(offset),
    });

  } catch (error) {
    console.error('Error fetching transactions:', error);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

app.get('/api/summary', authMiddleware, async (req, res) => {
  try {
    // Get recent transactions
    const { data: transactions, error } = await supabase
      .from('transactions')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(10);

    if (error) throw error;

    // Calculate stats
    let totalReceived = 0;
    let totalSent = 0;
    const byType = {};

    for (const tx of transactions) {
      if (!byType[tx.type]) byType[tx.type] = { count: 0, total: 0 };
      byType[tx.type].count++;
      byType[tx.type].total += parseFloat(tx.amount);

      if (['transfer_received', 'payment_received', 'deposit', 'refund_received'].includes(tx.type)) {
        totalReceived += parseFloat(tx.amount);
      } else if (['transfer_sent', 'payment_sent', 'withdrawal', 'refund_sent'].includes(tx.type)) {
        totalSent += parseFloat(tx.amount);
      }
    }

    res.json({
      user: {
        id: req.user.id,
        email: req.user.email,
        name: req.user.name,
        forwardingEmail: `user_${req.user.external_id}@${EMAIL_DOMAIN}`,
      },
      balance: parseFloat(req.user.balance),
      currency: 'ARS',
      stats: {
        totalReceived,
        totalSent,
        netFlow: totalReceived - totalSent,
        transactionCount: transactions.length,
        byType,
      },
      recentTransactions: transactions.map(formatTransaction),
    });

  } catch (error) {
    console.error('Error fetching summary:', error);
    res.status(500).json({ error: 'Failed to fetch summary' });
  }
});

// ============================================
// WEBHOOK ENDPOINT (from Cloudflare Worker)
// ============================================

app.post('/webhook', async (req, res) => {
  try {
    const secretKey = req.headers['x-secret-key'];
    if (secretKey !== WEBHOOK_SECRET) {
      console.warn('⚠️ Invalid webhook secret');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const data = req.body;
    console.log('📧 Webhook received:', JSON.stringify(data, null, 2));

    if (!data.valid) {
      await logParsingFailure(data);
      return res.json({ status: 'logged', message: 'Parsing failure recorded' });
    }

    // Get user by external_id
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('*')
      .eq('external_id', data.userId)
      .single();

    if (userError || !user) {
      console.warn(`⚠️ No user found for: ${data.userId}`);
      return res.status(404).json({ error: 'User not found. They must register first.' });
    }

    // Check duplicate using emailHash (unique fingerprint of the email content)
    // This prevents the same email from being processed twice, while allowing
    // different transactions with the same amount/counterparty
    if (data.emailHash) {
      const { data: existing } = await supabase
        .from('transactions')
        .select('id')
        .eq('user_id', user.id)
        .eq('email_hash', data.emailHash)
        .single();

      if (existing) {
        console.log(`⏭️ Skipping duplicate (emailHash): ${data.emailHash.substring(0, 16)}...`);
        return res.json({ status: 'skipped', reason: 'duplicate' });
      }
    }

    // Note: We only use emailHash for duplicate detection now.
    // referenceId is not reliable because MP may reuse IDs or parsing may extract wrong IDs.

    // Create transaction
    const { data: transaction, error: txError } = await supabase
      .from('transactions')
      .insert({
        user_id: user.id,
        type: data.type,
        amount: data.amount,
        currency: data.currency || 'ARS',
        counterparty: data.counterparty,
        description: data.description,
        reference_id: data.referenceId,
        email_hash: data.emailHash || null,
        category: data.category || null,
        email_subject: data.subject,
        email_from: data.from,
        received_at: data.receivedAt || new Date().toISOString(),
      })
      .select()
      .single();

    if (txError) throw txError;

    // Update balance
    const balanceChange = calculateBalanceChange(data.type, data.amount);
    if (balanceChange !== 0) {
      await supabase
        .from('users')
        .update({ balance: user.balance + balanceChange })
        .eq('id', user.id);
    }

    console.log(`✅ Transaction: ${transaction.id}`);
    console.log(`   User: ${user.email}, Type: ${data.type}, Amount: $${data.amount}`);
    console.log(`   Balance change: ${balanceChange >= 0 ? '+' : ''}${balanceChange}`);

    return res.json({
      status: 'success',
      transactionId: transaction.id,
      balanceChange,
    });

  } catch (error) {
    console.error('❌ Webhook error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// EMAIL FORWARDING ENDPOINT (for Gmail verification)
// ============================================

app.post('/forward-verification', async (req, res) => {
  try {
    const secretKey = req.headers['x-secret-key'];
    if (secretKey !== WEBHOOK_SECRET) {
      console.warn('⚠️ Invalid secret for verification forwarding');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { userId, subject, htmlBody, textBody, verificationLink } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    // Get user by external_id
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('email')
      .eq('external_id', userId)
      .single();

    if (userError || !user) {
      console.warn(`⚠️ No user found for verification: ${userId}`);
      return res.status(404).json({ error: 'User not found' });
    }

    if (!resend) {
      console.error('❌ RESEND_API_KEY not configured');
      return res.status(500).json({ error: 'Email service not configured' });
    }

    // Forward the verification email to the user
    const { data, error } = await resend.emails.send({
      from: 'Jamty Finance <noreply@jamty.xyz>',
      to: user.email,
      subject: subject || 'Gmail Forwarding Verification',
      html: htmlBody || `
        <h2>Gmail Forwarding Verification</h2>
        <p>You requested to forward emails to your Jamty Finance account.</p>
        ${verificationLink ? `<p><a href="${verificationLink}">Click here to confirm forwarding</a></p>` : ''}
        <p>Or copy this link: ${verificationLink || 'N/A'}</p>
      `,
      text: textBody || `Gmail Forwarding Verification\n\nClick here to confirm: ${verificationLink || 'N/A'}`,
    });

    if (error) {
      console.error('❌ Email send error:', error);
      return res.status(500).json({ error: 'Failed to send email' });
    }

    console.log(`📧 Verification email forwarded to ${user.email} (ID: ${data.id})`);
    return res.json({ status: 'forwarded', emailId: data.id });

  } catch (error) {
    console.error('❌ Forward verification error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// HEALTH CHECK
// ============================================

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  });
});

// ============================================
// HELPER FUNCTIONS
// ============================================

function formatTransaction(tx) {
  return {
    id: tx.id,
    type: tx.type,
    amount: parseFloat(tx.amount),
    currency: tx.currency,
    counterparty: tx.counterparty,
    description: tx.description,
    referenceId: tx.reference_id,
    category: tx.category || null,
    createdAt: tx.created_at,
  };
}

function calculateBalanceChange(type, amount) {
  const incomeTypes = ['transfer_received', 'payment_received', 'deposit', 'refund_received'];
  const expenseTypes = ['transfer_sent', 'payment_sent', 'withdrawal', 'refund_sent'];

  if (incomeTypes.includes(type)) return amount;
  if (expenseTypes.includes(type)) return -amount;
  return 0;
}

async function logParsingFailure(data) {
  try {
    await supabase.from('parsing_failures').insert({
      user_id: data.userId || null,
      reason: data.reason || 'unknown',
      email_subject: data.subject || null,
      email_from: data.from || null,
      body_preview: data.bodyPreview || null,
      raw_data: data,
    });
  } catch (error) {
    console.error('Failed to log parsing failure:', error);
  }
}

// ============================================
// SERVER STARTUP
// ============================================

app.listen(PORT, () => {
  console.log('');
  console.log('='.repeat(60));
  console.log('🚀 Mercado Pago Email Parser - Backend Server');
  console.log('='.repeat(60));
  console.log('');
  console.log('📡 Server running on port', PORT);
  console.log('🗄️  Using Supabase REST API');
  console.log('');
  console.log('🔐 Auth Endpoints:');
  console.log('   POST /api/auth/register  - Create account');
  console.log('   POST /api/auth/login     - Login');
  console.log('   GET  /api/auth/me        - Get current user');
  console.log('');
  console.log('👤 User Endpoints (protected):');
  console.log('   GET  /api/balance        - Get balance');
  console.log('   GET  /api/transactions   - Get transactions');
  console.log('   GET  /api/summary        - Get dashboard data');
  console.log('');
  console.log('📧 Webhook:');
  console.log('   POST /webhook            - From Cloudflare Worker');
  console.log('');
  console.log(`📬 Email domain: ${EMAIL_DOMAIN}`);
  console.log('='.repeat(60));
  console.log('');
});
