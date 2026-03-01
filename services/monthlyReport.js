'use strict';

const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  const host = process.env.SMTP_HOST;
  if (!host) return null;
  transporter = nodemailer.createTransport({
    host,
    port:   parseInt(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transporter;
}

function buildReportHtml({ username, totalExposures, newExposures, removedCount, scanDate }) {
  const hasNew = newExposures.length > 0;
  const formattedDate = new Date(scanDate * 1000).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  const newRows = newExposures.map(e => `
    <tr>
      <td style="padding:10px 14px;border-bottom:1px solid #1e1e2e;color:#e2e0ee;font-size:14px">${escHtml(e.broker_name)}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #1e1e2e;font-size:13px">
        <span style="background:#3b1a47;color:#c084fc;border-radius:4px;padding:2px 8px;font-size:12px;font-weight:600">${escHtml(e.status)}</span>
      </td>
      ${e.profile_url ? `<td style="padding:10px 14px;border-bottom:1px solid #1e1e2e"><a href="${escHtml(e.profile_url)}" style="color:#7c3aed;font-size:13px;text-decoration:none">View listing</a></td>` : '<td style="padding:10px 14px;border-bottom:1px solid #1e1e2e;color:#6b6784;font-size:13px">—</td>'}
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Monthly Privacy Report — NeoDataRemoval</title>
</head>
<body style="margin:0;padding:0;background:#0e0e18;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:620px;margin:0 auto;padding:40px 24px">

    <!-- Header -->
    <div style="text-align:center;margin-bottom:40px">
      <div style="display:inline-flex;align-items:center;gap:10px;margin-bottom:16px">
        <div style="background:linear-gradient(135deg,#7c3aed,#5b21b6);border-radius:12px;width:44px;height:44px;display:inline-flex;align-items:center;justify-content:center;font-size:20px;vertical-align:middle">🛡</div>
        <span style="color:#ffffff;font-size:22px;font-weight:700;vertical-align:middle">NeoDataRemoval</span>
      </div>
      <h1 style="color:#ffffff;font-size:26px;font-weight:700;margin:0 0 6px">Monthly Privacy Report</h1>
      <p style="color:#9892b0;font-size:14px;margin:0">Scan completed ${formattedDate} · Hi ${escHtml(username)}</p>
    </div>

    <!-- Summary cards -->
    <div style="display:flex;gap:12px;margin-bottom:32px;flex-wrap:wrap">
      <div style="flex:1;min-width:140px;background:#16162a;border:1px solid #2a2a45;border-radius:12px;padding:20px;text-align:center">
        <div style="color:#c084fc;font-size:32px;font-weight:700;line-height:1">${totalExposures}</div>
        <div style="color:#9892b0;font-size:13px;margin-top:6px">Total Exposures</div>
      </div>
      <div style="flex:1;min-width:140px;background:#16162a;border:1px solid ${hasNew ? '#7c3aed' : '#2a2a45'};border-radius:12px;padding:20px;text-align:center">
        <div style="color:${hasNew ? '#f472b6' : '#6b6784'};font-size:32px;font-weight:700;line-height:1">${newExposures.length}</div>
        <div style="color:#9892b0;font-size:13px;margin-top:6px">New This Month</div>
      </div>
      <div style="flex:1;min-width:140px;background:#16162a;border:1px solid #2a2a45;border-radius:12px;padding:20px;text-align:center">
        <div style="color:#34d399;font-size:32px;font-weight:700;line-height:1">${removedCount}</div>
        <div style="color:#9892b0;font-size:13px;margin-top:6px">Removed</div>
      </div>
    </div>

    ${hasNew ? `
    <!-- New exposures table -->
    <div style="background:#16162a;border:1px solid #2a2a45;border-radius:12px;overflow:hidden;margin-bottom:32px">
      <div style="padding:16px 20px;border-bottom:1px solid #2a2a45;background:#1a1a2e">
        <h2 style="color:#f472b6;font-size:16px;font-weight:600;margin:0">⚠ New Exposures Found</h2>
      </div>
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr style="background:#1a1a2e">
            <th style="padding:10px 14px;text-align:left;color:#6b6784;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.5px">Broker</th>
            <th style="padding:10px 14px;text-align:left;color:#6b6784;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.5px">Status</th>
            <th style="padding:10px 14px;text-align:left;color:#6b6784;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.5px">Link</th>
          </tr>
        </thead>
        <tbody>${newRows}</tbody>
      </table>
    </div>
    ` : `
    <!-- All clear -->
    <div style="background:#0d2818;border:1px solid #166534;border-radius:12px;padding:32px;text-align:center;margin-bottom:32px">
      <div style="font-size:36px;margin-bottom:12px">✅</div>
      <h2 style="color:#4ade80;font-size:18px;font-weight:600;margin:0 0 8px">No New Exposures</h2>
      <p style="color:#86efac;font-size:14px;margin:0">No new data broker listings were found this month.</p>
    </div>
    `}

    <!-- CTA -->
    <div style="text-align:center;margin-bottom:40px">
      <a href="${process.env.APP_URL || 'http://localhost:3000'}" style="display:inline-block;background:linear-gradient(135deg,#7c3aed,#5b21b6);color:#fff;text-decoration:none;padding:14px 32px;border-radius:10px;font-size:15px;font-weight:600">Open Dashboard</a>
    </div>

    <!-- Footer -->
    <div style="text-align:center;border-top:1px solid #1e1e2e;padding-top:24px">
      <p style="color:#4a4760;font-size:12px;margin:0 0 4px">NeoDataRemoval · Self-hosted privacy protection</p>
      <p style="color:#4a4760;font-size:12px;margin:0">This report was auto-generated and sent to ${escHtml(username)}'s registered email.</p>
    </div>

  </div>
</body>
</html>`;
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function sendMonthlyReport(user, db) {
  const transport = getTransporter();
  if (!transport || !user.email) return;

  const since = (user.monthly_scan_triggered_at || 0) - 86400; // 1 day before scan trigger as buffer

  const totalExposures = db.prepare(
    "SELECT COUNT(*) as c FROM exposures WHERE user_id = ? AND status IN ('detected','re_exposed','assumed')"
  ).get(user.id).c;

  const newExposures = db.prepare(`
    SELECT e.status, e.profile_url, b.name as broker_name
    FROM exposures e
    JOIN brokers b ON b.id = e.broker_id
    WHERE e.user_id = ?
      AND e.status IN ('detected', 're_exposed')
      AND e.last_updated >= ?
    ORDER BY e.last_updated DESC
  `).all(user.id, since);

  const removedCount = db.prepare(
    "SELECT COUNT(*) as c FROM exposures WHERE user_id = ? AND status = 'removed'"
  ).get(user.id).c;

  const html = buildReportHtml({
    username: user.username,
    totalExposures,
    newExposures,
    removedCount,
    scanDate: Math.floor(Date.now() / 1000),
  });

  const from = process.env.SMTP_FROM || process.env.SMTP_USER || 'NeoDataRemoval <noreply@localhost>';

  try {
    await transport.sendMail({
      from,
      to:      user.email,
      subject: newExposures.length > 0
        ? `⚠ ${newExposures.length} new exposure${newExposures.length > 1 ? 's' : ''} found — NeoDataRemoval Monthly Report`
        : '✅ Monthly Privacy Report — No new exposures',
      html,
    });
    console.log(`[MonthlyReport] Report sent to ${user.email}`);
  } catch (err) {
    console.error(`[MonthlyReport] Failed to send to ${user.email}:`, err.message);
  }
}

module.exports = { sendMonthlyReport };
