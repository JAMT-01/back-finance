/**
 * Multi-Institution Email Parser - Cloudflare Worker
 * 
 * This worker receives emails via Cloudflare Email Routing,
 * classifies them, and forwards extracted data to our backend.
 * 
 * Pipeline:
 * 1. Email arrives at user_xxx@jamty.xyz
 * 2. Step 1: Validate sender institution (MP, Ualá, banks, etc.)
 * 3. Step 2: Classify intent (transaction vs promotional)
 * 4. Step 3: Parse and normalize transaction data
 * 5. POST to backend webhook
 */

// ============================================
// CONFIGURATION
// ============================================

const WEBHOOK_URL = "https://web-production-d345.up.railway.app/webhook";
const SECRET_KEY = "super_secret_password";

// ============================================
// FINANCIAL INSTITUTIONS REGISTRY
// ============================================

const FINANCIAL_INSTITUTIONS = {
  // Fintechs
  mercadopago: {
    name: 'Mercado Pago',
    type: 'fintech',
    transactionalDomains: ['info@mercadopago.com', 'info@mercadopago.com.ar'],
    marketingDomains: ['marketing@mercadopago.com', 'marketing@mercadopago.com.ar', 'promociones@mercadopago.com'],
  },
  uala: {
    name: 'Ualá',
    type: 'fintech',
    transactionalDomains: ['@uala.com.ar', '@notificaciones.uala.com.ar'],
    marketingDomains: ['@marketing.uala.com.ar', '@promo.uala.com.ar'],
  },
  brubank: {
    name: 'Brubank',
    type: 'fintech',
    transactionalDomains: ['@brubank.com.ar', '@notificaciones.brubank.com.ar'],
    marketingDomains: ['@marketing.brubank.com.ar'],
  },
  naranjax: {
    name: 'Naranja X',
    type: 'fintech',
    transactionalDomains: ['@naranjax.com', '@notificaciones.naranjax.com'],
    marketingDomains: ['@marketing.naranjax.com'],
  },
  personalpay: {
    name: 'Personal Pay',
    type: 'fintech',
    transactionalDomains: ['@personalpay.com.ar'],
    marketingDomains: ['@marketing.personalpay.com.ar'],
  },

  // Traditional Banks
  galicia: {
    name: 'Banco Galicia',
    type: 'bank',
    transactionalDomains: ['@bancogalicia.com.ar', '@e.bancogalicia.com.ar', '@notificaciones.bancogalicia.com.ar'],
    marketingDomains: ['@marketing.bancogalicia.com.ar', '@ofertas.bancogalicia.com.ar'],
  },
  santander: {
    name: 'Banco Santander',
    type: 'bank',
    transactionalDomains: ['@santander.com.ar', '@email.santander.com.ar', '@notificaciones.santander.com.ar'],
    marketingDomains: ['@marketing.santander.com.ar', '@ofertas.santander.com.ar'],
  },
  bbva: {
    name: 'BBVA',
    type: 'bank',
    transactionalDomains: ['@bbva.com.ar', '@notificaciones.bbva.com.ar'],
    marketingDomains: ['@marketing.bbva.com.ar'],
  },
  nacion: {
    name: 'Banco Nación',
    type: 'bank',
    transactionalDomains: ['@bna.com.ar', '@notificaciones.bna.com.ar'],
    marketingDomains: ['@marketing.bna.com.ar'],
  },
  macro: {
    name: 'Banco Macro',
    type: 'bank',
    transactionalDomains: ['@macro.com.ar', '@notificaciones.macro.com.ar'],
    marketingDomains: ['@marketing.macro.com.ar'],
  },
  hsbc: {
    name: 'HSBC Argentina',
    type: 'bank',
    transactionalDomains: ['@hsbc.com.ar', '@notificaciones.hsbc.com.ar'],
    marketingDomains: ['@marketing.hsbc.com.ar'],
  },
  icbc: {
    name: 'ICBC Argentina',
    type: 'bank',
    transactionalDomains: ['@icbc.com.ar', '@notificaciones.icbc.com.ar'],
    marketingDomains: ['@marketing.icbc.com.ar'],
  },
};

