// Versiyon otomatik artırıldı: +5
const VERSION = "v0.0.0.0.2512041365";

// Google JWT için helper
function createJwt(email, privateKey) {
  const header = {
    alg: "RS256",
    typ: "JWT",
  };

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };

  const enc = (obj) =>
    btoa(JSON.stringify(obj))
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");

  const unsigned = `${enc(header)}.${enc(payload)}`;

  const signature = crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    privateKey,
    new TextEncoder().encode(unsigned)
  );

  return (async () => {
    const sig = await signature;
    const b64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    return `${unsigned}.${b64}`;
  })();
}

// PRIVATE KEY'i import eden helper (Cloudflare için gerekli)
async function importPrivateKey(pem) {
  const clean = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");

  const binary = Uint8Array.from(atob(clean), (c) => c.charCodeAt(0)).buffer;

  return crypto.subtle.importKey(
    "pkcs8",
    binary,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

// Google OAuth token alma
async function getAccessToken(email, privateKey) {
  const key = await importPrivateKey(privateKey);
  const jwt = await createJwt(email, key);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  const data = await res.json();
  return data.access_token;
}

// Sheet’e yazma fonksiyonu
async function appendToSheet(token, sheetId, sheetName, value) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${sheetName}!A:A:append?valueInputOption=RAW`;

  const body = {
    values: [[value]],
  };

  return fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

// Worker
export default {
  async fetch(request, env) {
    try {
      const token = await getAccessToken(
        env.GOOGLE_CLIENT_EMAIL,
        env.GOOGLE_PRIVATE_KEY
      );

      const logValue = `Ping → ${new Date().toISOString()} → ${VERSION}`;

      const res = await appendToSheet(
        token,
        env.SHEET_ID,
        env.SHEET_NAME,
        logValue
      );

      if (!res.ok) {
        const txt = await res.text();
        return new Response(
          `Google Sheets error:\n${txt}`,
          { status: 500 }
        );
      }

      return new Response(
        `Hello from cf-hell3-world 👋✨\nBuild: ${VERSION}\nLogged: ${logValue}`,
        { status: 200 }
      );
    } catch (err) {
      return new Response(`Error:\n${err}`, { status: 500 });
    }
  },
};
