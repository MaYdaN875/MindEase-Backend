export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

/**
 * Minimal email gateway. `EMAIL_PROVIDER=resend` sends through Resend's HTTP API;
 * anything else only logs that a message would have been sent. The body (which
 * contains codes/tokens) is never logged.
 */
export const sendEmail = async (message: EmailMessage): Promise<void> => {
  const provider = (process.env.EMAIL_PROVIDER || 'console').toLowerCase();

  if (provider !== 'resend') {
    console.log(`[EMAIL:console] to=${message.to} subject="${message.subject}" (not sent)`);
    return;
  }

  const apiKey = process.env.EMAIL_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) {
    throw new Error('EMAIL_API_KEY and EMAIL_FROM are required when EMAIL_PROVIDER=resend');
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'User-Agent': 'mindease-backend/1.0' },
    body: JSON.stringify({ from, to: [message.to], subject: message.subject, text: message.text }),
  });

  if (!response.ok) {
    // Keep only a short, scrubbed excerpt: no email addresses, no codes.
    let excerpt = '';
    try {
      excerpt = (await response.text())
        .replace(/[\w.+-]+@[\w.-]+/g, '[email]')
        .replace(/\d{6}/g, '[code]')
        .slice(0, 300);
    } catch (_e) {
      // Body unreadable.
    }
    const type = response.headers.get('content-type') || 'none';
    console.error(`[EMAIL:resend] failed status=${response.status} contentType=${type} body=${JSON.stringify(excerpt)}`);
    throw new Error('Email provider rejected the request');
  }
};