// Promotional keywords for quick detection
const PROMOTIONAL_KEYWORDS = [
  'cashback disponible', 'ganaste', 'beneficio exclusivo', 'descuento',
  'oferta especial', 'promo', 'cupón', 'premio', 'sorteo', 'regalo',
  'aprovechá', 'no te pierdas', 'por tiempo limitado', 'solo hoy',
  'última oportunidad', 'exclusivo para vos', 'bonus', 'puntos extra',
  'recompensa', 'acumulá', 'canjeá', 'duplicá', 'triplicá'
];

// ============================================
// EMAIL HANDLER
// ============================================

export default {
  async email(message, env, ctx) {
    try {
      // 1. Extract user ID from the "To" address
      const toAddress = message.to; // e.g., "user_123@jamty.xyz"
      const userId = extractUserId(toAddress);

      if (!userId) {
        console.log(`Invalid recipient address: ${toAddress}`);
        return; // Silently drop - no valid user ID
      }

      // 2. Get the raw email content
      const rawEmail = await streamToString(message.raw);

      // 3. Parse the email body
      const emailBody = extractEmailBody(rawEmail);
      const subject = extractHeader(rawEmail, 'Subject') || '';
      const from = message.from;

      // 4. Handle Gmail forwarding verification emails
      if (from.includes('forwarding-noreply@google.com') || from.includes('noreply@google.com')) {
        console.log('📬 Gmail verification email detected!');

        // Extract verification link from the email content
        const fullContent = emailBody + ' ' + rawEmail;

        // Look for the confirmation link
        const linkPatterns = [
          /https?:\/\/mail\.google\.com\/mail\/[^\s"'<>\]]+/gi,
          /https?:\/\/mail-settings\.google\.com\/mail\/[^\s"'<>\]]+/gi,
          /https?:\/\/www\.google\.com\/url\?[^\s"'<>\]]+/gi,
        ];

        let verificationLink = null;
        for (const pattern of linkPatterns) {
          const matches = fullContent.match(pattern);
          if (matches) {
            // Find verification-related links
            const verifyLinks = matches
              .map(link => link.replace(/[.,;:!?)>\]&]+$/, '').replace(/&amp;/g, '&'))
              .filter(link => link.includes('vf-') || link.includes('confirm') || link.includes('verify'));
            if (verifyLinks.length > 0) {
              verificationLink = verifyLinks[0];
              break;
            }
          }
        }

        // Send to backend for forwarding to user's actual email
        try {
          const forwardResponse = await fetch(WEBHOOK_URL.replace('/webhook', '/forward-verification'), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Secret-Key': SECRET_KEY,
            },
            body: JSON.stringify({
              userId,
              subject: subject,
              htmlBody: emailBody,
              verificationLink,
            }),
          });

          if (forwardResponse.ok) {
            console.log(`✅ Verification email sent to backend for forwarding to user ${userId}`);
          } else {
            const errorText = await forwardResponse.text();
            console.log(`⚠️ Backend forwarding failed: ${errorText}`);
          }
        } catch (fwdError) {
          console.log(`⚠️ Could not forward verification: ${fwdError.message}`);
        }

        return;
      }

      // ====================================
      // STEP 1: Identify Financial Institution
      // ====================================
      console.log(`📧 Processing email from: ${from}`);

      const institution = identifyInstitution(from);

      if (!institution) {
        console.log(`⚠️ Unknown sender, not from any registered financial institution: ${from}`);
        return; // Silently drop emails from unknown senders
      }

      console.log(`🏦 Institution: ${institution.name} (${institution.type})`);
      console.log(`📋 Subject: ${subject}`);
      console.log(`📝 Body preview: ${emailBody.substring(0, 300).replace(/\s+/g, ' ')}`);

      // ====================================
      // STEP 2: Classify Intent (Transaction vs Promotional)
      // ====================================
      const intent = await classifyEmailIntent(env, institution, subject, emailBody.substring(0, 500));

      if (intent.type === 'promotional') {
        console.log(`📣 Promotional email detected from ${institution.name} - skipping`);
        console.log(`   Reason: ${intent.reason} (confidence: ${intent.confidence})`);
        // Optionally log promotional emails for analytics
        await sendToBackend({
          userId,
          valid: true,
          isPromotional: true,
          institution: institution.id,
          institutionName: institution.name,
          subject,
          classificationReason: intent.reason,
          receivedAt: new Date().toISOString(),
        });
        return;
      }

      console.log(`✅ Transaction email confirmed (${intent.confidence}: ${intent.reason})`);

      // ====================================
      // STEP 3: Parse and Normalize Transaction Data
      // ====================================
      const transaction = await parseTransaction(env, subject, emailBody);

      if (!transaction.amount || transaction.amount <= 0) {
        console.log(`Could not extract amount from email`);
        await sendToBackend({
          userId,
          valid: false,
          institution: institution.id,
          reason: 'parse_failed',
          subject,
          bodyPreview: emailBody.substring(0, 500),
        });
        return;
      }

      // Categorize transaction using AI
      const category = await categorizeWithAI(
        env,
        transaction.counterparty,
        transaction.description,
        subject,
        transaction.type
      );
      console.log(`🏷️ AI Category: ${category}`);

      // Create unique email hash for duplicate detection
      const emailFingerprint = subject + emailBody.substring(0, 200);
      const emailHash = await createHash(emailFingerprint);

      // Send to backend
      await sendToBackend({
        userId,
        valid: true,
        type: transaction.type,
        amount: transaction.amount,
        currency: transaction.currency || 'ARS',
        counterparty: transaction.counterparty,
        description: transaction.description,
        referenceId: transaction.referenceId,
        emailHash,
        category,
        institution: institution.id,
        institutionName: institution.name,
        institutionType: institution.type,
        subject,
        from,
        receivedAt: new Date().toISOString(),
      });

      console.log(`✅ Processed: ${userId} - ${institution.name} - ${transaction.type} - $${transaction.amount}${category ? ` [${category}]` : ''}`);

    } catch (error) {
      console.error('Worker error:', error);

      // Try to notify backend of the error
      try {
        await sendToBackend({
          valid: false,
          reason: 'worker_error',
          error: error.message,
        });
      } catch (e) {
        // Ignore secondary errors
      }
    }
  }
};

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Create SHA-256 hash of a string (for email fingerprinting)
 */
