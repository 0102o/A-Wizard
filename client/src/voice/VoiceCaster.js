export class VoiceCaster {
  /**
   * @param {(evt: {raw: string, normalized: string}) => void} onPhrase
   * @param {(err: string) => void} onError
   */
  constructor(onPhrase, onError) {
    this.onPhrase = onPhrase;
    this.onError = onError;

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.supported = !!SR;

    this.rec = SR ? new SR() : null;
    this.active = false;

    if (this.rec) {
      this.rec.lang = "en-US";
      this.rec.continuous = true;
      this.rec.interimResults = false;
      this.rec.maxAlternatives = 1;

      this.rec.onresult = (e) => {
        const res = e.results?.[e.results.length - 1];
        const raw = (res?.[0]?.transcript ?? "").trim();
        if (!raw) return;
        const normalized = normalizePhrase(raw);
        this.onPhrase?.({ raw, normalized });
      };

      this.rec.onerror = (e) => {
        this.onError?.(String(e.error || "voice error"));
      };

      this.rec.onend = () => {
        // Auto-restart if user didn't stop explicitly
        if (this.active) {
          try { this.rec.start(); } catch { /* ignore */ }
        }
      };
    }
  }

  start() {
    if (!this.rec) {
      this.onError?.("SpeechRecognition not supported in this browser.");
      return;
    }
    this.active = true;
    try { this.rec.start(); } catch { /* ignore */ }
  }

  stop() {
    if (!this.rec) return;
    this.active = false;
    try { this.rec.stop(); } catch { /* ignore */ }
  }
}

export function normalizePhrase(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
