/**
 * Transactional email (activation and password-reset codes).
 *
 * Providers, first one configured wins:
 * - Cloudflare Email Service: CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_EMAIL_API_TOKEN
 * - Resend: RESEND_API_KEY
 * - EMAIL_DEV_LOG=1: print the message to the server log (local development only)
 * EMAIL_FROM sets the sender, e.g. "theqairubook <no-reply@qairuhub.com>".
 * With no provider, email verification is off and the app falls back to the
 * student-list check plus admin tools.
 */

type Provider = "cloudflare" | "resend" | "log" | null;

function provider(): Provider {
  if (process.env.CLOUDFLARE_ACCOUNT_ID?.trim() && process.env.CLOUDFLARE_EMAIL_API_TOKEN?.trim()) {
    return "cloudflare";
  }
  if (process.env.RESEND_API_KEY?.trim()) return "resend";
  if (process.env.EMAIL_DEV_LOG === "1" && !process.env.RAILWAY_ENVIRONMENT) return "log";
  return null;
}

export function emailEnabled(): boolean {
  return provider() !== null;
}

function fromAddress(): { email: string; name: string } {
  const raw = process.env.EMAIL_FROM?.trim() || "theqairubook <no-reply@qairuhub.com>";
  const match = raw.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  return match ? { name: match[1] || "theqairubook", email: match[2] } : { name: "theqairubook", email: raw };
}

export type OutgoingEmail = { to: string; subject: string; text: string };

/** Sends one plain-text email. Returns false (and logs) on failure; never throws. */
export async function sendEmail(message: OutgoingEmail): Promise<boolean> {
  const kind = provider();
  const from = fromAddress();
  try {
    if (kind === "cloudflare") {
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID!.trim()}/email/sending/send`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.CLOUDFLARE_EMAIL_API_TOKEN!.trim()}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            to: message.to,
            from: `${from.name} <${from.email}>`,
            subject: message.subject,
            text: message.text,
          }),
          signal: AbortSignal.timeout(10_000),
        }
      );
      const data = (await res.json().catch(() => null)) as { success?: boolean } | null;
      if (!res.ok || !data?.success) {
        console.error(`email: cloudflare send failed (${res.status})`);
        return false;
      }
      return true;
    }
    if (kind === "resend") {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY!.trim()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: `${from.name} <${from.email}>`,
          to: [message.to],
          subject: message.subject,
          text: message.text,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        console.error(`email: resend send failed (${res.status})`);
        return false;
      }
      return true;
    }
    if (kind === "log") {
      console.log(`[ email:dev ] to=${message.to} subject=${message.subject}\n${message.text}`);
      return true;
    }
    return false;
  } catch (err) {
    console.error("email: send error", (err as Error).message);
    return false;
  }
}