async function createHash(str) {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Handle Gmail forwarding verification emails
 * Extracts the confirmation code since link-clicking doesn't work (Google requires auth session)
 */
async function handleGmailVerification(body, rawEmail) {
  try {
    const fullContent = body + ' ' + rawEmail;

    // Log a preview of the email content for debugging
    console.log(`📧 Email preview: ${fullContent.substring(0, 300).replace(/\s+/g, ' ')}...`);

    // PRIORITY: Extract confirmation code first (this is the reliable method)
    // Google verification emails contain a 9-digit code like: "Código de confirmación: 123456789"
    const codePatterns = [
      /c[oó]digo[:\s]+(\d{9})/i,
      /confirmation code[:\s]+(\d{9})/i,
      /code[:\s]+(\d{9})/i,
      /(\d{9})/  // fallback: any 9-digit number
    ];

    for (const pattern of codePatterns) {
      const codeMatch = fullContent.match(pattern);
      if (codeMatch) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`🔑 GMAIL VERIFICATION CODE: ${codeMatch[1]}`);
        console.log(`${'='.repeat(60)}`);
        console.log(`📋 Copy this code and paste it in Gmail Settings → Forwarding`);
        console.log(`${'='.repeat(60)}\n`);
        return true;
      }
    }

    // Fallback: Try clicking verification links (usually doesn't work due to auth requirements)
    const patterns = [
      /https?:\/\/mail\.google\.com\/mail\/[^\s"'<>\]]+/gi,
      /https?:\/\/mail-settings\.google\.com\/mail\/[^\s"'<>\]]+/gi,
      /https?:\/\/www\.google\.com\/url\?[^\s"'<>\]]+/gi,
    ];

    const allLinks = [];
    for (const pattern of patterns) {
      const matches = fullContent.match(pattern);
      if (matches) {
        allLinks.push(...matches);
      }
    }

    const uniqueLinks = [...new Set(allLinks)]
      .map(link => link.replace(/[.,;:!?)>\]&]+$/, '').replace(/&amp;/g, '&'))
      .filter(link => link.includes('vf-') || link.includes('confirm') || link.includes('verify'));

    console.log(`🔍 Found ${uniqueLinks.length} verification links`);

    for (const link of uniqueLinks) {
      console.log(`🔗 Trying: ${link.substring(0, 80)}...`);
      try {
        const response = await fetch(link, {
          method: 'GET',
          redirect: 'follow',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
        });
        console.log(`📡 Response: ${response.status}`);
        // Note: 200 doesn't mean verified - Google requires authenticated session
      } catch (fetchError) {
        console.log(`⚠️ Fetch error: ${fetchError.message}`);
      }
    }

    console.log(`\n⚠️ Could not extract confirmation code from email.`);
    console.log(`� Check your Gmail inbox for the verification email and find the 9-digit code.\n`);
    return false;
  } catch (error) {
    console.error('Gmail verification error:', error);
    return false;
  }
}


