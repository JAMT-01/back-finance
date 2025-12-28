/**
 * Mercado Pago Email Parser - Cloudflare Worker
 * 
 * This worker receives emails via Cloudflare Email Routing,
 * parses the content, and forwards extracted data to our backend.
 * 
 * Flow:
 * 1. Email arrives at user_123@jamty.xyz
 * 2. Cloudflare catch-all routes to this worker
 * 3. Worker parses email and extracts: user_id, amount, type
 * 4. Worker POSTs clean JSON to backend webhook
 */

// ============================================
// CONFIGURATION - Update for your environment
// ============================================

// Development: Use ngrok URL
// Production: Use your deployed backend URL
const WEBHOOK_URL = "https://web-production-d345.up.railway.app/webhook";

// Secret key for webhook authentication
// IMPORTANT: Change this in production!
const SECRET_KEY = "super_secret_password";

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

        return; // Don't process further
      }

      // 5. Validate sender is from Mercado Pago official transactional email
      if (!isFromMercadoPago(from)) {
        console.log(`Email not from official Mercado Pago transactional address: ${from}`);
        await sendToBackend({
          userId,
          valid: false,
          reason: 'not_mercadopago',
          from,
          subject,
        });
        return;
      }
      console.log(`📧 Processing email from: ${from}`);
      console.log(`📋 Subject: ${subject}`);
      console.log(`📝 Body preview: ${emailBody.substring(0, 500).replace(/\s+/g, ' ')}`);

      // 5. Extract transaction data
      const transaction = parseTransaction(subject, emailBody);

      if (!transaction.amount || transaction.amount <= 0) {
        console.log(`Could not extract amount from email`);
        await sendToBackend({
          userId,
          valid: false,
          reason: 'parse_failed',
          subject,
          bodyPreview: emailBody.substring(0, 500),
        });
        return;
      }

      // 6. Categorize expenses using AI (only for money-out transactions)
      let category = null;
      const expenseTypes = ['transfer_sent', 'payment_sent', 'withdrawal', 'refund_sent'];
      if (expenseTypes.includes(transaction.type)) {
        category = await categorizeWithAI(
          env,
          transaction.counterparty,
          transaction.description,
          subject
        );
        console.log(`🏷️ AI Category: ${category}`);
      }

      // 7. Create unique email hash for duplicate detection
      // This uses subject + first 200 chars of body to create a fingerprint
      const emailFingerprint = subject + emailBody.substring(0, 200);
      const emailHash = await createHash(emailFingerprint);

      // 8. Send to backend
      await sendToBackend({
        userId,
        valid: true,
        type: transaction.type,
        amount: transaction.amount,
        currency: transaction.currency || 'ARS',
        counterparty: transaction.counterparty,
        description: transaction.description,
        referenceId: transaction.referenceId,
        emailHash, // Unique fingerprint for this specific email
        category,
        subject,
        from,
        receivedAt: new Date().toISOString(),
      });

      console.log(`✅ Processed: ${userId} - ${transaction.type} - $${transaction.amount}${category ? ` [${category}]` : ''}`);

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
 * Check if email is from Mercado Pago official transactional addresses
 * Only accepts info@mercadopago.com and info@mercadopago.com.ar
 * This filters out promotional emails from marketing@mercadopago.com etc.
 */
function isFromMercadoPago(from) {
  if (!from) return false;

  // Only accept official transactional email addresses
  const validSenders = [
    'info@mercadopago.com',
    'info@mercadopago.com.ar',
  ];

  const lowerFrom = from.toLowerCase();
  return validSenders.some(sender => lowerFrom.includes(sender));
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

/**
 * Categorize expense using Cloudflare Workers AI
 * Uses Llama 3.2 3B for intelligent categorization
 */
async function categorizeWithAI(env, counterparty, description, subject) {
  try {
    // Build context from available fields
    const context = [counterparty, description, subject]
      .filter(Boolean)
      .join(' ')
      .trim();

    if (!context) {
      return 'miscellaneous-other';
    }

    const prompt = `Categorize this expense into exactly ONE category.

Categories:
- utilities-bills: electricity, gas, water, internet, phone, cable
- food-dining: restaurants, cafes, supermarkets, delivery apps, food
- transportation: uber, taxi, fuel, parking, tolls, public transit
- shopping-clothing: clothes, electronics, retail stores, online shopping
- health-wellness: pharmacy, medical, gym, health insurance
- recreation-entertainment: netflix, spotify, games, cinema, streaming
- financial-obligations: taxes, loans, insurance premiums, bank fees
- savings-investments: investments, crypto, stocks, savings
- miscellaneous-other: anything else

Transaction: "${context}"

Respond with ONLY the category ID (e.g., "food-dining"), nothing else.`;

    const response = await env.AI.run('@cf/meta/llama-3.2-3b-instruct', {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 30,
    });

    const category = response.response?.trim().toLowerCase().replace(/[^a-z-]/g, '');

    // Validate the response is a valid category
    if (VALID_CATEGORIES.includes(category)) {
      return category;
    }

    // If AI returned something invalid, default to miscellaneous
    console.log(`AI returned invalid category: "${response.response}", defaulting to miscellaneous-other`);
    return 'miscellaneous-other';

  } catch (error) {
    console.error('AI categorization error:', error);
    return 'miscellaneous-other';
  }
}


/**
 * Parse transaction data from email content
 */
function parseTransaction(subject, body) {
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

  // Determine transaction type from subject and body
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

