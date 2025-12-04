// Versiyon formatı: v0.0.0.0.YYMMDDHHMM
function buildVersion() {
  const now = new Date();
  const YY = String(now.getUTCFullYear()).slice(2);
  const MM = String(now.getUTCMonth() + 1).padStart(2, "0");
  const DD = String(now.getUTCDate()).padStart(2, "0");
  const HH = String(now.getUTCHours()).padStart(2, "0");
  const MIN = String(now.getUTCMinutes()).padStart(2, "0");
  return `v0.0.0.0.${YY}${MM}${DD}${HH}${MIN}`;
}

const VERSION = buildVersion();

export default {
  async fetch(request, env, ctx) {
    return new Response(`Hello from cf-hell3-world\nBuild: ${VERSION}`, {
      status: 200,
      headers: { "content-type": "text/plain; charset=UTF-8" },
    });
  },
};