/**
 * Extract user ID from email address
 * Input: "user_123@jamty.xyz" or "user_abc456@jamty.xyz"
 * Output: "123" or "abc456"
 */
function extractUserId(email) {
  if (!email) return null;

  // Match pattern: user_[ID]@domain
  const match = email.toLowerCase().match(/^user_([a-z0-9_]+)@/);
  return match ? match[1] : null;
}

/**
 * Convert ReadableStream to string
 */
async function streamToString(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }

  return result;
}

/**
 * Extract a header value from raw email
 */
function extractHeader(rawEmail, headerName) {
  const regex = new RegExp(`^${headerName}:\\s*(.+)$`, 'mi');
  const match = rawEmail.match(regex);
  return match ? match[1].trim() : null;
}

/**
 * Extract email body from raw MIME content
 * Handles both plain text and HTML emails
 */
function extractEmailBody(rawEmail) {
  // Split headers from body (empty line separates them)
  const parts = rawEmail.split(/\r?\n\r?\n/);

  if (parts.length < 2) {
    return rawEmail; // No clear separation, return as-is
  }

  // Get everything after headers
  let body = parts.slice(1).join('\n\n');

  // If it's a multipart email, try to extract text/plain or text/html
  const contentType = extractHeader(rawEmail, 'Content-Type') || '';

  if (contentType.includes('multipart')) {
    // Extract boundary
    const boundaryMatch = contentType.match(/boundary="?([^";\s]+)"?/);
    if (boundaryMatch) {
      const boundary = boundaryMatch[1];
      const textPart = extractMimePart(body, boundary, 'text/plain');
      const htmlPart = extractMimePart(body, boundary, 'text/html');

      // Prefer plain text, fall back to HTML (stripped of tags)
      if (textPart) {
        body = textPart;
      } else if (htmlPart) {
        body = stripHtml(htmlPart);
      }
    }
  }

  // Handle quoted-printable encoding
  if (rawEmail.includes('Content-Transfer-Encoding: quoted-printable')) {
    body = decodeQuotedPrintable(body);
  }

  // Handle base64 encoding
  if (rawEmail.includes('Content-Transfer-Encoding: base64')) {
    try {
      body = atob(body.replace(/\s/g, ''));
    } catch (e) {
      // Not valid base64, keep as-is
    }
  }

  return body;
}

