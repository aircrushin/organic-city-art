(function () {
  "use strict";

  const LYDIAN_PENTATONIC = [0, 2, 4, 6, 7, 9, 11, 12, 14, 16, 19, 21];

  function createOrganicAudio() {
    let audioCtx = null;
    let masterGain = null;
    let delayNode = null;
    let delayFeedback = null;
    let droneOscA = null;
    let droneOscB = null;
    let droneFilter = null;
    let droneGain = null;
    let enabled = true;
    let unlocked = false;
    let lastGlideNoteTime = 0;

    function ensureContext() {
      if (!enabled) return false;
      if (!audioCtx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return false;
        audioCtx = new Ctx();

        masterGain = audioCtx.createGain();
        masterGain.gain.value = 0.34;

        const compressor = audioCtx.createDynamicsCompressor();
        compressor.threshold.value = -16;
        compressor.ratio.value = 4;

        delayNode = audioCtx.createDelay(1.2);
        delayNode.delayTime.value = 0.28;

        delayFeedback = audioCtx.createGain();
        delayFeedback.gain.value = 0.32;

        const delayFilter = audioCtx.createBiquadFilter();
        delayFilter.type = "lowpass";
        delayFilter.frequency.value = 2200;

        delayNode.connect(delayFilter);
        delayFilter.connect(delayFeedback);
        delayFeedback.connect(delayNode);
        delayFilter.connect(compressor);

        masterGain.connect(compressor);
        masterGain.connect(delayNode);
        compressor.connect(audioCtx.destination);

        droneGain = audioCtx.createGain();
        droneGain.gain.value = 0.0001;

        droneFilter = audioCtx.createBiquadFilter();
        droneFilter.type = "lowpass";
        droneFilter.frequency.value = 340;
        droneFilter.Q.value = 1.4;

        droneOscA = audioCtx.createOscillator();
        droneOscA.type = "sine";
        droneOscA.frequency.value = 110;

        droneOscB = audioCtx.createOscillator();
        droneOscB.type = "triangle";
        droneOscB.frequency.value = 164.81;

        droneOscA.connect(droneFilter);
        droneOscB.connect(droneFilter);
        droneFilter.connect(droneGain);
        droneGain.connect(masterGain);

        droneOscA.start();
        droneOscB.start();
      }

      if (audioCtx.state === "suspended") {
        audioCtx.resume().catch(() => {});
      }
      unlocked = true;
      if (droneGain) {
        const now = audioCtx.currentTime;
        droneGain.gain.setTargetAtTime(enabled ? 0.05 : 0.0001, now, 0.8);
      }
      return true;
    }

    function hueToFrequency(hue, lightness, octaveShift = 0) {
      const normalizedHue = ((hue % 360) + 360) % 360;
      const degreeIndex = Math.floor((normalizedHue / 360) * LYDIAN_PENTATONIC.length);
      const semitone = LYDIAN_PENTATONIC[Math.min(LYDIAN_PENTATONIC.length - 1, degreeIndex)];
      const baseOctave = lightness > 0.62 ? 12 : lightness < 0.28 ? -12 : 0;
      const midiNote = 60 + semitone + baseOctave + octaveShift * 12;
      return 440 * Math.pow(2, (midiNote - 69) / 12);
    }

    function playTone(freq, options = {}) {
      if (!enabled || !unlocked || !audioCtx) return;
      const now = audioCtx.currentTime;
      const duration = options.duration ?? 1.4;
      const volume = options.volume ?? 0.14;
      const pan = options.pan ?? 0;
      const waveform = options.waveform ?? "sine";
      const shimmer = options.shimmer ?? 0.4;

      const osc = audioCtx.createOscillator();
      const overtone = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      const overtoneGain = audioCtx.createGain();
      const filter = audioCtx.createBiquadFilter();

      osc.type = waveform;
      osc.frequency.setValueAtTime(freq, now);
      if (options.glideTo) {
        osc.frequency.exponentialRampToValueAtTime(options.glideTo, now + duration * 0.6);
      }

      overtone.type = "triangle";
      overtone.frequency.setValueAtTime(freq * 2.003, now);
      overtoneGain.gain.setValueAtTime(volume * shimmer * 0.35, now);
      overtoneGain.gain.exponentialRampToValueAtTime(0.0001, now + duration * 0.65);

      filter.type = "lowpass";
      filter.frequency.setValueAtTime(Math.min(7200, freq * (3.2 + shimmer * 3.5)), now);
      filter.frequency.exponentialRampToValueAtTime(Math.max(240, freq * 1.4), now + duration);

      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(volume, now + (options.attack ?? 0.018));
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

      osc.connect(filter);
      overtone.connect(overtoneGain);
      overtoneGain.connect(filter);
      filter.connect(gain);

      if (audioCtx.createStereoPanner) {
        const panner = audioCtx.createStereoPanner();
        panner.pan.setValueAtTime(Math.max(-0.85, Math.min(0.85, pan)), now);
        gain.connect(panner);
        panner.connect(masterGain);
      } else {
        gain.connect(masterGain);
      }

      osc.start(now);
      overtone.start(now);
      osc.stop(now + duration + 0.05);
      overtone.stop(now + duration + 0.05);
    }

    function triggerResonance(sample, normalizedX, modeName) {
      if (!ensureContext()) return;
      const pan = normalizedX * 2 - 1;
      const freq = hueToFrequency(sample.h, sample.l, modeName === "bloom" ? 1 : 0);
      const waveform = modeName === "portal" ? "triangle" : modeName === "liquid" ? "sine" : "sine";
      playTone(freq, {
        duration: modeName === "portal" ? 2.4 : 1.7,
        volume: 0.16,
        pan,
        waveform,
        shimmer: 0.35 + sample.edge * 0.65
      });
      playTone(freq * 1.498, {
        duration: 1.3,
        volume: 0.07,
        pan: -pan * 0.4,
        waveform: "sine",
        attack: 0.06,
        shimmer: 0.5
      });
    }

    function triggerSupernova(sample, normalizedX, power) {
      if (!ensureContext()) return;
      const pan = normalizedX * 2 - 1;
      const base = hueToFrequency(sample.h, sample.l, 0);
      const ratios = [0.5, 1, 1.25, 1.498, 1.875, 2.0, 2.5];
      ratios.forEach((ratio, idx) => {
        window.setTimeout(() => {
          playTone(base * ratio, {
            duration: 1.8 + idx * 0.18,
            volume: Math.min(0.14, (0.06 + power * 0.06) / (1 + idx * 0.16)),
            pan: clampPan(pan + (idx - 3) * 0.18),
            waveform: idx === 0 ? "triangle" : "sine",
            attack: 0.025,
            shimmer: 0.65
          });
        }, idx * 45);
      });
    }

    function triggerEcho(sample, normalizedX) {
      if (!ensureContext()) return;
      const pan = normalizedX * 2 - 1;
      const freq = hueToFrequency(sample.h, sample.l, -1);
      playTone(freq * 1.5, {
        glideTo: freq,
        duration: 1.9,
        volume: 0.14,
        pan,
        waveform: "triangle",
        attack: 0.08,
        shimmer: 0.55
      });
    }

    function clampPan(val) {
      return Math.max(-0.85, Math.min(0.85, val));
    }

    function triggerGlideSpark(sample, normalizedX, speedFactor) {
      if (!enabled || !unlocked || !audioCtx) return;
      const nowMs = performance.now();
      const minGap = Math.max(85, 220 - speedFactor * 95);
      if (nowMs - lastGlideNoteTime < minGap) return;
      lastGlideNoteTime = nowMs;

      const freq = hueToFrequency(sample.h, sample.l, 1);
      playTone(freq, {
        duration: 0.55,
        volume: Math.min(0.065, 0.02 + speedFactor * 0.04),
        pan: normalizedX * 2 - 1,
        waveform: "sine",
        attack: 0.012,
        shimmer: 0.3 + sample.edge * 0.5
      });
    }

    function updateAtmosphere(zoomVelocity, holdAmount, dominantHue) {
      if (!enabled || !unlocked || !audioCtx || !droneFilter || !droneGain) return;
      const now = audioCtx.currentTime;
      const hueRad = (dominantHue * Math.PI) / 180;
      const baseFreq = 98 + Math.sin(hueRad) * 18;
      droneOscA.frequency.setTargetAtTime(baseFreq, now, 0.9);
      droneOscB.frequency.setTargetAtTime(baseFreq * (holdAmount > 0.2 ? 1.334 : 1.498), now, 0.6);
      const cutoff = 260 + Math.min(1400, Math.abs(zoomVelocity) * 600 + holdAmount * 950);
      droneFilter.frequency.setTargetAtTime(cutoff, now, 0.25);
      droneGain.gain.setTargetAtTime(0.042 + holdAmount * 0.045, now, 0.25);
    }

    function setEnabled(nextEnabled) {
      enabled = Boolean(nextEnabled);
      if (audioCtx && masterGain) {
        const now = audioCtx.currentTime;
        masterGain.gain.setTargetAtTime(enabled ? 0.34 : 0.0001, now, 0.12);
        if (droneGain) {
          droneGain.gain.setTargetAtTime(enabled ? 0.045 : 0.0001, now, 0.2);
        }
      }
      if (enabled) {
        ensureContext();
      }
    }

    return {
      unlock: ensureContext,
      isEnabled: () => enabled,
      setEnabled,
      triggerResonance,
      triggerSupernova,
      triggerEcho,
      triggerGlideSpark,
      updateAtmosphere
    };
  }

  window.createOrganicAudio = createOrganicAudio;
})();
