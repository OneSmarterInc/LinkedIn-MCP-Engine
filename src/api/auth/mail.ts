/**
 * Account emails: "someone asked for access" to the admins, "you were approved" / "not approved" to the person,
 * password reset, and a test mail. Sent over SMTP with nodemailer from the mailbox in .env (SMTP_HOST, SMTP_PORT,
 * SMTP_USER, SMTP_PASS, MAIL_FROM, MAIL_REPLY_TO). Without SMTP_HOST nothing is sent and the portal works as before.
 *
 * Keep this mailbox separate from the one AutoBooker sends outreach from: a lead should never receive a system
 * message, and a password reset should never land in a sales thread.
 */
import nodemailer from "nodemailer";

export interface MailMessage { to: string; subject: string; text: string; html?: string }
export type SendMail = (m: MailMessage) => Promise<void>;

export interface MailSettings {
  host: string; port: number; user: string; pass: string; from: string; replyTo?: string;
  /** Where the portal lives, for links in the mails. */
  portalUrl: string;
  adminNotify: string[];
}

export function mailSettings(env: NodeJS.ProcessEnv): MailSettings | undefined {
  const host = env.SMTP_HOST?.trim();
  if (!host) return undefined;
  const user = env.SMTP_USER?.trim() ?? "";
  return {
    host,
    port: Number(env.SMTP_PORT) || 587,
    user,
    pass: env.SMTP_PASS ?? "",
    from: env.MAIL_FROM?.trim() || user,
    ...(env.MAIL_REPLY_TO?.trim() ? { replyTo: env.MAIL_REPLY_TO.trim() } : {}),
    portalUrl: (env.PORTAL_URL?.trim() || "http://localhost:5173").replace(/\/$/, ""),
    adminNotify: (env.ADMIN_NOTIFY ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  };
}

/** A sender over SMTP. Port 465 is implicit TLS; anything else starts plain and upgrades (STARTTLS). */
export function smtpSender(s: MailSettings, timeoutMs = 20_000): SendMail {
  const transport = nodemailer.createTransport({
    host: s.host, port: s.port, secure: s.port === 465,
    auth: s.user ? { user: s.user, pass: s.pass } : undefined,
    connectionTimeout: timeoutMs, greetingTimeout: timeoutMs, socketTimeout: timeoutMs,
    requireTLS: s.port !== 465,
  });
  return async (m) => {
    await transport.sendMail({ from: s.from, to: m.to, subject: m.subject, text: m.text, ...(m.html ? { html: m.html } : {}), ...(s.replyTo ? { replyTo: s.replyTo } : {}) });
  };
}

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const wrap = (title: string, lines: string[], button?: { label: string; url: string }) => {
  const text = [title, "", ...lines, ...(button ? ["", `${button.label}: ${button.url}`] : []), "", "Outreach Console"].join("\n");
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1b1f24;max-width:560px">
<h2 style="font-size:18px;margin:0 0 12px">${esc(title)}</h2>
${lines.map((l) => `<p style="margin:0 0 10px">${esc(l)}</p>`).join("\n")}
${button ? `<p style="margin:18px 0"><a href="${esc(button.url)}" style="background:#0b5cad;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;display:inline-block">${esc(button.label)}</a></p><p style="font-size:13px;color:#57606a">Or open this link: ${esc(button.url)}</p>` : ""}
<p style="font-size:13px;color:#57606a;margin-top:18px">Outreach Console</p></div>`;
  return { text, html };
};

export const templates = {
  accessRequested(portalUrl: string, person: { full_name: string; email: string }): Omit<MailMessage, "to"> {
    return { subject: `Access request: ${person.full_name}`, ...wrap("Someone asked for access to the Outreach Console",
      [`${person.full_name} (${person.email}) registered and is waiting for approval.`, "Open the Users page to approve or reject the request."],
      { label: "Open Users", url: `${portalUrl}/#users` }) };
  },
  approved(portalUrl: string, person: { full_name: string }, role: string): Omit<MailMessage, "to"> {
    return { subject: "Your Outreach Console access is approved", ...wrap(`You're in, ${person.full_name.split(" ")[0]}`,
      [`An administrator approved your request (role: ${role}).`, "Sign in with your email and password. The first time, you will set up an authenticator app for the six-digit code."],
      { label: "Sign in", url: `${portalUrl}/#signin` }) };
  },
  rejected(person: { full_name: string }, reason?: string): Omit<MailMessage, "to"> {
    return { subject: "Your Outreach Console request", ...wrap(`Hello ${person.full_name.split(" ")[0]}`,
      ["Your request for access was not approved.", ...(reason ? [`Reason given: ${reason}`] : []), "If you think this is a mistake, contact an administrator."]) };
  },
  passwordReset(portalUrl: string, person: { full_name: string }, token: string, minutes: number): Omit<MailMessage, "to"> {
    return { subject: "Reset your Outreach Console password", ...wrap(`Hello ${person.full_name.split(" ")[0]}`,
      [`Someone asked to reset the password for this account. If that was you, use the link below within ${minutes} minutes.`, "If it was not you, ignore this message; your password stays as it is."],
      { label: "Choose a new password", url: `${portalUrl}/#reset=${encodeURIComponent(token)}` }) };
  },
  test(portalUrl: string, by: string): Omit<MailMessage, "to"> {
    return { subject: "Outreach Console test email", ...wrap("SMTP works", [`Sent from the Users page by ${by}.`, `Portal: ${portalUrl}`]) };
  },
};
