// Ambient type augmentation for Cloudflare worker bindings
declare namespace Cloudflare {
  interface Env {
    GEMINI_API_KEY: string;
  }
}
