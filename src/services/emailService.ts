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
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [message.to], subject: message.subject, text: message.text }),
  });

  if (!response.ok) {
    let errorName = 'unknown';
    try {
      const body = (await response.json()) as { name?: string };
      if (typeof body.name === 'string') errorName = body.name;
    } catch (_e) {
      // Body was not JSON; keep the generic label.
    }
    console.error(`[EMAIL:resend] failed status=${response.status} name=${errorName}`);
    throw new Error('Email provider rejected the request');
  }
};
