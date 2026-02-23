export function speak(text) {
  try {
    if (!("speechSynthesis" in window)) return false;
    const u = new SpeechSynthesisUtterance(String(text || ""));
    // Let browser pick default voice; short incantations only.
    u.rate = 0.95;
    u.pitch = 1.0;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
    return true;
  } catch {
    return false;
  }
}
