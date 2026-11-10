import { useCallback } from "react";

import { isActiveCapture } from "./voice-control-helpers";
import { tryAcquireVoicePublisherLease } from "./voice-publisher-lease";
import type { VoiceControlState } from "./use-voice-control-state";

/**
 * Lends the microphone to chat dictation; releasing the lease resumes the
 * hardware listener when it was not disabled.
 */
export function useComposerMicrophone(
  state: VoiceControlState,
  tenantId: string,
  enable: (automatic?: boolean) => Promise<void>,
  leavePage: () => Promise<void>,
  cleanupMedia: () => Promise<void>,
) {
  const { refs, setComposerMicrophoneActive, setListenerStatus } = state;

  return useCallback(
    async (options?: { resumeListening?: boolean }) => {
      if (
        refs.composerLeaseRef.current ||
        refs.startPromiseRef.current ||
        refs.enablePromiseRef.current
      )
        throw new Error("Another voice input is using the microphone");
      if (refs.captureRef.current && isActiveCapture(refs.captureRef.current)) {
        throw new Error("Hardware recording is using the microphone");
      }
      // Chat dictation has a separate purpose and must not reuse a hardware
      // session or re-enable its listener when the dictation lease is released.
      if (options?.resumeListening === false) await leavePage();
      if (
        refs.composerLeaseRef.current ||
        refs.startPromiseRef.current ||
        refs.enablePromiseRef.current ||
        (refs.captureRef.current && isActiveCapture(refs.captureRef.current))
      )
        throw new Error("Another voice input is using the microphone");
      if (!refs.publisherLeaseRef.current) {
        const release = await tryAcquireVoicePublisherLease(tenantId);
        if (!release)
          throw new Error("The microphone is active in another tab");
        if (
          refs.composerLeaseRef.current ||
          refs.startPromiseRef.current ||
          refs.enablePromiseRef.current
        ) {
          release();
          throw new Error("Another voice input is using the microphone");
        }
        refs.publisherLeaseRef.current = release;
      }
      refs.composerLeaseRef.current = true;
      setComposerMicrophoneActive(true);
      await cleanupMedia();
      setListenerStatus("composer_recording");
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        refs.composerLeaseRef.current = false;
        setComposerMicrophoneActive(false);
        if (refs.bindingRef.current && !refs.manuallyDisabledRef.current)
          await enable(true);
        else {
          refs.publisherLeaseRef.current?.();
          refs.publisherLeaseRef.current = undefined;
          setListenerStatus("disabled");
        }
      };
    },
    [
      cleanupMedia,
      enable,
      leavePage,
      refs,
      setComposerMicrophoneActive,
      setListenerStatus,
      tenantId,
    ],
  );
}