/**
 * Extract a specific MIME part from multipart email
 */
function extractMimePart(body, boundary, contentType) {
  const parts = body.split('--' + boundary);

  for (const part of parts) {
    if (part.toLowerCase().includes(`content-type: ${contentType}`)) {
      // Split this part's headers from its body
      const subParts = part.split(/\r?\n\r?\n/);
      if (subParts.length >= 2) {
        return subParts.slice(1).join('\n\n').trim();
      }
    }
  }

  return null;
}

/**
 * Strip HTML tags from content
 */
function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Decode quoted-printable encoding
 */
function decodeQuotedPrintable(str) {
  return str
    .replace(/=\r?\n/g, '') // Remove soft line breaks
    .replace(/=([0-9A-F]{2})/gi, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    );
}

/**
 * Extract clean email address from "Name <email>" format
 */
function extractEmailAddress(from) {
  if (!from) return '';
  const lowerFrom = from.toLowerCase().trim();
  const emailMatch = lowerFrom.match(/<([^>]+)>/);
  return emailMatch ? emailMatch[1].trim() : lowerFrom;
}

/**
 * Step 1: Identify the financial institution from sender email
 * Returns institution info or null if unknown sender
 */
function identifyInstitution(from) {
  const email = extractEmailAddress(from);
  if (!email) return null;

  for (const [id, inst] of Object.entries(FINANCIAL_INSTITUTIONS)) {
    // Check transactional domains
    for (const domain of inst.transactionalDomains || []) {
      if (domain.startsWith('@')) {
        if (email.endsWith(domain)) {
          return { id, name: inst.name, type: inst.type, isMarketing: false };
        }
      } else {
        if (email === domain) {
          return { id, name: inst.name, type: inst.type, isMarketing: false };
        }
      }
    }

    // Check marketing domains
    for (const domain of inst.marketingDomains || []) {
      if (domain.startsWith('@')) {
        if (email.endsWith(domain)) {
          return { id, name: inst.name, type: inst.type, isMarketing: true };
        }
      } else {
        if (email === domain) {
          return { id, name: inst.name, type: inst.type, isMarketing: true };
        }
      }
    }
  }

  return null; // Unknown sender
}

/**
 * Step 2: Classify email intent - is this a real transaction or promotional?
 * Uses keyword matching first (fast), falls back to AI for ambiguous cases
 */
async function classifyEmailIntent(env, institution, subject, bodyPreview) {
  const subjectLower = subject.toLowerCase();
  const bodyLower = bodyPreview.toLowerCase();
  const fullText = subjectLower + ' ' + bodyLower;

  // Quick promotional detection via keywords
  for (const keyword of PROMOTIONAL_KEYWORDS) {
    if (fullText.includes(keyword)) {
      console.log(`📣 Promotional keyword detected: "${keyword}"`);
      return { type: 'promotional', confidence: 'keyword', reason: keyword };
    }
  }

  // If sender is from marketing domain, it's almost certainly promotional
  if (institution.isMarketing) {
    return { type: 'promotional', confidence: 'domain', reason: 'marketing domain' };
  }

  // Transaction keywords (high confidence)
  const transactionKeywords = [
    'transferiste', 'recibiste', 'pagaste', 'te transfirieron',
    'te pagaron', 'retiro', 'depósito', 'compra', 'cobro',
    'movimiento', 'operación exitosa', 'comprobante'
  ];

  for (const keyword of transactionKeywords) {
    if (fullText.includes(keyword)) {
      return { type: 'transaction', confidence: 'keyword', reason: keyword };
    }
  }

  // AI classification for ambiguous cases
  try {
    const prompt = `Classify this ${institution.name} email. Is it about REAL money that already moved, or a PROMOTIONAL offer/bonus?

Subject: ${subject}
Preview: ${bodyPreview.substring(0, 200)}

IMPORTANT: 
- "transaction" = money ALREADY moved (transfer completed, payment made)
- "promotional" = offers, bonuses to claim, incentives, marketing

Answer with ONLY one word: transaction OR promotional`;

    const result = await env.AI.run('@cf/meta/llama-3.2-3b-instruct', {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 10,
    });

    const response = result.response?.toLowerCase().trim() || '';
    const isTransaction = response.includes('transaction');

    console.log(`🤖 AI classification: ${isTransaction ? 'transaction' : 'promotional'}`);
    return {
      type: isTransaction ? 'transaction' : 'promotional',
      confidence: 'ai',
      reason: `AI: ${response}`
    };

  } catch (error) {
    console.error('AI classification error:', error);
    // Default to transaction if AI fails (safer to parse than to miss)
    return { type: 'transaction', confidence: 'fallback', reason: 'AI error' };
  }
}

