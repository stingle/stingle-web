import { ready } from "./crypto/sodium";
import { nativeVideoPlaybackProbe, rangeRoundTrip } from "./media-test-harness";
import { registerSW } from "virtual:pwa-register";

const status = document.querySelector<HTMLParagraphElement>("#test-status");
const runValidation = document.querySelector<HTMLButtonElement>("#run-validation");
const validationResult = document.querySelector<HTMLPreElement>("#validation-result");

registerSW({ immediate: true });

declare global {
  interface Window {
    mediaTest: {
      rangeRoundTrip: typeof rangeRoundTrip;
      nativeVideoPlaybackProbe: typeof nativeVideoPlaybackProbe;
    };
  }
}

window.mediaTest = { rangeRoundTrip, nativeVideoPlaybackProbe };

void Promise.all([ready(), navigator.serviceWorker.ready]).then(() => {
  if (status) status.textContent = "Media test crypto runtime ready.";
  if (runValidation) runValidation.disabled = false;
  document.documentElement.dataset.cryptoReady = "true";
});

runValidation?.addEventListener("click", () => {
  runValidation.disabled = true;
  if (validationResult) validationResult.textContent = "Testing authenticated rangesâ€¦";
  void (async () => {
    try {
      const rangePassed = await rangeRoundTrip();
      if (validationResult) validationResult.textContent = "Testing native video playback and seekingâ€¦";
      const video = await nativeVideoPlaybackProbe();
      const passed = rangePassed && video.played && video.seeked;
      if (validationResult) {
        validationResult.textContent = JSON.stringify(
          { passed, userAgent: navigator.userAgent, authenticatedMultiChunkRange: rangePassed, video },
          null,
          2,
        );
      }
    } catch (error) {
      if (validationResult) {
        validationResult.textContent = JSON.stringify(
          {
            passed: false,
            userAgent: navigator.userAgent,
            error: error instanceof Error ? error.message : String(error),
          },
          null,
          2,
        );
      }
    } finally {
      runValidation.disabled = false;
    }
  })();
});


