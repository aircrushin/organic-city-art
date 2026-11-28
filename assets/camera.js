(function () {
  "use strict";

  const MEDIAPIPE_SOURCES = [
    {
      moduleUrl: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs",
      wasmBaseUrl: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
    },
    {
      moduleUrl: "https://unpkg.com/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs",
      wasmBaseUrl: "https://unpkg.com/@mediapipe/tasks-vision@0.10.14/wasm"
    }
  ];

  const HAND_MODEL_URLS = [
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"
  ];

  const MOTION_W = 96;
  const MOTION_H = 72;

  function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value;
  }

  function dist2D(pointA, pointB) {
    return Math.hypot(pointA.x - pointB.x, pointA.y - pointB.y);
  }

  function mapReach(value, margin = 0.1) {
    return clamp((value - margin) / (1 - margin * 2), 0, 1);
  }

  function withTimeout(promise, ms) {
    let timerId;
    const timeout = new Promise((_, reject) => {
      timerId = window.setTimeout(() => reject(new Error("Timed out")), ms);
    });
    return Promise.race([promise, timeout]).finally(() => {
      window.clearTimeout(timerId);
    });
  }

  function createHandSlot() {
    return {
      present: false,
      x: 0.5,
      y: 0.5,
      vx: 0,
      vy: 0,
      scale: 0.14,
      prevScale: 0.14,
      isPinch: false,
      isFist: false,
      isOpenPalm: false,
      isPointing: false,
      holding: false,
      holdDuration: 0,
      lastFistAt: 0,
      lastPulseAt: 0,
      lastWaveAt: 0,
      lastSeenAt: 0,
      wasOpen: false
    };
  }

  function analyzeLandmarks(landmarks, previousSlot) {
    const wrist = landmarks[0];
    const thumbTip = landmarks[4];
    const indexMcp = landmarks[5];
    const indexPip = landmarks[6];
    const indexTip = landmarks[8];
    const middleMcp = landmarks[9];
    const middlePip = landmarks[10];
    const middleTip = landmarks[12];
    const ringMcp = landmarks[13];
    const ringPip = landmarks[14];
    const ringTip = landmarks[16];
    const pinkyMcp = landmarks[17];
    const pinkyPip = landmarks[18];
    const pinkyTip = landmarks[20];

    const wristToMid = dist2D(wrist, middleMcp);
    const palmWidth = dist2D(indexMcp, pinkyMcp);
    const handScale = Math.max(0.04, (wristToMid + palmWidth) * 0.5);

    const palmRawX = (wrist.x + indexMcp.x + middleMcp.x + ringMcp.x + pinkyMcp.x) / 5;
    const palmRawY = (wrist.y + indexMcp.y + middleMcp.y + ringMcp.y + pinkyMcp.y) / 5;
    const palmCenter = { x: palmRawX, y: palmRawY };

    const fingers = [
      { tip: indexTip, pip: indexPip, mcp: indexMcp },
      { tip: middleTip, pip: middlePip, mcp: middleMcp },
      { tip: ringTip, pip: ringPip, mcp: ringMcp },
      { tip: pinkyTip, pip: pinkyPip, mcp: pinkyMcp }
    ];

    let extendedCount = 0;
    let curledCount = 0;
    let openSum = 0;
    const extendedFlags = [];

    for (let idx = 0; idx < fingers.length; idx++) {
      const finger = fingers[idx];
      const tipDist = dist2D(finger.tip, wrist);
      const pipDist = dist2D(finger.pip, wrist);
      const mcpDist = dist2D(finger.mcp, wrist);
      const tipPalmDist = dist2D(finger.tip, palmCenter);

      const extended = tipDist > pipDist * 1.1 && tipDist > mcpDist * 1.25;
      const curled = tipDist < pipDist * 1.03 || tipPalmDist < handScale * 0.92;
      if (extended) extendedCount++;
      if (curled) curledCount++;
      extendedFlags.push(extended);
      openSum += clamp((tipDist / Math.max(mcpDist, 0.02) - 0.95) / 0.95, 0, 1);
    }

    const thumbSpread = dist2D(thumbTip, pinkyMcp) / handScale;
    const openScore = clamp((openSum / 4) * 0.8 + clamp((thumbSpread - 0.85) / 1.1, 0, 1) * 0.2, 0, 1);

    const pinchRatio = dist2D(thumbTip, indexTip) / handScale;
    const pinchThreshold = previousSlot && previousSlot.isPinch ? 0.46 : 0.34;
    const isPinch = pinchRatio < pinchThreshold;

    const fistThreshold = previousSlot && previousSlot.isFist ? 0.36 : 0.28;
    const isFist = !isPinch && (curledCount >= 4 || (extendedCount === 0 && openScore < fistThreshold));

    const isOpenPalm = !isPinch && extendedCount >= 4 && openScore > 0.68;
    const isPointing = !isPinch && extendedFlags[0] && !extendedFlags[1] && !extendedFlags[2] && !extendedFlags[3];

    let rawX;
    let rawY;
    if (isPinch) {
      rawX = (thumbTip.x + indexTip.x) * 0.5;
      rawY = (thumbTip.y + indexTip.y) * 0.5;
    } else if (isPointing) {
      rawX = indexTip.x;
      rawY = indexTip.y;
    } else {
      rawX = palmRawX * 0.68 + indexTip.x * 0.32;
      rawY = palmRawY * 0.68 + indexTip.y * 0.32;
    }

    // Mirror horizontally so movement matches user's natural reflection
    const mirroredX = mapReach(1 - rawX, 0.1);
    const mappedY = mapReach(rawY, 0.1);

    return {
      x: mirroredX,
      y: mappedY,
      scale: handScale,
      openScore,
      isPinch,
      isFist,
      isOpenPalm,
      isPointing
    };
  }

  function createCameraGestureController(options = {}) {
    const player = options.player;
    const audio = options.audio || null;
    if (!player) {
      throw new Error("A zoom player instance is required.");
    }

    let running = false;
    let starting = false;
    let permissionDenied = false;
    let awaitingUserGesture = false;
    let trackingMode = "idle"; // "idle" | "motion" | "mediapipe"

    let stream = null;
    let videoEl = null;
    let rafId = null;
    let handLandmarker = null;
    let landmarkerLoading = false;
    let lastVideoTime = -1;
    let lastFrameAt = 0;
    let lastInferenceAt = 0;
    let lastMediaPipeTimestamp = 0;

    const slots = [createHandSlot(), createHandSlot()];
    let prevTwoHandDist = null;
    let wasTwoHandsWide = false;
    let lastClapAt = 0;

    // Local optical-flow / motion fallback state (zero external dependencies)
    const motionCanvas = document.createElement("canvas");
    motionCanvas.width = MOTION_W;
    motionCanvas.height = MOTION_H;
    const motionCtx = motionCanvas.getContext("2d", { willReadFrequently: true });
    let prevLuma = null;
    let motionSmoothX = 0.5;
    let motionSmoothY = 0.5;
    let motionActive = false;
    let motionLastSeenAt = 0;
    let motionPrevSpread = 0;
    let motionLastPulseAt = 0;

    function ensureVideoElement() {
      if (videoEl) return videoEl;
      videoEl = document.createElement("video");
      videoEl.setAttribute("playsinline", "");
      videoEl.setAttribute("muted", "");
      videoEl.setAttribute("autoplay", "");
      videoEl.setAttribute("aria-hidden", "true");
      videoEl.muted = true;
      videoEl.playsInline = true;
      videoEl.autoplay = true;
      videoEl.style.position = "fixed";
      videoEl.style.left = "-9999px";
      videoEl.style.top = "-9999px";
      videoEl.style.width = "1px";
      videoEl.style.height = "1px";
      videoEl.style.opacity = "0";
      videoEl.style.pointerEvents = "none";
      document.body.appendChild(videoEl);
      return videoEl;
    }

    async function loadMediaPipeLandmarker() {
      if (handLandmarker || landmarkerLoading) return handLandmarker;
      landmarkerLoading = true;
      try {
        for (let srcIdx = 0; srcIdx < MEDIAPIPE_SOURCES.length; srcIdx++) {
          const source = MEDIAPIPE_SOURCES[srcIdx];
          try {
            const visionModule = await withTimeout(import(source.moduleUrl), 12000);
            const FilesetResolver = visionModule.FilesetResolver;
            const HandLandmarker = visionModule.HandLandmarker;
            if (!FilesetResolver || !HandLandmarker) continue;

            const filesetResolver = await withTimeout(
              FilesetResolver.forVisionTasks(source.wasmBaseUrl),
              12000
            );

            for (let modelIdx = 0; modelIdx < HAND_MODEL_URLS.length; modelIdx++) {
              const modelUrl = HAND_MODEL_URLS[modelIdx];
              for (const delegate of ["GPU", "CPU"]) {
                try {
                  const detector = await withTimeout(
                    HandLandmarker.createFromOptions(filesetResolver, {
                      baseOptions: {
                        modelAssetPath: modelUrl,
                        delegate
                      },
                      runningMode: "VIDEO",
                      numHands: 2,
                      minHandDetectionConfidence: 0.5,
                      minHandPresenceConfidence: 0.45,
                      minTrackingConfidence: 0.45
                    }),
                    18000
                  );
                  handLandmarker = detector;
                  if (running) {
                    trackingMode = "mediapipe";
                  }
                  return handLandmarker;
                } catch {
                  // Try next delegate or model URL
                }
              }
            }
          } catch {
            // Try next CDN source
          }
        }
      } finally {
        landmarkerLoading = false;
      }
      return null;
    }

    function matchHandsToSlots(detectedHands) {
      if (detectedHands.length === 0) {
        return [null, null];
      }
      if (detectedHands.length === 1) {
        return [detectedHands[0], null];
      }

      const handA = detectedHands[0];
      const handB = detectedHands[1];
      if (slots[0].present && slots[1].present) {
        const costDirect = dist2D(handA, slots[0]) + dist2D(handB, slots[1]);
        const costSwap = dist2D(handA, slots[1]) + dist2D(handB, slots[0]);
        return costDirect <= costSwap ? [handA, handB] : [handB, handA];
      }
      if (slots[0].present) {
        return dist2D(handA, slots[0]) <= dist2D(handB, slots[0]) ? [handA, handB] : [handB, handA];
      }
      return [handA, handB];
    }

    function updateSlotFromDetection(slot, detected, dtSec, now, isPrimary) {
      if (!detected) {
        if (slot.present && now - slot.lastSeenAt > 520) {
          if (slot.holding && slot.holdDuration > 0.34) {
            player.triggerPulse(slot.x, slot.y, true, false);
          }
          slot.present = false;
          slot.holding = false;
          slot.holdDuration = 0;
          slot.isPinch = false;
          slot.isFist = false;
          if (isPrimary) {
            player.releaseHand();
          } else {
            player.updateSecondaryHand({ active: false });
          }
        }
        return;
      }

      const wasPresent = slot.present;
      slot.lastSeenAt = now;

      if (!wasPresent) {
        slot.present = true;
        slot.x = detected.x;
        slot.y = detected.y;
        slot.vx = 0;
        slot.vy = 0;
        slot.scale = detected.scale;
        slot.prevScale = detected.scale;
      } else {
        const rawDist = Math.hypot(detected.x - slot.x, detected.y - slot.y);
        const rawSpeed = rawDist / Math.max(dtSec, 0.008);
        const cutoff = clamp(5.5 + rawSpeed * 18, 5.5, 28);
        const smooth = 1 - Math.exp(-dtSec * cutoff);
        const prevX = slot.x;
        const prevY = slot.y;
        slot.x += (detected.x - slot.x) * smooth;
        slot.y += (detected.y - slot.y) * smooth;
        slot.vx = (slot.x - prevX) / Math.max(dtSec, 0.008);
        slot.vy = (slot.y - prevY) / Math.max(dtSec, 0.008);
        slot.prevScale = slot.scale;
        slot.scale += (detected.scale - slot.scale) * (1 - Math.exp(-dtSec * 8));
      }

      const prevHolding = slot.holding;
      const nextHolding = detected.isPinch || detected.isFist;
      const speedNorm = Math.hypot(slot.vx, slot.vy);

      if (detected.isFist) {
        slot.lastFistAt = now;
      }

      // Entering pinch or fist grab
      if (nextHolding && !prevHolding) {
        slot.holdDuration = 0;
        if (now - slot.lastPulseAt > 280) {
          slot.lastPulseAt = now;
          if (audio) audio.unlock();
          player.triggerPulse(slot.x, slot.y, false, false);
        }
      } else if (nextHolding) {
        slot.holdDuration += dtSec;
      } else if (!nextHolding && prevHolding) {
        // Releasing pinch or fist after charging -> Supernova bloom
        if (slot.holdDuration > 0.34 && now - slot.lastPulseAt > 240) {
          slot.lastPulseAt = now;
          if (audio) audio.unlock();
          player.triggerPulse(slot.x, slot.y, true, false);
        }
        slot.holdDuration = 0;
      }

      // Expressive flower-bloom gesture: closed fist opening sharply into wide open palm
      if (
        detected.isOpenPalm &&
        !slot.wasOpen &&
        now - slot.lastFistAt < 520 &&
        now - slot.lastPulseAt > 360
      ) {
        slot.lastPulseAt = now;
        if (audio) audio.unlock();
        player.triggerPulse(slot.x, slot.y, true, false);
      }

      // Energetic hand wave / sweep -> shimmering bloom ripple + gentle zoom momentum
      if (speedNorm > 1.25 && !nextHolding && now - slot.lastWaveAt > 420 && now - slot.lastPulseAt > 260) {
        slot.lastWaveAt = now;
        slot.lastPulseAt = now;
        if (audio) audio.unlock();
        player.triggerPulse(slot.x, slot.y, false, false);
        player.nudge(clamp(speedNorm * 38, 30, 140));
      }

      slot.isPinch = detected.isPinch;
      slot.isFist = detected.isFist;
      slot.isOpenPalm = detected.isOpenPalm;
      slot.isPointing = detected.isPointing;
      slot.wasOpen = detected.isOpenPalm;
      slot.holding = nextHolding;

      if (isPrimary) {
        player.updateHandPointer({
          x: slot.x,
          y: slot.y,
          holding: slot.holding,
          speedNorm
        });
      } else {
        player.updateSecondaryHand({
          active: true,
          x: slot.x,
          y: slot.y,
          holding: slot.holding,
          speedNorm
        });
      }
    }

    function processMediaPipeFrame(dtSec, now) {
      if (!handLandmarker || !videoEl || videoEl.readyState < 2 || videoEl.videoWidth === 0) {
        return;
      }

      let result;
      try {
        const timestampMs = Math.max(now, lastMediaPipeTimestamp + 1);
        lastMediaPipeTimestamp = timestampMs;
        result = handLandmarker.detectForVideo(videoEl, timestampMs);
      } catch {
        return;
      }

      const landmarksList = (result && result.landmarks) || [];
      const preliminary = [];
      for (let idx = 0; idx < Math.min(landmarksList.length, 2); idx++) {
        preliminary.push(analyzeLandmarks(landmarksList[idx], slots[idx]));
      }

      const matched = matchHandsToSlots(preliminary);
      updateSlotFromDetection(slots[0], matched[0], dtSec, now, true);
      updateSlotFromDetection(slots[1], matched[1], dtSec, now, false);

      // Two-hand spread / gather controls zoom warp & clap triggers reverse echo
      if (matched[0] && matched[1] && slots[0].present && slots[1].present) {
        const twoHandDist = Math.hypot(slots[0].x - slots[1].x, slots[0].y - slots[1].y);
        if (twoHandDist > 0.28) {
          wasTwoHandsWide = true;
        }

        if (prevTwoHandDist !== null) {
          const distDelta = twoHandDist - prevTwoHandDist;
          if (Math.abs(distDelta) > 0.0045) {
            player.nudge(clamp(distDelta * 2500, -340, 340));
          }
        }
        prevTwoHandDist = twoHandDist;

        if (wasTwoHandsWide && twoHandDist < 0.14 && now - lastClapAt > 780) {
          wasTwoHandsWide = false;
          lastClapAt = now;
          const midX = (slots[0].x + slots[1].x) * 0.5;
          const midY = (slots[0].y + slots[1].y) * 0.5;
          if (audio) audio.unlock();
          player.triggerPulse(midX, midY, false, true);
          player.nudge(-240);
        }
      } else {
        prevTwoHandDist = null;
        wasTwoHandsWide = false;

        // Single open-palm depth push/pull gently modulates infinite zoom
        if (matched[0] && slots[0].isOpenPalm && Math.hypot(slots[0].vx, slots[0].vy) < 0.7) {
          const scaleDelta = slots[0].scale - slots[0].prevScale;
          if (Math.abs(scaleDelta) > 0.0038) {
            player.nudge(clamp(scaleDelta * 1850, -180, 180));
          }
        }
      }
    }

    function processMotionFallbackFrame(dtSec, now) {
      if (!motionCtx || !videoEl || videoEl.readyState < 2 || videoEl.videoWidth === 0) {
        return;
      }

      motionCtx.save();
      motionCtx.scale(-1, 1);
      motionCtx.drawImage(videoEl, -MOTION_W, 0, MOTION_W, MOTION_H);
      motionCtx.restore();

      const frameData = motionCtx.getImageData(0, 0, MOTION_W, MOTION_H).data;
      const pixelCount = MOTION_W * MOTION_H;
      if (!prevLuma || prevLuma.length !== pixelCount) {
        prevLuma = new Uint8Array(pixelCount);
        for (let idx = 0; idx < pixelCount; idx++) {
          const offset = idx * 4;
          prevLuma[idx] = (frameData[offset] * 77 + frameData[offset + 1] * 150 + frameData[offset + 2] * 29) >> 8;
        }
        return;
      }

      let weightSum = 0;
      let sumX = 0;
      let sumY = 0;
      let sumX2 = 0;
      let sumY2 = 0;
      let activePixels = 0;

      for (let y = 0; y < MOTION_H; y++) {
        for (let x = 0; x < MOTION_W; x++) {
          const idx = y * MOTION_W + x;
          const offset = idx * 4;
          const r = frameData[offset];
          const g = frameData[offset + 1];
          const b = frameData[offset + 2];
          const luma = (r * 77 + g * 150 + b * 29) >> 8;
          const diff = Math.abs(luma - prevLuma[idx]);
          prevLuma[idx] = (prevLuma[idx] * 3 + luma) >> 2;

          if (diff > 20) {
            const skinBoost = r > 70 && r > g && g > b && r - b > 18 ? 1.65 : 1.0;
            const weight = (diff - 18) * skinBoost;
            const nx = x / MOTION_W;
            const ny = y / MOTION_H;
            weightSum += weight;
            sumX += nx * weight;
            sumY += ny * weight;
            sumX2 += nx * nx * weight;
            sumY2 += ny * ny * weight;
            activePixels++;
          }
        }
      }

      const energy = activePixels / pixelCount;
      if (energy > 0.008 && weightSum > 0) {
        const rawX = mapReach(sumX / weightSum, 0.08);
        const rawY = mapReach(sumY / weightSum, 0.08);
        const varX = Math.max(0, sumX2 / weightSum - (sumX / weightSum) * (sumX / weightSum));
        const varY = Math.max(0, sumY2 / weightSum - (sumY / weightSum) * (sumY / weightSum));
        const spread = Math.sqrt(varX + varY);

        const prevX = motionSmoothX;
        const prevY = motionSmoothY;
        if (!motionActive) {
          motionSmoothX = rawX;
          motionSmoothY = rawY;
          motionPrevSpread = spread;
          motionActive = true;
        } else {
          const smooth = 1 - Math.exp(-dtSec * 9.5);
          motionSmoothX += (rawX - motionSmoothX) * smooth;
          motionSmoothY += (rawY - motionSmoothY) * smooth;
        }

        const speedNorm = Math.hypot(motionSmoothX - prevX, motionSmoothY - prevY) / Math.max(dtSec, 0.01);
        motionLastSeenAt = now;

        player.updateHandPointer({
          x: motionSmoothX,
          y: motionSmoothY,
          holding: false,
          speedNorm
        });

        if ((energy > 0.085 || speedNorm > 1.35) && now - motionLastPulseAt > 520) {
          motionLastPulseAt = now;
          if (audio) audio.unlock();
          player.triggerPulse(motionSmoothX, motionSmoothY, energy > 0.19, false);
        }

        const spreadDelta = spread - motionPrevSpread;
        motionPrevSpread += spreadDelta * (1 - Math.exp(-dtSec * 6));
        if (Math.abs(spreadDelta) > 0.032) {
          player.nudge(clamp(spreadDelta * 1400, -180, 180));
        }
      } else if (motionActive && now - motionLastSeenAt > 1100) {
        motionActive = false;
        player.releaseHand();
      }
    }

    function tick(now) {
      if (!running) return;
      rafId = window.requestAnimationFrame(tick);

      if (document.hidden || !videoEl || videoEl.readyState < 2) {
        return;
      }

      // Throttle vision processing to ~30fps so WebGL 60fps stays silky smooth
      if (now - lastInferenceAt < 30) {
        return;
      }
      if (videoEl.currentTime === lastVideoTime) {
        return;
      }
      lastVideoTime = videoEl.currentTime;

      const dtSec = lastFrameAt ? clamp((now - lastFrameAt) / 1000, 0.008, 0.12) : 0.033;
      lastFrameAt = now;
      lastInferenceAt = now;

      if (trackingMode === "mediapipe" && handLandmarker) {
        processMediaPipeFrame(dtSec, now);
      } else {
        processMotionFallbackFrame(dtSec, now);
      }
    }

    async function start() {
      if (running || starting || permissionDenied) return false;
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        return false;
      }
      starting = true;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: "user",
            width: { ideal: 640 },
            height: { ideal: 480 },
            frameRate: { ideal: 30 }
          },
          audio: false
        });
        const video = ensureVideoElement();
        video.srcObject = stream;
        await video.play().catch(() => {});

        running = true;
        awaitingUserGesture = false;
        lastVideoTime = -1;
        lastFrameAt = 0;
        lastInferenceAt = 0;
        prevLuma = null;
        trackingMode = handLandmarker ? "mediapipe" : "motion";

        rafId = window.requestAnimationFrame(tick);

        if (!handLandmarker) {
          loadMediaPipeLandmarker();
        }
        return true;
      } catch (err) {
        const name = err && err.name ? err.name : "";
        if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "NotFoundError" || name === "DevicesNotFoundError") {
          permissionDenied = true;
          awaitingUserGesture = false;
        } else {
          awaitingUserGesture = true;
        }
        return false;
      } finally {
        starting = false;
      }
    }

    function stop() {
      running = false;
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
        stream = null;
      }
      if (videoEl) {
        videoEl.srcObject = null;
      }
      trackingMode = "idle";
      slots[0].present = false;
      slots[0].holding = false;
      slots[1].present = false;
      slots[1].holding = false;
      motionActive = false;
      prevTwoHandDist = null;
      player.releaseHand();
      player.updateSecondaryHand({ active: false });
    }

    async function toggle() {
      if (running) {
        stop();
        return false;
      }
      permissionDenied = false;
      return start();
    }

    function onUserGesture() {
      if (awaitingUserGesture && !running && !starting && !permissionDenied) {
        start();
      }
    }

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && running) {
        lastFrameAt = 0;
        lastInferenceAt = 0;
      }
    });

    window.addEventListener("beforeunload", stop);

    return {
      start,
      stop,
      toggle,
      onUserGesture,
      getState: () => ({
        running,
        trackingMode,
        handsDetected: (slots[0].present ? 1 : 0) + (slots[1].present ? 1 : 0)
      })
    };
  }

  window.createCameraGestureController = createCameraGestureController;
})();