// Legacy function for backwards compatibility
function isFromMercadoPago(from) {
  const institution = identifyInstitution(from);
  return institution !== null;
}

/**
 * Valid expense categories
 */
const VALID_CATEGORIES = [
  'utilities-bills',
  'food-dining',
  'transportation',
  'shopping-clothing',
  'health-wellness',
  'recreation-entertainment',
  'financial-obligations',
  'savings-investments',
  'miscellaneous-other'
];

const VALID_TRANSACTION_TYPES = [
  'transfer_received',
  'transfer_sent',
  'payment_received',
  'payment_sent',
  'withdrawal',
  'deposit',
  'refund_received',
  'refund_sent'
];

/**
 * Detect transaction type using Cloudflare Workers AI
 * Analyzes email subject and body to determine transaction type
 */
async function detectTransactionTypeWithAI(env, subject, bodyPreview) {
  try {
    const context = `Subject: ${subject}\nBody: ${bodyPreview.substring(0, 300)}`;

    const prompt = `Analyze this Mercado Pago email and determine the transaction type.

Transaction Types:
- transfer_received: Money received via transfer (keywords: recibiste, te transfirieron, te enviaron)
- transfer_sent: Money sent via transfer (keywords: transferiste, enviaste, transferencia enviada)
- payment_received: Payment received for a sale (keywords: te pagaron, vendiste)
- payment_sent: Payment made for purchase (keywords: pagaste, compraste, QR, suscripción)
- deposit: Money added to account (keywords: ingreso, cargaste, acreditamos, cashback, bonificación)
- withdrawal: Money withdrawn (keywords: retiro, extracción)
- refund_received: Refund received (keywords: te devolvieron, reembolso recibido)
- refund_sent: Refund sent (keywords: devolviste, reembolsaste)

Email:
${context}

Respond with ONLY the transaction type ID (e.g., "transfer_sent"), nothing else.`;

    const response = await env.AI.run('@cf/meta/llama-3.2-3b-instruct', {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 30,
    });

    const type = response.response?.trim().toLowerCase().replace(/[^a-z_]/g, '');

    if (VALID_TRANSACTION_TYPES.includes(type)) {
      console.log(`🤖 AI detected type: ${type}`);
      return type;
    }

    console.log(`AI returned invalid type: "${response.response}", falling back to keyword matching`);
    return null; // Will fall back to keyword matching

  } catch (error) {
    console.error('AI type detection error:', error);
    return null; // Will fall back to keyword matching
  }
}

/**
 * Categorize transaction using Cloudflare Workers AI
 * Works for both income and expense transactions
 */
