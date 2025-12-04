// Otomatik versiyon artırıldı: +5
const VERSION = "v0.0.0.0.2512041355";

export default {
  async fetch(request, env, ctx) {
    return new Response(
      `Hello from cf-hell3-world 👋\nBuild: ${VERSION}`,
      {
        status: 200,
        headers: { "content-type": "text/plain; charset=UTF-8" },
      }
    );
  },
};
