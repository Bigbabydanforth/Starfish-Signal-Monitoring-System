import 'dotenv/config';
import nodemailer from 'nodemailer';

// ── Low-level send ────────────────────────────────────────────────────────────
// options: { to: string|string[], subject: string, html: string }
async function sendEmail(options) {
  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST || 'smtp.gmail.com',
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  const mailOptions = {
    from:    process.env.EMAIL_FROM,
    to:      Array.isArray(options.to) ? options.to.join(', ') : options.to,
    subject: options.subject,
    html:    options.html
  };

  const info = await transporter.sendMail(mailOptions);
  return info;
}

export { sendEmail };