async function categorizeWithAI(env, counterparty, description, subject, transactionType) {
  try {
    const context = [counterparty, description, subject]
      .filter(Boolean)
      .join(' ')
      .trim();

    if (!context) {
      return 'miscellaneous-other';
    }

    // Determine if income or expense for better prompting
    const incomeTypes = ['transfer_received', 'payment_received', 'deposit', 'refund_received'];
    const isIncome = incomeTypes.includes(transactionType);

    const prompt = `Categorize this ${isIncome ? 'income' : 'expense'} transaction into exactly ONE category.

Categories:
- utilities-bills: electricity, gas, water, internet, phone, cable, rent
- food-dining: restaurants, cafes, supermarkets, delivery apps, food, groceries
- transportation: uber, taxi, fuel, parking, tolls, public transit, car expenses
- shopping-clothing: clothes, electronics, retail stores, online shopping, Amazon, MercadoLibre
- health-wellness: pharmacy, medical, gym, health insurance, doctor, hospital
- recreation-entertainment: netflix, spotify, games, cinema, streaming, hobbies, sports
- financial-obligations: taxes, loans, insurance premiums, bank fees, credit card
- savings-investments: investments, crypto, stocks, savings, interest income
- miscellaneous-other: personal transfers, gifts, anything that doesn't fit above

Transaction: "${context}"

Respond with ONLY the category ID (e.g., "food-dining"), nothing else.`;

    const response = await env.AI.run('@cf/meta/llama-3.2-3b-instruct', {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 30,
    });

    const category = response.response?.trim().toLowerCase().replace(/[^a-z-]/g, '');

    if (VALID_CATEGORIES.includes(category)) {
      return category;
    }

    console.log(`AI returned invalid category: "${response.response}", defaulting to miscellaneous-other`);
    return 'miscellaneous-other';

  } catch (error) {
    console.error('AI categorization error:', error);
    return 'miscellaneous-other';
  }
}


/**
 * Parse transaction data from email content
 * Uses AI for type detection with keyword matching as fallback
 */
