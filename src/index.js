// Kodun bu versiyonu için sabit versiyon bilgisi:
// Format: v0.0.0.0.YYMMDDHHMM
const VERSION = "v0.0.0.0.2512041350";

export default {
  async fetch(request, env, ctx) {
    const body = [
      "Hello from cf-hell3-world",
      `Build: ${VERSION}`,
    ].join("\n");

    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=UTF-8",
      },
    });
  },
};