async function parseTransaction(env, subject, body) {
  const result = {
    type: 'unknown',
    amount: 0,
    currency: 'ARS',
    counterparty: null,
    description: null,
    referenceId: null,
  };

  const subjectLower = subject.toLowerCase();
  const bodyLower = body.toLowerCase();
  const fullText = subject + ' ' + body;

  // Try AI-based type detection first
  const aiType = await detectTransactionTypeWithAI(env, subject, body.substring(0, 500));

  if (aiType) {
    result.type = aiType;
  } else {
    // Fallback to keyword matching if AI fails
    console.log('⚠️ AI type detection failed, using keyword matching');

    // MONEY IN (+) types
    if (subjectLower.includes('recibiste') || subjectLower.includes('te transfirieron') || subjectLower.includes('te enviaron') || subjectLower.includes('transferencia recibida')) {
      result.type = 'transfer_received';
    } else if (subjectLower.includes('te pagaron') || subjectLower.includes('recibiste un pago') || subjectLower.includes('te depositaron') || subjectLower.includes('pago recibido')) {
      result.type = 'payment_received';
    } else if (subjectLower.includes('te devolvieron') || subjectLower.includes('reembolso') || bodyLower.includes('devolución a tu favor')) {
      result.type = 'refund_received';
    } else if (subjectLower.includes('ingreso') || subjectLower.includes('cargaste') || subjectLower.includes('acreditamos') || subjectLower.includes('cashback') || subjectLower.includes('bonificación') || subjectLower.includes('ganaste')) {
      result.type = 'deposit';
    }
    // MONEY OUT (-) types
    else if (subjectLower.includes('transferiste') || subjectLower.includes('enviaste') || subjectLower.includes('transferencia enviada') || subjectLower.includes('fue enviada')) {
      result.type = 'transfer_sent';
    } else if (subjectLower.includes('pagaste') || subjectLower.includes('compraste') || subjectLower.includes('qr') || subjectLower.includes('suscripción') || subjectLower.includes('cobro automático') || subjectLower.includes('cuota') || subjectLower.includes('débito') || subjectLower.includes('pago enviado')) {
      result.type = 'payment_sent';
    } else if (subjectLower.includes('devolviste') || subjectLower.includes('reembolsaste')) {
      result.type = 'refund_sent';
    } else if (subjectLower.includes('retiro') || bodyLower.includes('retiro') || subjectLower.includes('extracción')) {
      result.type = 'withdrawal';
    }
  }

  // Extract amount
  result.amount = extractAmount(fullText);

  // Extract counterparty name - improved patterns for MP emails
  const counterpartyPatterns = [
    // "Nombre y apellido: Maria Lourdes Montagner" (MP transfer emails)
    /nombre\s+y\s+apellido[:\s*]+\*?([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s]{2,40}?)\*?(?:\s*Entidad|\s*$|\s*\n)/i,
    // "Le transferiste a Juan Pérez" or "Transferencia a Juan Pérez"
    /(?:transferiste|enviaste|transferencia)\s+a\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s]{1,30}?)(?:\s*\$|\s*por|\s*$|\s*\.)/i,
    // "de Juan Pérez" or "a Juan Pérez" or "para Juan Pérez"
    /(?:de|a|para)\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s]{1,30}?)(?:\s*\$|\s*por|\s*$|\s*\.)/i,
    // "Juan Pérez te transfirió"
    /([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s]{1,30}?)\s+te\s+(?:transfirió|pagó|envió)/i,
    // "Destinatario: Juan Pérez" or "Receptor: Juan Pérez"
    /(?:destinatario|receptor|beneficiario)[:\s]+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s]{1,30})/i,
    // "Pagaste en Tienda XYZ" or "Compraste en Tienda XYZ"
    /(?:pagaste|compraste)\s+en\s+([A-Za-zÀ-ÿ0-9][A-Za-zÀ-ÿ0-9\s]{1,30})/i,
  ];

  for (const pattern of counterpartyPatterns) {
    const match = fullText.match(pattern);
    if (match && match[1].trim().length > 1) {
      result.counterparty = match[1].trim();
      break;
    }
  }

  // Extract reference/operation ID
  const refMatch = fullText.match(/(?:operación|referencia|id|comprobante)[:\s#]*(\d{5,})/i);
  if (refMatch) {
    result.referenceId = refMatch[1];
  }

  // Log parsing details for debugging
  console.log(`📊 Parsed: type=${result.type}, amount=${result.amount}, counterparty=${result.counterparty || 'N/A'}`);

  return result;
}

/**
 * Extract amount from text
 * Handles Argentine formats: $1.500 or $1.500,00
 */
function extractAmount(text) {
  // Look for peso amounts
  const patterns = [
    /\$\s*([\d.]+(?:,\d{2})?)/g,   // $1.500 or $1.500,00
    /ARS\s*([\d.]+(?:,\d{2})?)/gi, // ARS 1500
  ];

  let maxAmount = 0;

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const amount = parseArgentineAmount(match[1]);
      if (amount > maxAmount) {
        maxAmount = amount;
      }
    }
  }

  return maxAmount;
}

/**
 * Parse Argentine number format to float
 * "1.500,50" → 1500.50
 * "1.500" → 1500
 */
function parseArgentineAmount(str) {
  let cleaned = str.trim();

  // If ends with ,XX (decimal), convert to standard format
  if (/,\d{2}$/.test(cleaned)) {
    cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  } else {
    // No decimal, just remove thousands separators
    cleaned = cleaned.replace(/\./g, '');
  }

  const amount = parseFloat(cleaned);
  return isNaN(amount) ? 0 : amount;
}

/**
 * Send parsed data to backend webhook
 */
async function sendToBackend(data) {
  const response = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Secret-Key': SECRET_KEY,
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    throw new Error(`Backend responded with ${response.status}: ${await response.text()}`);
  }

  return response.json();
}

